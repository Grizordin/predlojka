import fs from 'node:fs/promises';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as cheerio from 'cheerio';


// ===== src/config.js =====
const config = {
  port: Number(process.env.PORT || 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  anime: {
    baseUrl: process.env.ANIMESSS_BASE_URL || 'https://animesss.tv',
    cookie: process.env.ANIMESSS_COOKIE || '',
    login: process.env.ANIMESSS_LOGIN || '',
    password: process.env.ANIMESSS_PASSWORD || '',
    loginUrl: process.env.ANIMESSS_LOGIN_URL || 'https://animesss.tv/index.php',
    loginField: process.env.ANIMESSS_LOGIN_FIELD || 'login_name',
    passwordField: process.env.ANIMESSS_PASSWORD_FIELD || 'login_password',
    submitField: process.env.ANIMESSS_LOGIN_SUBMIT_FIELD || 'login',
    submitValue: process.env.ANIMESSS_LOGIN_SUBMIT_VALUE || 'submit',
    requestDelayMs: Number(process.env.ANIMESSS_REQUEST_DELAY_MS || 550)
  },
  cloudflare: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID || '',
    apiToken: process.env.CLOUDFLARE_API_TOKEN || ''
  },
  adminToken: process.env.ADMIN_TOKEN || '',
  tickBudgetMs: Number(process.env.TICK_BUDGET_MS || 35000),
  cardsMonitorIntervalMs: Number(process.env.CARDS_MONITOR_INTERVAL_MS || 60000),
  inactiveScanIntervalMs: Number(process.env.INACTIVE_SCAN_INTERVAL_MS || 86400000),
  suggestionRatedIntervalMs: Number(process.env.SUGGESTION_RATED_INTERVAL_MS || 600000),
  suggestionZeroIntervalMs: Number(process.env.SUGGESTION_ZERO_INTERVAL_MS || 1800000),
  suggestionDecayDays: Number(process.env.SUGGESTION_DECAY_DAYS || 7),
  runtimeCheckpointIntervalMs: Number(process.env.RUNTIME_CHECKPOINT_INTERVAL_MS || 300000),
  logRetentionDays: Number(process.env.LOG_RETENTION_DAYS || 7),
  runtimeLogLimit: Number(process.env.RUNTIME_LOG_LIMIT || 500)
};

function requireAdmin(request, reply) {
  if (!config.adminToken) return;
  const token = request.headers['x-admin-token'] || request.query?.adminToken;
  if (token !== config.adminToken) {
    reply.code(401).send({ ok: false, error: 'admin token required' });
  }
}

// ===== src/util.js =====
function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normAuthor(author) {
  return String(author || '').trim();
}

function authorKey(author) {
  return normAuthor(author).toLocaleLowerCase('ru');
}

function absoluteUrl(baseUrl, value) {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return String(value || '');
  }
}

function imagePath(baseUrl, value) {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).pathname;
  } catch {
    return String(value || '').split('?')[0];
  }
}

function imageFileName(baseUrl, value) {
  return imagePath(baseUrl, value).split('/').filter(Boolean).pop() || '';
}

function taskKey(type, cardId, image = '') {
  if (type === 'replacement') return `${cardId}|${imagePath('https://animesss.tv', image)}`;
  return String(cardId || '');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ===== src/d1.js =====
function assertD1Config() {
  const missing = [];
  if (!config.cloudflare.accountId) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (!config.cloudflare.databaseId) missing.push('CLOUDFLARE_D1_DATABASE_ID');
  if (!config.cloudflare.apiToken) missing.push('CLOUDFLARE_API_TOKEN');
  if (missing.length) {
    throw new Error('Missing Cloudflare D1 env: ' + missing.join(', '));
  }
}

class D1Client {
  constructor() {
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.accountId}/d1/database/${config.cloudflare.databaseId}/query`;
  }

  async query(sql, params = []) {
    assertD1Config();
    const response = await fetchWithTimeout(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.cloudflare.apiToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ sql, params })
    }, 15000);
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.success) {
      throw new Error(`D1 query failed ${response.status}: ${JSON.stringify(json)}`);
    }
    return json.result?.[0]?.results || [];
  }

  async exec(sql) {
    const statements = sql
      .split(/;\s*(?:\r?\n|$)/)
      .map(x => x.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await this.query(statement);
    }
  }
}

const d1 = new D1Client();

// ===== src/animesss.js =====
const REQUEST_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

function readSetCookie(headers) {
  const direct = headers.getSetCookie?.();
  if (Array.isArray(direct) && direct.length) return direct;

  const raw = headers.get('set-cookie');
  if (!raw) return [];
  return raw.split(/,(?=[^;,]+=)/);
}

function cookiePairsFromSetCookie(setCookieHeaders = []) {
  return setCookieHeaders
    .map(cookie => cookie.split(';')[0]?.trim())
    .filter(Boolean);
}

function mergeCookieHeaders(...cookieHeaders) {
  const cookies = new Map();

  for (const header of cookieHeaders) {
    if (!header) continue;
    const parts = Array.isArray(header) ? header : String(header).split(';');
    for (const part of parts) {
      const cookie = String(part).trim();
      const eqIndex = cookie.indexOf('=');
      if (eqIndex <= 0) continue;
      cookies.set(cookie.slice(0, eqIndex), cookie.slice(eqIndex + 1));
    }
  }

  return [...cookies.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function looksLikeLoginPage(html) {
  return html.includes('Регистрация посетителя')
    || html.includes('Авторизация')
    || html.includes('Для просмотра данной страницы нужно авторизоваться')
    || html.includes('Р РµРіРёСЃС‚СЂР°С†РёСЏ РїРѕСЃРµС‚РёС‚РµР»СЏ')
    || html.includes('РђРІС‚РѕСЂРёР·Р°С†РёСЏ')
    || html.includes('Р”Р»СЏ РїСЂРѕСЃРјРѕС‚СЂР°')
    || (html.includes('login_name') && html.includes('login_password') && !html.includes('/index.php?action=logout'));
}

class AnimeSSSClient {
  constructor() {
    this.baseUrl = config.anime.baseUrl.replace(/\/+$/, '');
    this.staticCookie = config.anime.cookie || '';
    this.cookieByOrigin = new Map();
    this.nextRequestAt = 0;
    this.origins = this.makeOrigins();
  }

  makeOrigins() {
    const origins = [this.baseUrl];
    for (const origin of ['https://animesss.tv', 'https://animesss.com']) {
      if (!origins.includes(origin)) origins.push(origin);
    }
    return origins;
  }

  profileUrl(author) {
    return `${this.baseUrl}/user/${encodeURIComponent(author)}/`;
  }

  createdCountUrl(author) {
    return `${this.profileUrl(author)}cards_created/`;
  }

  createdModerationUrl(author) {
    return `${this.profileUrl(author)}cards_created/?moderation=1`;
  }

  replacementPendingUrl(author) {
    return `${this.profileUrl(author)}cards_replacements/?status=pending`;
  }

  cardsUrl() {
    return `${this.baseUrl}/cards/`;
  }

  async waitSlot() {
    const wait = Math.max(0, this.nextRequestAt - Date.now());
    if (wait) await sleep(wait);
    this.nextRequestAt = Date.now() + config.anime.requestDelayMs;
  }

  pathFromUrl(urlOrPath) {
    if (urlOrPath.startsWith('/')) return urlOrPath;
    const url = new URL(urlOrPath);
    return `${url.pathname}${url.search}`;
  }

  preferredOrigins(urlOrPath) {
    if (urlOrPath.startsWith('/')) return this.origins;

    const url = new URL(urlOrPath);
    const requested = url.origin;
    return [
      requested,
      ...this.origins.filter(origin => origin !== requested)
    ];
  }

  hasLoginCredentials() {
    return Boolean(config.anime.login && config.anime.password);
  }

  async loginToOrigin(origin) {
    if (this.staticCookie) return this.staticCookie;

    const cachedCookie = this.cookieByOrigin.get(origin);
    if (cachedCookie) return cachedCookie;

    if (!this.hasLoginCredentials()) {
      throw new Error('AnimeSSS auth is not configured. Set ANIMESSS_LOGIN/ANIMESSS_PASSWORD or ANIMESSS_COOKIE.');
    }

    const loginUrl = `${origin}/`;

    await this.waitSlot();
    const initialResponse = await fetchWithTimeout(loginUrl, {
      headers: REQUEST_HEADERS,
      redirect: 'manual'
    }, 15000);
    const initialCookie = mergeCookieHeaders(cookiePairsFromSetCookie(readSetCookie(initialResponse.headers)));

    const body = new URLSearchParams({
      [config.anime.loginField]: config.anime.login,
      [config.anime.passwordField]: config.anime.password
    });
    if (config.anime.submitField) {
      body.set(config.anime.submitField, config.anime.submitValue);
    }

    await this.waitSlot();
    const loginResponse = await fetchWithTimeout(loginUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...REQUEST_HEADERS,
        'content-type': 'application/x-www-form-urlencoded',
        origin,
        referer: loginUrl,
        ...(initialCookie ? { cookie: initialCookie } : {})
      },
      body: body.toString()
    }, 15000);

    const loginCookie = mergeCookieHeaders(cookiePairsFromSetCookie(readSetCookie(loginResponse.headers)));
    const cookie = mergeCookieHeaders(initialCookie, loginCookie);
    if (!cookie) {
      throw new Error(`site did not return cookie after login, status ${loginResponse.status}`);
    }

    this.cookieByOrigin.set(origin, cookie);
    return cookie;
  }

  async fetchFromOrigin(origin, path) {
    const cookie = await this.loginToOrigin(origin);

    await this.waitSlot();
    const response = await fetchWithTimeout(`${origin}${path}`, {
      headers: {
        ...REQUEST_HEADERS,
        accept: 'text/html,application/xhtml+xml',
        ...(cookie ? { cookie } : {})
      }
    }, 15000);

    const nextCookie = mergeCookieHeaders(cookie, cookiePairsFromSetCookie(readSetCookie(response.headers)));
    if (nextCookie) this.cookieByOrigin.set(origin, nextCookie);

    const html = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (looksLikeLoginPage(html)) {
      this.cookieByOrigin.delete(origin);
      throw new Error('site returned login page after auth');
    }
    return html;
  }

  async fetchHtml(urlOrPath) {
    const path = this.pathFromUrl(urlOrPath);
    const errors = [];

    for (const origin of this.preferredOrigins(urlOrPath)) {
      try {
        return await this.fetchFromOrigin(origin, path);
      } catch (error) {
        this.cookieByOrigin.delete(origin);
        errors.push(`${origin}${path}: ${error.message}`);
        console.warn(`[AnimeSSS] not available: ${origin}${path} - ${error.message}`);
      }
    }

    throw new Error(`both AnimeSSS domains are unavailable: ${errors.join(' | ')}`);
  }
}

const anime = new AnimeSSSClient();

// ===== src/parser.js =====
function cardFromNode($, node, baseUrl, sourceAuthor = '') {
  const el = $(node);
  const img = el.find('img').first();
  const image = imagePath(baseUrl, el.attr('data-image') || img.attr('data-src') || img.attr('src') || '');
  return {
    cardId: String(el.attr('data-id') || ''),
    name: String(el.attr('data-name') || ''),
    rank: String(el.attr('data-rank') || '').toLowerCase(),
    animeName: String(el.attr('data-anime-name') || ''),
    animeLink: absoluteUrl(baseUrl, el.attr('data-anime-link') || ''),
    author: normAuthor(el.attr('data-author') || sourceAuthor),
    image,
    imageUrl: absoluteUrl(baseUrl, image),
    imageName: imageFileName(baseUrl, image)
  };
}

function parseCreatedModerationCards(html, baseUrl, sourceAuthor = '') {
  const $ = cheerio.load(html || '');
  return $('.anime-cards__item[data-id]').toArray()
    .map(node => cardFromNode($, node, baseUrl, sourceAuthor))
    .filter(card => card.cardId && card.image);
}

function parseCreatedCount(html) {
  const $ = cheerio.load(html || '');
  const text = $('.ncard__main-title, h1').toArray()
    .map(node => $(node).text())
    .find(value => /Карточки\s+созданные\s+пользователем|РљР°СЂС‚РѕС‡РєРё\s+СЃРѕР·РґР°РЅРЅС‹Рµ/i.test(value)) || $.text();
  const match = String(text || '').match(/\(([\d\s]+)\s*(?:шт\.|С€С‚\.)\)/i);
  return match ? Number(match[1].replace(/\s+/g, '')) : 0;
}

function parseProfileOnlineText(html) {
  const $ = cheerio.load(html || '');
  const line = $('.usn__info-line').toArray()
    .map(node => $(node).text().replace(/\s+/g, ' ').trim())
    .find(text => /^В сети:|^Р’\s+СЃРµС‚Рё:/i.test(text));
  return line || '';
}

function isMoreThanMonthOffline(onlineText) {
  const text = String(onlineText || '').toLowerCase();
  if (!text) return false;
  if (/год|лет|РіРѕРґ|Р»РµС‚/.test(text)) return true;
  if (/месяц|РјРµСЃСЏС†/.test(text)) return true;
  return false;
}

function parseCardsPage(html, baseUrl) {
  const $ = cheerio.load(html || '');
  return {
    addedCards: parseAddedCards($, baseUrl),
    replacements: parseReplacementVotes($, baseUrl),
    visibleAuthors: parseVisibleCatalogAuthors($),
    addedDebug: parseAddedCardsDebug($)
  };
}

function parseAddedCards($, baseUrl) {
  const cards = [];
  const seen = new Set();
  $('.anime-cards__item-wrapper-gl,.anime-cards__item-wrapper').each((_, wrapperNode) => {
    const wrapper = $(wrapperNode);
    if (wrapper.closest('.cards-replace-vote-list,.card-replace-vote').length) return;
    if (!wrapper.find('.card-votes').length) return;
    if (wrapper.find('.card-votes__btn[data-kind="1"],.card-votes button[data-kind="1"]').length) return;
    if (!wrapper.find('.card-votes__btn[data-kind="0"],.card-votes button[data-kind="0"]').length) return;
    const cardNode = wrapper.find('.anime-cards__item[data-id]').first();
    const card = cardNode.length ? cardFromNode($, cardNode[0], baseUrl) : null;
    if (!card?.cardId || !card.image || seen.has(card.cardId)) return;
    seen.add(card.cardId);
    cards.push(card);
  });
  return cards;
}

function parseAddedCardsDebug($) {
  const voteBlocks = $('.anime-cards-center.anime-cards--full-page')
    .filter((_, section) => $(section).find('.card-votes').length > 0 && $(section).find('.card-replace-vote').length === 0)
    .length;
  const voteWrappers = $('.anime-cards__item-wrapper-gl,.anime-cards__item-wrapper')
    .filter((_, wrapperNode) => {
      const wrapper = $(wrapperNode);
      if (wrapper.closest('.cards-replace-vote-list,.card-replace-vote').length) return false;
      if (!wrapper.find('.card-votes').length) return false;
      if (wrapper.find('.card-votes__btn[data-kind="1"],.card-votes button[data-kind="1"]').length) return false;
      return wrapper.find('.card-votes__btn[data-kind="0"],.card-votes button[data-kind="0"]').length > 0;
    })
    .length;
  const firstIds = $('.anime-cards__item-wrapper-gl,.anime-cards__item-wrapper')
    .filter((_, wrapperNode) => {
      const wrapper = $(wrapperNode);
      if (wrapper.closest('.cards-replace-vote-list,.card-replace-vote').length) return false;
      if (!wrapper.find('.card-votes').length) return false;
      return wrapper.find('.card-votes__btn[data-kind="0"],.card-votes button[data-kind="0"]').length > 0;
    })
    .find('.anime-cards__item[data-id]')
    .toArray()
    .slice(0, 10)
    .map(node => String($(node).attr('data-id') || ''))
    .filter(Boolean);
  return { voteBlocks, voteWrappers, firstIds };
}

function parseReplacementVotes($, baseUrl) {
  return $('.card-replace-vote').toArray().map(node => {
    const item = $(node);
    const cards = item.find('.anime-cards__item[data-id]').toArray();
    const oldCard = cards[0] ? cardFromNode($, cards[0], baseUrl) : null;
    const newCard = cards[1] ? cardFromNode($, cards[1], baseUrl) : oldCard;
    if (!oldCard?.cardId || !newCard?.image) return null;
    return {
      cardId: oldCard.cardId,
      name: newCard.name || oldCard.name,
      rank: newCard.rank || oldCard.rank,
      animeName: newCard.animeName || oldCard.animeName,
      animeLink: newCard.animeLink || oldCard.animeLink,
      oldImage: oldCard.image,
      oldImageUrl: oldCard.imageUrl,
      newImage: newCard.image,
      newImageUrl: newCard.imageUrl,
      imageName: newCard.imageName
    };
  }).filter(Boolean);
}

function parseVisibleCatalogAuthors($) {
  const authors = new Set();
  $('.anime-cards__item[data-id][data-author]').each((_, node) => {
    const item = $(node);
    if (item.closest('.cards-replace-vote-list,.card-replace-vote,[data-suite-vote-block="1"]').length) return;
    const wrapper = item.closest('.anime-cards__item-wrapper,.anime-cards__item-wrapper-gl');
    if (wrapper.find('.card-votes').length) return;
    const author = normAuthor(item.attr('data-author'));
    if (author) authors.add(author);
  });
  return [...authors];
}

function parseReplacementPage(html, baseUrl) {
  const $ = cheerio.load(html || '');
  const byId = new Map();
  $('.card-replacement[data-id]').each((_, node) => {
    const item = $(node);
    const cardId = String(item.attr('data-id') || '');
    const image = imagePath(
      baseUrl,
      item.attr('data-image') ||
      item.find('.card-replacement__card--new img').attr('data-src') ||
      item.find('.card-replacement__card--new img').attr('src') ||
      ''
    );
    if (!cardId || !image) return;
    if (!byId.has(cardId)) byId.set(cardId, new Set());
    byId.get(cardId).add(image);
  });
  return byId;
}

// ===== src/db.js =====
const runtime = {
  loaded: false,
  loading: null,
  authors: new Map(),
  cards: new Map(),
  suggestions: new Map(),
  suggestionsByAuthor: new Map(),
  tasks: new Map(),
  logs: [],
  dirtyTaskKeys: new Set(),
  checkpointDirty: false,
  checkpointVersion: 0,
  lastCheckpointAt: 0,
  lastLogCleanupAt: 0
};

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function chunks(items, size = 50) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function sameFields(left, right, fields) {
  return fields.every(field => (left?.[field] ?? null) === (right?.[field] ?? null));
}

function runtimeStats() {
  return {
    loaded: runtime.loaded,
    authors: runtime.authors.size,
    cards: runtime.cards.size,
    suggestions: runtime.suggestions.size,
    tasks: runtime.tasks.size,
    dirtyTasks: runtime.dirtyTaskKeys.size,
    lastCheckpointAt: runtime.lastCheckpointAt
  };
}

function addSuggestionToAuthorIndex(row) {
  const key = authorKey(row.author);
  if (!key) return;
  if (!runtime.suggestionsByAuthor.has(key)) runtime.suggestionsByAuthor.set(key, new Set());
  runtime.suggestionsByAuthor.get(key).add(String(row.card_id));
}

function hydrateRuntime(authors, cards, suggestions, tasks, checkpointRows, logs) {
  runtime.authors.clear();
  runtime.cards.clear();
  runtime.suggestions.clear();
  runtime.suggestionsByAuthor.clear();
  runtime.tasks.clear();
  runtime.dirtyTaskKeys.clear();
  runtime.checkpointDirty = false;
  runtime.checkpointVersion = 0;

  for (const row of authors) runtime.authors.set(row.author_key, { ...row });
  for (const row of cards) runtime.cards.set(String(row.card_id), { ...row });
  for (const row of suggestions) {
    const normalized = { ...row, card_id: String(row.card_id) };
    runtime.suggestions.set(normalized.card_id, normalized);
    addSuggestionToAuthorIndex(normalized);
  }
  for (const row of tasks) runtime.tasks.set(row.task_key, { ...row });

  try {
    const checkpoint = JSON.parse(checkpointRows[0]?.value || '{}');
    for (const item of checkpoint.authors || []) {
      const row = runtime.authors.get(item[0]);
      if (!row) continue;
      row.last_suggestion_checked_at = numberValue(item[1], row.last_suggestion_checked_at);
      row.last_profile_checked_at = numberValue(item[2], row.last_profile_checked_at);
    }
    runtime.lastCheckpointAt = numberValue(checkpointRows[0]?.updated_at);
  } catch (error) {
    console.warn('[runtime-cache] ignored invalid checkpoint:', error.message);
  }

  runtime.logs = logs.map(row => ({ ...row })).slice(0, config.runtimeLogLimit);
  runtime.loaded = true;
  console.log(
    `[runtime-cache] loaded ${runtime.authors.size} authors, ${runtime.cards.size} cards, ` +
    `${runtime.suggestions.size} suggestions, ${runtime.tasks.size} tasks`
  );
}

async function ensureRuntimeState() {
  if (runtime.loaded) return;
  if (runtime.loading) return runtime.loading;
  runtime.loading = (async () => {
    const [authors, cards, suggestions, tasks, checkpointRows, logs] = await Promise.all([
      d1.query('SELECT * FROM authors'),
      d1.query('SELECT * FROM cards'),
      d1.query('SELECT * FROM suggestions'),
      d1.query('SELECT * FROM tasks'),
      d1.query("SELECT value, updated_at FROM settings WHERE key = 'runtime_checkpoint_v1'"),
      d1.query(
        `SELECT level, scope, message, data_json, created_at
         FROM logs ORDER BY created_at DESC LIMIT ?`,
        [config.runtimeLogLimit]
      )
    ]);
    hydrateRuntime(authors, cards, suggestions, tasks, checkpointRows, logs);
  })();
  try {
    await runtime.loading;
  } catch (error) {
    runtime.loaded = false;
    throw error;
  } finally {
    runtime.loading = null;
  }
}

async function migrate(schemaSql) {
  await d1.exec(schemaSql);
}

async function logEvent(level, scope, message, data = null) {
  const row = {
    level,
    scope,
    message,
    data_json: data ? JSON.stringify(data) : null,
    created_at: nowMs()
  };
  runtime.logs.unshift(row);
  if (runtime.logs.length > config.runtimeLogLimit) runtime.logs.length = config.runtimeLogLimit;
  if (level === 'warn' || level === 'error') {
    try {
      await d1.query(
        'INSERT INTO logs(level, scope, message, data_json, created_at) VALUES(?, ?, ?, ?, ?)',
        [row.level, row.scope, row.message, row.data_json, row.created_at]
      );
    } catch (error) {
      console.error(`[log:${scope}] failed to persist:`, error.message);
    }
  }
}

async function getActivity({ sinceMs = nowMs() - 60 * 60 * 1000, limit = 50 } = {}) {
  await ensureRuntimeState();
  const logs = runtime.logs.filter(row => numberValue(row.created_at) >= sinceMs).slice(0, limit);
  const summary = new Map();
  const allTasks = [...runtime.tasks.values()];
  for (const task of allTasks) {
    const key = `${task.type}|${task.status}`;
    summary.set(key, (summary.get(key) || 0) + 1);
  }
  const taskSummary = [...summary.entries()]
    .map(([key, count]) => {
      const [type, status] = key.split('|');
      return { type, status, count };
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.status.localeCompare(b.status));
  const recentTasks = allTasks
    .filter(row => numberValue(row.updated_at) >= sinceMs)
    .sort((a, b) => numberValue(b.updated_at) - numberValue(a.updated_at))
    .slice(0, limit);
  const pendingTasks = allTasks
    .filter(row => row.status === 'pending' || row.status === 'checking')
    .sort((a, b) => numberValue(a.updated_at) - numberValue(b.updated_at))
    .slice(0, 20);
  return { logs, taskSummary, recentTasks, pendingTasks };
}

async function upsertAuthor(name, patch = {}) {
  await ensureRuntimeState();
  const key = authorKey(name);
  if (!key) return;
  const current = runtime.authors.get(key);
  const row = {
    author_key: key,
    name: patch.name || current?.name || name,
    created_score: patch.createdScore ?? current?.created_score ?? 0,
    replacement_score: patch.replacementScore ?? current?.replacement_score ?? 0,
    suggestion_score: patch.suggestionScore ?? current?.suggestion_score ?? 0,
    inactive: patch.inactive ?? current?.inactive ?? 0,
    last_profile_checked_at: patch.lastProfileCheckedAt ?? current?.last_profile_checked_at ?? 0,
    last_suggestion_checked_at: patch.lastSuggestionCheckedAt ?? current?.last_suggestion_checked_at ?? 0,
    last_suggestion_found_at: patch.lastSuggestionFoundAt ?? current?.last_suggestion_found_at ?? 0,
    created_count: patch.createdCount ?? current?.created_count ?? null,
    updated_at: current?.updated_at ?? nowMs()
  };
  const durableFields = [
    'name', 'created_score', 'replacement_score', 'suggestion_score',
    'inactive', 'last_suggestion_found_at', 'created_count'
  ];
  const durableChanged = !current || !sameFields(current, row, durableFields);
  if (patch.lastProfileCheckedAt != null || patch.lastSuggestionCheckedAt != null) {
    runtime.checkpointDirty = true;
    runtime.checkpointVersion += 1;
  }
  if (!durableChanged) {
    runtime.authors.set(key, row);
    return row;
  }

  row.updated_at = nowMs();
  await d1.query(
    `INSERT INTO authors(
      author_key, name, created_score, replacement_score, suggestion_score, inactive,
      last_profile_checked_at, last_suggestion_checked_at, last_suggestion_found_at,
      created_count, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(author_key) DO UPDATE SET
      name = excluded.name,
      created_score = excluded.created_score,
      replacement_score = excluded.replacement_score,
      suggestion_score = excluded.suggestion_score,
      inactive = excluded.inactive,
      last_suggestion_found_at = excluded.last_suggestion_found_at,
      created_count = excluded.created_count,
      updated_at = excluded.updated_at`,
    [
      key, row.name, row.created_score, row.replacement_score, row.suggestion_score,
      row.inactive, row.last_profile_checked_at, row.last_suggestion_checked_at,
      row.last_suggestion_found_at, row.created_count, row.updated_at
    ]
  );
  runtime.authors.set(key, row);
  return row;
}

async function bumpAuthorScore(name, type, amount = 1) {
  await upsertAuthor(name);
  const column = type === 'created' ? 'created_score' : type === 'replacement' ? 'replacement_score' : 'suggestion_score';
  const key = authorKey(name);
  const row = runtime.authors.get(key);
  const nextScore = numberValue(row[column]) + amount;
  const updatedAt = nowMs();
  await d1.query(`UPDATE authors SET ${column} = ?, updated_at = ? WHERE author_key = ?`, [nextScore, updatedAt, key]);
  row[column] = nextScore;
  row.updated_at = updatedAt;
}

async function getAuthorsForAuthorship(type, checkedKeys = []) {
  await ensureRuntimeState();
  const scoreField = type === 'created' ? 'created_score' : 'replacement_score';
  const rows = [...runtime.authors.values()].sort(
    (a, b) => numberValue(b[scoreField]) - numberValue(a[scoreField]) || a.name.localeCompare(b.name, 'ru')
  );
  const checked = new Set(checkedKeys);
  return rows.filter(row => !checked.has(row.author_key));
}

async function getAuthorsForSuggestions(limit = 50, now = nowMs(), ratedIntervalMs, zeroIntervalMs) {
  await ensureRuntimeState();
  return [...runtime.authors.values()]
    .filter(row => {
      if (numberValue(row.inactive) !== 0) return false;
      const interval = numberValue(row.suggestion_score) > 0 ? ratedIntervalMs : zeroIntervalMs;
      return numberValue(row.last_suggestion_checked_at) <= now - interval;
    })
    .sort((a, b) =>
      numberValue(b.suggestion_score) - numberValue(a.suggestion_score) ||
      numberValue(a.last_suggestion_checked_at) - numberValue(b.last_suggestion_checked_at) ||
      a.name.localeCompare(b.name, 'ru')
    )
    .slice(0, limit);
}

async function upsertCard(card, source, author = card.author || null) {
  await ensureRuntimeState();
  const now = nowMs();
  const cardId = String(card.cardId);
  const current = runtime.cards.get(cardId);
  const row = {
    card_id: cardId,
    author: author || current?.author || null,
    name: card.name || current?.name || null,
    rank: card.rank || current?.rank || null,
    image: card.image || current?.image || null,
    image_url: card.imageUrl || current?.image_url || null,
    anime_name: card.animeName || current?.anime_name || null,
    anime_link: card.animeLink || current?.anime_link || null,
    first_seen_source: current?.first_seen_source || source,
    seen_in_suggestion: source === 'suggestion' ? 1 : numberValue(current?.seen_in_suggestion),
    seen_on_cards_page: source === 'cards_added' ? 1 : numberValue(current?.seen_on_cards_page),
    last_seen_suggestion_at: source === 'suggestion' ? now : numberValue(current?.last_seen_suggestion_at),
    last_seen_cards_at: source === 'cards_added' ? now : numberValue(current?.last_seen_cards_at),
    updated_at: current?.updated_at ?? now
  };
  const durableFields = [
    'author', 'name', 'rank', 'image', 'image_url', 'anime_name', 'anime_link',
    'first_seen_source', 'seen_in_suggestion', 'seen_on_cards_page'
  ];
  const changed = !current || !sameFields(current, row, durableFields);
  if (!changed) {
    runtime.cards.set(cardId, row);
    return false;
  }
  row.updated_at = now;
  await d1.query(
    `INSERT INTO cards(
      card_id, author, name, rank, image, image_url, anime_name, anime_link, first_seen_source,
      seen_in_suggestion, seen_on_cards_page, last_seen_suggestion_at, last_seen_cards_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(card_id) DO UPDATE SET
      author = excluded.author, name = excluded.name, rank = excluded.rank,
      image = excluded.image, image_url = excluded.image_url,
      anime_name = excluded.anime_name, anime_link = excluded.anime_link,
      seen_in_suggestion = excluded.seen_in_suggestion,
      seen_on_cards_page = excluded.seen_on_cards_page,
      last_seen_suggestion_at = excluded.last_seen_suggestion_at,
      last_seen_cards_at = excluded.last_seen_cards_at,
      updated_at = excluded.updated_at`,
    [
      row.card_id, row.author, row.name, row.rank, row.image, row.image_url,
      row.anime_name, row.anime_link, row.first_seen_source,
      row.seen_in_suggestion, row.seen_on_cards_page,
      row.last_seen_suggestion_at, row.last_seen_cards_at, row.updated_at
    ]
  );
  runtime.cards.set(cardId, row);
  return true;
}

async function upsertSuggestion(card, author) {
  await ensureRuntimeState();
  const cardId = String(card.cardId);
  const current = runtime.suggestions.get(cardId);
  const now = nowMs();
  await upsertCard(card, 'suggestion', author);
  const row = {
    card_id: cardId,
    author,
    name: card.name || current?.name || null,
    rank: card.rank || current?.rank || null,
    image: card.image || current?.image || null,
    image_url: card.imageUrl || current?.image_url || null,
    anime_name: card.animeName || current?.anime_name || null,
    anime_link: card.animeLink || current?.anime_link || null,
    active: 1,
    detected_at: current?.detected_at ?? now,
    last_seen_at: now
  };
  const durableFields = ['author', 'name', 'rank', 'image', 'image_url', 'anime_name', 'anime_link', 'active'];
  const changed = !current || !sameFields(current, row, durableFields);
  if (!changed) {
    runtime.suggestions.set(cardId, row);
    return false;
  }
  await d1.query(
    `INSERT INTO suggestions(
      card_id, author, name, rank, image, image_url, anime_name, anime_link, active, detected_at, last_seen_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(card_id) DO UPDATE SET
      author = excluded.author, name = excluded.name, rank = excluded.rank,
      image = excluded.image, image_url = excluded.image_url,
      anime_name = excluded.anime_name, anime_link = excluded.anime_link,
      active = excluded.active, last_seen_at = excluded.last_seen_at`,
    [
      row.card_id, row.author, row.name, row.rank, row.image, row.image_url,
      row.anime_name, row.anime_link, row.active, row.detected_at, row.last_seen_at
    ]
  );
  if (current && authorKey(current.author) !== authorKey(row.author)) {
    runtime.suggestionsByAuthor.get(authorKey(current.author))?.delete(cardId);
  }
  runtime.suggestions.set(cardId, row);
  addSuggestionToAuthorIndex(row);
  return !current;
}

async function deactivateMissingSuggestions(author, activeCardIds) {
  await ensureRuntimeState();
  const active = new Set(activeCardIds.map(String));
  const authorSuggestions = runtime.suggestionsByAuthor.get(authorKey(author)) || new Set();
  const missing = [...authorSuggestions].filter(cardId => {
    const row = runtime.suggestions.get(cardId);
    return row && numberValue(row.active) === 1 && !active.has(cardId);
  });
  if (!missing.length) return 0;
  for (const batch of chunks(missing)) {
    await d1.query(
      `UPDATE suggestions SET active = 0 WHERE active = 1 AND card_id IN (${batch.map(() => '?').join(',')})`,
      batch
    );
    for (const cardId of batch) runtime.suggestions.get(cardId).active = 0;
  }
  return missing.length;
}

async function upsertTask(type, data) {
  await ensureRuntimeState();
  const key = taskKey(type, data.cardId, data.newImage || data.image || '');
  if (runtime.tasks.has(key)) return key;
  const now = nowMs();
  const row = {
    task_key: key,
    type,
    card_id: String(data.cardId),
    image: data.newImage || data.image || '',
    status: 'pending',
    author: null,
    checked_authors_json: '[]',
    last_error: null,
    created_at: now,
    updated_at: now
  };
  await d1.query(
    `INSERT INTO tasks(task_key, type, card_id, image, status, created_at, updated_at)
     VALUES(?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(task_key) DO NOTHING`,
    [key, type, row.card_id, row.image, now, now]
  );
  runtime.tasks.set(key, row);
  return key;
}

async function getPendingTasks(limit = 10) {
  await ensureRuntimeState();
  const typeOrder = { replacement: 1, created: 2 };
  return [...runtime.tasks.values()]
    .filter(row => row.status === 'pending' || row.status === 'checking')
    .sort((a, b) =>
      (typeOrder[a.type] || 3) - (typeOrder[b.type] || 3) ||
      numberValue(a.updated_at) - numberValue(b.updated_at)
    )
    .slice(0, limit);
}

async function persistTask(row) {
  await d1.query(
    `UPDATE tasks SET status = ?, author = ?, checked_authors_json = ?, last_error = ?, updated_at = ?
     WHERE task_key = ?`,
    [row.status, row.author, row.checked_authors_json, row.last_error, row.updated_at, row.task_key]
  );
  if (runtime.tasks.get(row.task_key) === row) runtime.dirtyTaskKeys.delete(row.task_key);
}

async function updateTask(taskKeyValue, patch) {
  await ensureRuntimeState();
  const current = runtime.tasks.get(taskKeyValue);
  if (!current) return;
  const row = {
    ...current,
    status: patch.status ?? current.status,
    author: patch.author ?? current.author,
    checked_authors_json: patch.checkedAuthorsJson ?? current.checked_authors_json ?? '[]',
    last_error: patch.lastError ?? current.last_error,
    updated_at: nowMs()
  };
  const changed = !sameFields(current, row, ['status', 'author', 'checked_authors_json', 'last_error']);
  if (!changed) return;
  runtime.tasks.set(taskKeyValue, row);
  runtime.dirtyTaskKeys.add(taskKeyValue);
  const terminal = row.status === 'found' || row.status === 'not_found';
  const important = terminal || current.status !== row.status || current.author !== row.author || current.last_error !== row.last_error;
  if (important) await persistTask(row);
}

async function cleanupStaleReplacementTasks(activeTaskKeys) {
  await ensureRuntimeState();
  const keys = [...new Set(activeTaskKeys)].filter(Boolean);
  const active = new Set(keys);
  const stale = [...runtime.tasks.values()].filter(row =>
    row.type === 'replacement' &&
    (row.status === 'pending' || row.status === 'checking') &&
    !row.author &&
    !active.has(row.task_key)
  );
  if (stale.length) {
    for (const batch of chunks(stale)) {
      await d1.query(
        `DELETE FROM tasks WHERE task_key IN (${batch.map(() => '?').join(',')})`,
        batch.map(row => row.task_key)
      );
      for (const row of batch) {
        runtime.tasks.delete(row.task_key);
        runtime.dirtyTaskKeys.delete(row.task_key);
      }
    }
  }
  const deleted = stale.length;
  if (deleted) {
    await logEvent('info', 'cleanup-replacements', 'stale replacement tasks deleted', {
      active: keys.length,
      deleted
    });
  }
  return deleted;
}

async function getResults(keys) {
  await ensureRuntimeState();
  return keys.map(key => runtime.tasks.get(key)).filter(Boolean).map(row => ({
    task_key: row.task_key,
    type: row.type,
    card_id: row.card_id,
    image: row.image,
    status: row.status,
    author: row.author
  }));
}

async function getSuggestions({ rank = '', limit = 60, offset = 0 }) {
  await ensureRuntimeState();
  return [...runtime.suggestions.values()]
    .filter(row => numberValue(row.active) === 1 && (!rank || row.rank === rank))
    .sort((a, b) => numberValue(b.card_id) - numberValue(a.card_id))
    .slice(offset, offset + limit);
}

async function persistRuntimeCheckpoint() {
  if (!runtime.loaded || !runtime.checkpointDirty) return;
  const checkpointVersion = runtime.checkpointVersion;
  const authors = [...runtime.authors.values()].map(row => [
    row.author_key,
    numberValue(row.last_suggestion_checked_at),
    numberValue(row.last_profile_checked_at)
  ]);
  const now = nowMs();
  await d1.query(
    `INSERT INTO settings(key, value, updated_at) VALUES('runtime_checkpoint_v1', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [JSON.stringify({ authors }), now]
  );
  if (runtime.checkpointVersion === checkpointVersion) runtime.checkpointDirty = false;
  runtime.lastCheckpointAt = now;
}

async function flushDirtyTasks() {
  if (!runtime.loaded || !runtime.dirtyTaskKeys.size) return;
  for (const key of [...runtime.dirtyTaskKeys]) {
    const row = runtime.tasks.get(key);
    if (!row) {
      runtime.dirtyTaskKeys.delete(key);
      continue;
    }
    await persistTask(row);
  }
}

async function cleanupOldLogs() {
  const now = nowMs();
  if (now - runtime.lastLogCleanupAt < 24 * 60 * 60 * 1000) return;
  const cutoff = now - config.logRetentionDays * 24 * 60 * 60 * 1000;
  await d1.query('DELETE FROM logs WHERE created_at < ?', [cutoff]);
  await d1.query("DELETE FROM logs WHERE level = 'info' AND created_at < ?", [now - 60 * 60 * 1000]);
  runtime.lastLogCleanupAt = now;
}

async function persistRuntimeState() {
  await ensureRuntimeState();
  await flushDirtyTasks();
  await persistRuntimeCheckpoint();
  await cleanupOldLogs();
}

// ===== src/scheduler.js =====
let tickRunning = false;
let currentTickStep = 'idle';
let lastTickStatus = { ok: true, running: false, message: 'not started', updatedAt: 0 };

async function timedStep(timings, name, fn) {
  const startedAt = nowMs();
  currentTickStep = name;
  try {
    return await fn();
  } finally {
    timings[name] = nowMs() - startedAt;
  }
}

async function runTick({ budgetMs = config.tickBudgetMs } = {}) {
  if (tickRunning) return { ok: true, running: true, skipped: true };
  tickRunning = true;
  const startedAt = nowMs();
  const timings = {};
  lastTickStatus = { ok: true, running: true, step: currentTickStep, startedAt, updatedAt: startedAt };
  const stats = { cardsMonitor: false, tasksProcessed: 0, suggestionAuthors: 0, inactiveChecked: 0 };
  try {
    await timedStep(timings, 'ensureRuntimeState', () => ensureRuntimeState());
    stats.cardsMonitor = await timedStep(timings, 'monitorCardsPage', () => monitorCardsPage());

    const firstTask = await timedStep(timings, 'processOneAuthorshipTask:first', () => processOneAuthorshipTask());
    if (firstTask) stats.tasksProcessed += 1;

    while (nowMs() - startedAt < budgetMs) {
      const didTask = await timedStep(timings, 'processOneAuthorshipTask:loop', () => processOneAuthorshipTask());
      if (didTask) {
        stats.tasksProcessed += 1;
        continue;
      }
      const didSuggestion = await timedStep(timings, 'processSuggestionAuthors', () => processSuggestionAuthors(1));
      if (didSuggestion) {
        stats.suggestionAuthors += didSuggestion;
        continue;
      }
      break;
    }
    const result = { ok: true, running: false, elapsedMs: nowMs() - startedAt, timings, ...stats };
    lastTickStatus = { ...result, updatedAt: nowMs() };
    return result;
  } catch (error) {
    await logEvent('error', 'tick', error.message, { stack: error.stack });
    const result = { ok: false, running: false, step: currentTickStep, error: error.message, timings, ...stats };
    lastTickStatus = { ...result, updatedAt: nowMs() };
    return result;
  } finally {
    tickRunning = false;
    currentTickStep = 'idle';
  }
}

async function monitorCardsPage() {
  const html = await anime.fetchHtml(anime.cardsUrl());
  const parsed = parseCardsPage(html, anime.baseUrl);

  for (const author of parsed.visibleAuthors) {
    await upsertAuthor(author);
  }

  for (const card of parsed.addedCards) {
    if (card.author) await upsertAuthor(card.author);
    await upsertCard(card, 'cards_added', card.author || null);
    await upsertTask('created', { cardId: card.cardId, image: card.image });
  }

  for (const replacement of parsed.replacements) {
    await upsertTask('replacement', replacement);
  }
  const activeReplacementKeys = parsed.replacements.map(replacement =>
    taskKey('replacement', replacement.cardId, replacement.newImage || replacement.image || '')
  );
  const staleReplacementsDeleted = await cleanupStaleReplacementTasks(activeReplacementKeys);

  await logEvent('info', 'cards-monitor', 'cards page parsed', {
    addedCards: parsed.addedCards.length,
    replacements: parsed.replacements.length,
    visibleAuthors: parsed.visibleAuthors.length,
    staleReplacementsDeleted,
    addedDebug: parsed.addedDebug
  });
  return {
    ok: true,
    addedCards: parsed.addedCards.length,
    replacements: parsed.replacements.length,
    visibleAuthors: parsed.visibleAuthors.length,
    staleReplacementsDeleted,
    addedDebug: parsed.addedDebug
  };
}

async function processOneAuthorshipTask() {
  const tasks = await getPendingTasks(1);
  const task = tasks[0];
  if (!task) return false;

  const checked = new Set(safeJsonArray(task.checked_authors_json));
  const authors = await getAuthorsForAuthorship(task.type, [...checked]);
  if (!authors.length) {
    await updateTask(task.task_key, { status: 'not_found' });
    return true;
  }

  const author = authors[0];
  checked.add(author.author_key);
  try {
    if (task.type === 'created') {
      const html = await anime.fetchHtml(anime.createdModerationUrl(author.name));
      const cards = parseCreatedModerationCards(html, anime.baseUrl, author.name);
      const found = cards.find(card => card.cardId === String(task.card_id));
      if (found) {
        await upsertCard(found, 'cards_added', author.name);
        await updateTask(task.task_key, {
          status: 'found',
          author: author.name,
          checkedAuthorsJson: JSON.stringify([...checked])
        });
        await bumpAuthorScore(author.name, 'created', 1);
        return true;
      }
    } else if (task.type === 'replacement') {
      const html = await anime.fetchHtml(anime.replacementPendingUrl(author.name));
      const byId = parseReplacementPage(html, anime.baseUrl);
      const images = byId.get(String(task.card_id)) || new Set();
      if (images.has(imagePath(anime.baseUrl, task.image))) {
        await updateTask(task.task_key, {
          status: 'found',
          author: author.name,
          checkedAuthorsJson: JSON.stringify([...checked])
        });
        await bumpAuthorScore(author.name, 'replacement', 1);
        return true;
      }
    }
    await updateTask(task.task_key, {
      status: 'checking',
      checkedAuthorsJson: JSON.stringify([...checked])
    });
  } catch (error) {
    await updateTask(task.task_key, {
      status: 'checking',
      checkedAuthorsJson: JSON.stringify([...checked]),
      lastError: error.message
    });
    await logEvent('warn', 'authorship-task', error.message, { taskKey: task.task_key, author: author.name });
  }
  return true;
}

async function processSuggestionAuthors(limit = 3) {
  const authors = await getAuthorsForSuggestions(
    limit,
    nowMs(),
    config.suggestionRatedIntervalMs,
    config.suggestionZeroIntervalMs
  );
  let processed = 0;
  for (const author of authors) {
    await checkAuthorSuggestions(author.name);
    processed += 1;
  }
  return processed;
}

async function checkAuthorSuggestions(authorName) {
  const html = await anime.fetchHtml(anime.createdModerationUrl(authorName));
  const cards = parseCreatedModerationCards(html, anime.baseUrl, authorName);
  const activeIds = [];
  let newCount = 0;

  for (const card of cards) {
    activeIds.push(card.cardId);
    const isNewSuggestion = await upsertSuggestion(card, authorName);
    await updateTask(await upsertTask('created', { cardId: card.cardId, image: card.image }), {
      status: 'found',
      author: authorName,
      checkedAuthorsJson: JSON.stringify([authorKey(authorName)])
    });
    if (isNewSuggestion) newCount += 1;
  }
  await deactivateMissingSuggestions(authorName, activeIds);
  await upsertAuthor(authorName, { lastSuggestionCheckedAt: nowMs() });

  if (newCount) {
    await bumpAuthorScore(authorName, 'suggestion', newCount);
    await upsertAuthor(authorName, { lastSuggestionFoundAt: nowMs() });
  }
}

async function decaySuggestionScores() {
  await ensureRuntimeState();
  const cutoff = nowMs() - config.suggestionDecayDays * 24 * 60 * 60 * 1000;
  const rows = [...runtime.authors.values()].filter(row =>
    numberValue(row.suggestion_score) > 0 &&
    numberValue(row.last_suggestion_found_at) > 0 &&
    numberValue(row.last_suggestion_found_at) < cutoff
  );
  for (const row of rows) {
    await upsertAuthor(row.name, { suggestionScore: 0 });
  }
}

async function checkInactiveAuthors(limit = 20) {
  await ensureRuntimeState();
  const cutoff = nowMs() - config.inactiveScanIntervalMs;
  const rows = [...runtime.authors.values()]
    .filter(row => numberValue(row.last_profile_checked_at) <= cutoff)
    .sort((a, b) => numberValue(a.last_profile_checked_at) - numberValue(b.last_profile_checked_at))
    .slice(0, limit);
  let checked = 0;
  for (const row of rows) {
    try {
      const html = await anime.fetchHtml(anime.profileUrl(row.name));
      const onlineText = parseProfileOnlineText(html);
      await upsertAuthor(row.name, {
        inactive: isMoreThanMonthOffline(onlineText) ? 1 : 0,
        lastProfileCheckedAt: nowMs()
      });
      checked += 1;
    } catch (error) {
      await logEvent('warn', 'inactive', error.message, { author: row.name });
    }
  }
  return checked;
}

// ===== src/server.js =====
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get('/', async () => ({
  ok: true,
  service: 'anime-cards-server',
  running: tickRunning,
  currentTickStep,
  lastTickStatus,
  runtimeCache: runtimeStats()
}));

app.get('/health', async () => ({
  ok: true,
  service: 'anime-cards-server',
  runtimeCache: runtimeStats()
}));

app.get('/api/tick', async request => {
  const budgetMs = Number(request.query?.budgetMs || config.tickBudgetMs);
  const wait = String(request.query?.wait || '') === '1';
  if (wait) return runTick({ budgetMs });
  const wasRunning = tickRunning;
  if (!wasRunning) {
    runTick({ budgetMs }).catch(error => {
      lastTickStatus = { ok: false, running: false, error: error.message, updatedAt: nowMs() };
      console.error('[tick]', error);
    });
  }
  return { ok: true, started: !wasRunning, running: true, lastTickStatus };
});

app.get('/api/tick-status', async () => {
  return { ok: true, running: tickRunning, currentTickStep, lastTickStatus, runtimeCache: runtimeStats() };
});

app.get('/api/activity', async request => {
  const hours = Math.min(Math.max(Number(request.query?.hours || 1), 0.1), 24);
  const limit = Math.min(Math.max(Number(request.query?.limit || 50), 1), 200);
  const activity = await getActivity({ sinceMs: nowMs() - hours * 60 * 60 * 1000, limit });
  return {
    ok: true,
    running: tickRunning,
    currentTickStep,
    lastTickStatus,
    hours,
    ...activity
  };
});

app.post('/api/admin/migrate', async (request, reply) => {
  requireAdmin(request, reply);
  if (reply.sent) return;
  const schema = await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await migrate(schema);
  return { ok: true };
});

app.post('/api/admin/import-state', async (request, reply) => {
  requireAdmin(request, reply);
  if (reply.sent) return;
  const state = request.body?.animesss_card_authorship_checker_v1 || request.body || {};
  const authors = Array.isArray(state.authors) ? state.authors : [];
  const creators = new Set((state.creators || []).map(authorKey));
  for (const author of authors) {
    const key = authorKey(author);
    await upsertAuthor(author, {
      createdScore: Number(state.stats?.created?.[key] || 0),
      replacementScore: Number(state.stats?.replacements?.[key] || 0),
      inactive: state.inactiveAuthors?.[key] ? 1 : 0,
      createdCount: creators.has(key) ? Number(state.creatorCounts?.[key] || 50) : null
    });
  }
  await logEvent('info', 'import-state', 'authors imported', { count: authors.length });
  return { ok: true, authors: authors.length };
});

app.post('/api/admin/monitor-cards', async (request, reply) => {
  requireAdmin(request, reply);
  if (reply.sent) return;
  await monitorCardsPage();
  return { ok: true };
});

app.post('/api/admin/cleanup-created-tasks', async (request, reply) => {
  requireAdmin(request, reply);
  if (reply.sent) return;
  await ensureRuntimeState();
  const belowId = Number(request.body?.belowId || request.query?.belowId || 90000);
  const stale = [...runtime.tasks.values()].filter(row =>
    row.type === 'created' &&
    (row.status === 'pending' || row.status === 'checking') &&
    !row.author &&
    numberValue(row.card_id) < belowId
  );
  if (stale.length) {
    for (const batch of chunks(stale)) {
      await d1.query(
        `DELETE FROM tasks WHERE task_key IN (${batch.map(() => '?').join(',')})`,
        batch.map(row => row.task_key)
      );
      for (const row of batch) {
        runtime.tasks.delete(row.task_key);
        runtime.dirtyTaskKeys.delete(row.task_key);
      }
    }
  }
  await logEvent('info', 'cleanup-created-tasks', 'old created pending tasks deleted', {
    belowId,
    deleted: stale.length
  });
  return { ok: true, belowId, deleted: stale.length };
});

app.post('/api/admin/check-suggestions', async (request, reply) => {
  requireAdmin(request, reply);
  if (reply.sent) return;
  const limit = Number(request.body?.limit || 10);
  const processed = await processSuggestionAuthors(limit);
  await decaySuggestionScores();
  return { ok: true, processed };
});

app.post('/api/admin/check-inactive', async (request, reply) => {
  requireAdmin(request, reply);
  if (reply.sent) return;
  const limit = Number(request.body?.limit || 20);
  const checked = await checkInactiveAuthors(limit);
  return { ok: true, checked };
});

app.get('/api/results', async request => {
  const keys = String(request.query?.keys || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 100);
  return { ok: true, results: await getResults(keys) };
});

app.get('/api/suggestions', async request => {
  const rank = String(request.query?.rank || '').toLowerCase();
  const limit = Math.min(Number(request.query?.limit || 60), 200);
  const offset = Math.max(Number(request.query?.offset || 0), 0);
  return { ok: true, cards: await getSuggestions({ rank, limit, offset }) };
});

app.get('/api/rank', async request => {
  await ensureRuntimeState();
  const limit = Math.min(Number(request.query?.limit || 100), 500);
  const rows = [...runtime.authors.values()]
    .sort((a, b) =>
      (numberValue(b.created_score) + numberValue(b.replacement_score) + numberValue(b.suggestion_score)) -
      (numberValue(a.created_score) + numberValue(a.replacement_score) + numberValue(a.suggestion_score)) ||
      numberValue(b.suggestion_score) - numberValue(a.suggestion_score) ||
      a.name.localeCompare(b.name, 'ru')
    )
    .slice(0, limit)
    .map(row => ({
      name: row.name,
      created_score: row.created_score,
      replacement_score: row.replacement_score,
      suggestion_score: row.suggestion_score,
      inactive: row.inactive
    }));
  return { ok: true, rows };
});

function startAutoTick() {
  const intervalMs = Math.max(config.cardsMonitorIntervalMs, 10000);
  const run = () => {
    if (tickRunning) return;
    runTick({ budgetMs: config.tickBudgetMs }).catch(error => {
      lastTickStatus = { ok: false, running: false, error: error.message, updatedAt: nowMs() };
      console.error('[auto-tick]', error);
    });
  };
  setTimeout(run, 5000);
  setInterval(run, intervalMs);
  setInterval(() => {
    persistRuntimeState().catch(error => console.error('[runtime-checkpoint]', error));
  }, Math.max(config.runtimeCheckpointIntervalMs, 60000));
  console.log(`[auto-tick] enabled, interval ${intervalMs}ms`);
}

startAutoTick();

app.listen({ port: config.port, host: '0.0.0.0' });
