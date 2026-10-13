import fs from 'node:fs/promises';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as cheerio from 'cheerio';
import { deflate, inflate } from 'node:zlib';
import { promisify } from 'node:util';
import { AdaptiveScheduler, activityScore, MAX_INTERVAL, MINUTE, HOUR, DAY } from './adaptive-scheduler.js';


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
    requestDelayMs: Math.max(1000, Number(process.env.ANIMESSS_REQUEST_DELAY_MS || 1000))
  },
  cloudflare: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID || '',
    apiToken: process.env.CLOUDFLARE_API_TOKEN || ''
  },
  adminToken: process.env.ADMIN_TOKEN || '',
  tickBudgetMs: Math.min(45000, Math.max(5000, Number(process.env.TICK_BUDGET_MS || 35000))),
  suggestionRequestsPerHour: Math.max(1, Number(process.env.SUGGESTION_REQUESTS_PER_HOUR || 600)),
  replacementRequestsPerHour: Math.max(1, Number(process.env.REPLACEMENT_REQUESTS_PER_HOUR || 300)),
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
    this.usage = { since: Date.now(), queries: 0, rowsRead: 0, rowsWritten: 0 };
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
    this.usage.queries++;
    for (const result of json.result || []) {
      this.usage.rowsRead += Number(result.meta?.rows_read || 0);
      this.usage.rowsWritten += Number(result.meta?.rows_written || 0);
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
const compressState = promisify(deflate);
const decompressState = promisify(inflate);

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
    this.requestQueue = Promise.resolve();
    this.cooldownUntil = 0;
    this.networkFailures = 0;
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

  fetchHtml(urlOrPath) {
    const operation = this.requestQueue.then(async () => {
      if (Date.now() < this.cooldownUntil) throw new Error('site cooldown active');
      try {
        const html = await this.fetchHtmlInternal(urlOrPath);
        if (!/<(?:html|body)\b/i.test(html) || /checking your browser|verify you are human|just a moment|captcha-container/i.test(html)) {
          throw new Error('unrecognized site page; not treated as an empty list');
        }
        this.networkFailures = 0;
        return html;
      } catch (error) {
        this.networkFailures++;
        this.cooldownUntil = Date.now() + Math.min(10 * MINUTE, 15000 * 2 ** Math.min(6, this.networkFailures - 1));
        throw error;
      }
    });
    this.requestQueue = operation.catch(() => {});
    return operation;
  }

  async fetchHtmlInternal(urlOrPath) {
    const path = this.pathFromUrl(urlOrPath);
    const errors = [];

    for (const origin of this.preferredOrigins(urlOrPath)) {
      try {
        return await this.fetchFromOrigin(origin, path);
      } catch (error) {
        this.cookieByOrigin.delete(origin);
        errors.push(`${origin}${path}: ${error.message}`);
        if (/HTTP (429|403)/.test(error.message)) throw error;
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
    catalogCards: parseVisibleCatalogCards($, baseUrl),
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

function parseVisibleCatalogCards($, baseUrl) {
  return $('.anime-cards__item[data-id][data-author]').toArray().filter(node => {
    const item = $(node);
    return !item.closest('.cards-replace-vote-list,.card-replace-vote,[data-suite-vote-block="1"]').length
      && !item.closest('.anime-cards__item-wrapper,.anime-cards__item-wrapper-gl').find('.card-votes').length;
  }).map(node => cardFromNode($, node, baseUrl)).filter(card => card.cardId && card.author);
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
let adaptive = null;
let adaptiveSavedRevision = -1;
let adaptiveLastSavedAt = 0;
let adaptiveLastSaveError = '';
let persistInFlight = null;
let lastCatalogMonitorAt = 0;
let activeCreatedKeys = new Set();
let activeReplacementKeys = new Set();
const authorPageCache = new Map(); // Bounded, short-lived parsed lists; never raw HTML.
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
    schedulerVersion: adaptive ? 'adaptive-1' : null,
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
  if (runtime.loaded && adaptive) return;
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
    const saved = await d1.query("SELECT value FROM settings WHERE key = 'adaptive_authors_v1'");
    let state = saved[0]?.value ? JSON.parse(saved[0].value) : null;
    if (state?.encoding === 'deflate-base64') {
      state = JSON.parse((await decompressState(Buffer.from(state.data, 'base64'), { maxOutputLength: 16 * 1024 * 1024 })).toString('utf8'));
    }
    adaptive = new AdaptiveScheduler([...runtime.authors.values()], state, nowMs(), {
      budget: config.suggestionRequestsPerHour, replacementBudget: config.replacementRequestsPerHour,
      dutyCycle: Math.min(1, config.tickBudgetMs / Math.max(config.cardsMonitorIntervalMs, 10000))
    });
    adaptive.state.createdCoverage ||= {};
    adaptive.state.taskEpoch ||= {};
    adaptive.state.sweepRetry ||= {};
    adaptive.seedEvents(runtime.cards.keys(),
      [...runtime.tasks.values()].filter(task => task.type === 'replacement' && task.status === 'found').map(task => task.task_key));
    if (!state) await persistAdaptiveState(); // Save the initial spread before the first request.
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

const persistedLogTimes = new Map();
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
    const signature = scope + ':' + message;
    const last = persistedLogTimes.get(signature);
    if (last && row.created_at - last < 5 * MINUTE) return;
    persistedLogTimes.set(signature, row.created_at);
    if (persistedLogTimes.size > 200) persistedLogTimes.delete(persistedLogTimes.keys().next().value);
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

async function persistAdaptiveState() {
  if (!adaptive || adaptiveSavedRevision === adaptive.revision) return;
  const revision = adaptive.revision;
  const snapshot = JSON.stringify({ encoding: 'deflate-base64',
    data: (await compressState(JSON.stringify(adaptive.state))).toString('base64') });
  // Keep settings values below a conservative payload ceiling; never discard state silently.
  if (Buffer.byteLength(snapshot, 'utf8') > 1_500_000) throw new Error('adaptive state too large; export and compact required');
  await d1.query(
    "INSERT INTO settings(key,value,updated_at) VALUES('adaptive_authors_v1',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    [snapshot, nowMs()]);
  adaptiveSavedRevision = revision;
  adaptiveLastSavedAt = nowMs();
  adaptiveLastSaveError = '';
}

async function persistRuntimeState() {
  if (persistInFlight) return persistInFlight;
  persistInFlight = (async () => {
    await ensureRuntimeState();
    await flushDirtyTasks();
    await persistRuntimeCheckpoint();
    try { await persistAdaptiveState(); }
    catch (error) { adaptiveLastSaveError = error.message; throw error; }
    await cleanupOldLogs();
  })();
  try { return await persistInFlight; }
  finally { persistInFlight = null; }
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
  budgetMs = Math.min(config.tickBudgetMs, Math.max(1000, Number(budgetMs) || config.tickBudgetMs));
  const startedAt = nowMs();
  const timings = {};
  const stats = { cardsMonitor: false, tasksProcessed: 0, suggestionAuthors: 0, inactiveChecked: 0 };
  lastTickStatus = { ok: true, running: true, startedAt, updatedAt: startedAt };
  try {
    await ensureRuntimeState();
    if (nowMs() >= anime.cooldownUntil && nowMs() - lastCatalogMonitorAt >= config.cardsMonitorIntervalMs) {
      stats.cardsMonitor = await timedStep(timings, 'monitorCardsPage', monitorCardsPage);
    }
    while (nowMs() - startedAt < budgetMs && nowMs() >= anime.cooldownUntil) {
      // Each queue gets a turn: pending replacements can no longer suppress suggestions.
      let worked = false;
      if (nowMs() - startedAt < budgetMs) {
        const count = await timedStep(timings, 'suggestions', () => processSuggestionAuthors(1));
        stats.suggestionAuthors += count;
        worked ||= count > 0;
      }
      if (nowMs() - startedAt < budgetMs && nowMs() >= anime.cooldownUntil) {
        const count = await timedStep(timings, 'authorship', processOneAuthorshipTask);
        stats.tasksProcessed += Number(count);
        worked ||= Boolean(count);
      }
      if (!worked) await sleep(500); // Yield; no busy DOM/CPU loop.
    }
    const health = adaptive.report([...runtime.authors.values()], nowMs());
    const result = { ok: true, running: false, elapsedMs: nowMs() - startedAt,
      timings, ...stats, overdueAuthors: health.overdue, capacityInsufficient: health.capacityInsufficient };
    lastTickStatus = { ...result, updatedAt: nowMs() };
    return result;
  } catch (error) {
    await logEvent('error', 'tick', error.message);
    lastTickStatus = { ok: false, running: false, step: currentTickStep, error: error.message, ...stats, updatedAt: nowMs() };
    return lastTickStatus;
  } finally { tickRunning = false; currentTickStep = 'idle'; }
}

async function monitorCardsPage() {
  const html = await anime.fetchHtml(anime.cardsUrl());
  const parsed = parseCardsPage(html, anime.baseUrl);

  for (const author of parsed.visibleAuthors) await upsertAuthor(author);
  activeCreatedKeys = new Set(parsed.addedCards.map(card => taskKey('created', card.cardId)));
  activeReplacementKeys = new Set(parsed.replacements.map(card => taskKey('replacement', card.cardId, card.newImage)));
  for (const card of parsed.catalogCards) {
    const key = authorKey(card.author);
    const knownCard = runtime.cards.has(String(card.cardId));
    const firstObservedPublication = adaptive.catalogIsNew(card.cardId);
    adaptive.addAuthor(key, nowMs());
    if (firstObservedPublication) {
      // Existing moderation -> publication is a wake-up signal, not a second activity point.
      if (!knownCard) adaptive.observe(key, 'suggestion', [card.cardId], nowMs());
      adaptive.wake(key, nowMs());
      await upsertAuthor(card.author, { inactive: 0 });
      await upsertCard(card, 'catalog', card.author);
    }
  }
  lastCatalogMonitorAt = nowMs();

  for (const card of parsed.addedCards) {
    if (card.author) await upsertAuthor(card.author);
    await upsertCard(card, 'cards_added', card.author || null);
    await upsertTask('created', { cardId: card.cardId, image: card.image });
  }

  for (const replacement of parsed.replacements) {
    await upsertTask('replacement', replacement);
  }
  const visibleReplacementKeys = parsed.replacements.map(replacement =>
    taskKey('replacement', replacement.cardId, replacement.newImage || replacement.image || '')
  );
  const staleReplacementsDeleted = await cleanupStaleReplacementTasks(visibleReplacementKeys);

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

function visibleAuthorshipTasks(type) {
  if (nowMs() - lastCatalogMonitorAt > 5 * MINUTE) return [];
  const active = type === 'replacement' ? activeReplacementKeys : activeCreatedKeys;
  return [...runtime.tasks.values()].filter(task => task.type === type && active.has(task.task_key)
    && (task.status === 'pending' || task.status === 'checking' ||
      (task.status === 'not_found' && task.updated_at + MAX_INTERVAL <= nowMs())));
}

function epochFor(task) {
  return adaptive.state.taskEpoch[task.task_key] || Number(task.created_at) || 0;
}

async function fetchAuthorList(author, kind, notOlderThan = 0) {
  const key = kind + ':' + authorKey(author);
  const cached = authorPageCache.get(key);
  if (cached && cached.at >= notOlderThan && cached.at + 2 * MINUTE > nowMs()) return cached;
  const html = await anime.fetchHtml(kind === 'replacement'
    ? anime.replacementPendingUrl(author) : anime.createdModerationUrl(author));
  const items = kind === 'replacement' ? parseReplacementPage(html, anime.baseUrl)
    : parseCreatedModerationCards(html, anime.baseUrl, author);
  const page = { at: nowMs(), items };
  authorPageCache.set(key, page);
  for (const [key, value] of authorPageCache) {
    if (value.at + 2 * MINUTE < nowMs() || authorPageCache.size > 128) authorPageCache.delete(key);
  }
  return page;
}

async function processOneAuthorshipTask() {
  const now = nowMs();
  if (now < adaptive.state.nextReplacementAt) return false;
  const choices = ['replacement', 'created'];
  // Retain S-card authorship, but only for cards actually present in a current voting block.
  if (adaptive.state.lastAuthorshipKind === 'replacement') choices.reverse();
  for (const type of choices) {
    const tasks = visibleAuthorshipTasks(type);
    if (!tasks.length) continue;
    for (const task of tasks) {
      if (task.status === 'not_found') {
        adaptive.state.taskEpoch[task.task_key] = now;
        adaptive.touch();
        await updateTask(task.task_key, { status: 'checking', checkedAuthorsJson: '[]' });
      }
    }
    const oldest = Math.min(...tasks.map(epochFor));
    const candidates = [...runtime.authors.values()].map(row => {
      const entry = adaptive.addAuthor(row.author_key, now);
      const lane = entry.replacement;
      const coveredAt = type === 'replacement' ? lane.lastSuccess : (adaptive.state.createdCoverage[row.author_key] || 0);
      const retry = adaptive.state.sweepRetry[type + ':' + row.author_key] || 0;
      const score = type === 'replacement' ? activityScore(lane, now, adaptive.state.startedAt)
        : Math.max(0, Number(row.created_score) || 0);
      return { row, lane, coveredAt, retry, score };
    });
    const eligible = candidates.filter(x => x.coveredAt < oldest && x.retry <= now)
      .sort((a, b) => {
        const urgentA = now - oldest >= MAX_INTERVAL;
        // Once a sweep is overdue, visit least recently checked authors first.
        return (urgentA ? a.coveredAt - b.coveredAt : b.score - a.score)
          || a.coveredAt - b.coveredAt || a.row.author_key.localeCompare(b.row.author_key);
      });
    const chosen = eligible[0];
    if (!chosen) {
      if (candidates.length && candidates.every(x => x.coveredAt >= oldest)) {
        const coveredThrough = Math.min(...candidates.map(x => x.coveredAt));
        for (const task of tasks.filter(task => epochFor(task) <= coveredThrough)) {
          await updateTask(task.task_key, { status: 'not_found' });
        }
      }
      continue;
    }
    adaptive.reserve('replacement', now);
    adaptive.state.lastAuthorshipKind = type;
    const key = chosen.row.author_key;
    try {
      const page = await fetchAuthorList(chosen.row.name, type === 'replacement' ? 'replacement' : 'suggestion', oldest);
      if (type === 'replacement') {
        const uniqueReplacements = [...page.items].flatMap(([id, images]) => [...images].map(image => taskKey('replacement', id, image)));
        const count = adaptive.observe(key, 'replacement', uniqueReplacements, nowMs());
        if (count) await upsertAuthor(chosen.row.name, { inactive: 0 });
        for (const task of tasks) {
          if (page.items.get(String(task.card_id))?.has(imagePath(anime.baseUrl, task.image))) {
            await updateTask(task.task_key, { status: 'found', author: chosen.row.name });
            await bumpAuthorScore(chosen.row.name, 'replacement', 1);
          }
        }
        adaptive.success(key, 'replacement', page.at);
      } else {
        // The same moderation fetch also updates suggestions; no second network request.
        await applyAuthorSuggestions(chosen.row.name, page.items, page.at);
      }
      delete adaptive.state.sweepRetry[type + ':' + key];
      if (adaptive.state.sweepRetryCount) delete adaptive.state.sweepRetryCount[type + ':' + key];
      adaptive.touch();
    } catch (error) {
      // Failed HTTP/parsing is NOT negative coverage for any task.
      const retries = (adaptive.state.sweepRetryCount ||= {});
      const token = type + ':' + key;
      retries[token] = Math.min(6, (retries[token] || 0) + 1);
      adaptive.state.sweepRetry[token] = nowMs() + Math.min(HOUR, MINUTE * 2 ** (retries[token] - 1));
      adaptive.touch();
      await logEvent('warn', 'authorship-task', error.message, { author: chosen.row.name, type });
    }
    return true;
  }
  return false;
}

async function processSuggestionAuthors(limit = 1) {
  let processed = 0;
  while (processed < limit && nowMs() >= anime.cooldownUntil) {
    const next = adaptive.nextSuggestion([...runtime.authors.values()], nowMs());
    if (!next) break;
    adaptive.reserve('suggestion', nowMs());
    try {
      await checkAuthorSuggestions(next.row.name);
    } catch (error) {
      adaptive.failure(next.row.author_key, 'suggestion', nowMs());
      await logEvent('warn', 'suggestions', error.message, { author: next.row.name });
    }
    processed++;
  }
  return processed;
}

async function checkAuthorSuggestions(authorName) {
  const page = await fetchAuthorList(authorName, 'suggestion');
  await applyAuthorSuggestions(authorName, page.items, page.at);
}

async function applyAuthorSuggestions(authorName, cards, fetchedAt) {
  const key = authorKey(authorName);
  const activeIds = [];
  let newCount = 0;
  for (const card of cards) {
    activeIds.push(card.cardId);
    const knownCard = runtime.cards.has(String(card.cardId));
    const isNew = await upsertSuggestion(card, authorName);
    if (!knownCard) adaptive.observe(key, 'suggestion', [card.cardId], fetchedAt);
    // Do not create dormant S-vote tasks for every moderation card.
    const existing = runtime.tasks.get(taskKey('created', card.cardId));
    if (existing && existing.status !== 'found') {
      await updateTask(existing.task_key, { status: 'found', author: authorName });
      if (activeCreatedKeys.has(existing.task_key)) await bumpAuthorScore(authorName, 'created', 1);
    }
    if (isNew) newCount++;
  }
  await deactivateMissingSuggestions(authorName, activeIds);
  await upsertAuthor(authorName, { lastSuggestionCheckedAt: fetchedAt,
    ...(newCount ? { inactive: 0, lastSuggestionFoundAt: fetchedAt } : {}) });
  if (newCount) await bumpAuthorScore(authorName, 'suggestion', newCount);
  adaptive.state.createdCoverage[key] = fetchedAt;
  const plan = adaptive.plan([...runtime.authors.values()], nowMs()).planned.find(x => x.row.author_key === key);
  adaptive.success(key, 'suggestion', fetchedAt, plan?.interval || MAX_INTERVAL);
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

// Full export is authenticated and reads memory, not another SELECT per visitor.
app.get('/api/admin/authors', async (request, reply) => {
  if (!config.adminToken) return reply.code(503).send({ ok: false, error: 'ADMIN_TOKEN is required for export' });
  if (request.headers['x-admin-token'] !== config.adminToken) {
    return reply.code(401).send({ ok: false, error: 'admin token required' });
  }
  await ensureRuntimeState();
  reply.header('cache-control', 'no-store');
  return { ok: true, ...adaptive.report([...runtime.authors.values()], nowMs()),
    d1UsageSinceStartup: d1.usage,
    lastAdaptiveSavedAt: adaptiveLastSavedAt,
    lastAdaptiveSaveError: adaptiveLastSaveError,
    note: 'Live schedule; deployment downtime and site errors can cause overdue work.' };
});

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
  if (tickRunning) return reply.code(409).send({ ok: false, error: 'scheduler busy' });
  tickRunning = true;
  try { await ensureRuntimeState(); await monitorCardsPage(); return { ok: true }; }
  finally { tickRunning = false; }
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
  if (tickRunning) return reply.code(409).send({ ok: false, error: 'scheduler busy' });
  tickRunning = true;
  try {
    await ensureRuntimeState();
    const processed = await processSuggestionAuthors(Math.min(10, Math.max(1, Number(request.body?.limit) || 1)));
    return { ok: true, processed };
  } finally { tickRunning = false; }
});

app.post('/api/admin/check-inactive', async (request, reply) => {
  requireAdmin(request, reply);
  if (reply.sent) return;
  if (tickRunning) return reply.code(409).send({ ok: false, error: 'scheduler busy' });
  tickRunning = true;
  try {
    const checked = await checkInactiveAuthors(Math.min(20, Math.max(1, Number(request.body?.limit) || 1)));
    return { ok: true, checked };
  } finally { tickRunning = false; }
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
