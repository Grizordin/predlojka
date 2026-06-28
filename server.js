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
  suggestionDecayDays: Number(process.env.SUGGESTION_DECAY_DAYS || 7)
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
  return html.includes('Р РµРіРёСЃС‚СЂР°С†РёСЏ РїРѕСЃРµС‚РёС‚РµР»СЏ')
    || html.includes('РђРІС‚РѕСЂРёР·Р°С†РёСЏ')
    || html.includes('Р”Р»СЏ РїСЂРѕСЃРјРѕС‚СЂР° РґР°РЅРЅРѕР№ СЃС‚СЂР°РЅРёС†С‹ РЅСѓР¶РЅРѕ Р°РІС‚РѕСЂРёР·РѕРІР°С‚СЊСЃСЏ')
    || html.includes('Р В Р ВµР С–Р С‘РЎРѓРЎвЂљРЎР‚Р В°РЎвЂ Р С‘РЎРЏ Р С—Р С•РЎРѓР ВµРЎвЂљР С‘РЎвЂљР ВµР В»РЎРЏ')
    || html.includes('Р С’Р Р†РЎвЂљР С•РЎР‚Р С‘Р В·Р В°РЎвЂ Р С‘РЎРЏ')
    || html.includes('Р вЂќР В»РЎРЏ Р С—РЎР‚Р С•РЎРѓР СР С•РЎвЂљРЎР‚Р В°')
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
    .find(value => /РљР°СЂС‚РѕС‡РєРё\s+СЃРѕР·РґР°РЅРЅС‹Рµ\s+РїРѕР»СЊР·РѕРІР°С‚РµР»РµРј|Р С™Р В°РЎР‚РЎвЂљР С•РЎвЂЎР С”Р С‘\s+РЎРѓР С•Р В·Р Т‘Р В°Р Р…Р Р…РЎвЂ№Р Вµ/i.test(value)) || $.text();
  const match = String(text || '').match(/\(([\d\s]+)\s*(?:С€С‚\.|РЎв‚¬РЎвЂљ\.)\)/i);
  return match ? Number(match[1].replace(/\s+/g, '')) : 0;
}

function parseProfileOnlineText(html) {
  const $ = cheerio.load(html || '');
  const line = $('.usn__info-line').toArray()
    .map(node => $(node).text().replace(/\s+/g, ' ').trim())
    .find(text => /^Р’ СЃРµС‚Рё:|^Р вЂ™\s+РЎРѓР ВµРЎвЂљР С‘:/i.test(text));
  return line || '';
}

function isMoreThanMonthOffline(onlineText) {
  const text = String(onlineText || '').toLowerCase();
  if (!text) return false;
  if (/РіРѕРґ|Р»РµС‚|Р С–Р С•Р Т‘|Р В»Р ВµРЎвЂљ/.test(text)) return true;
  if (/РјРµСЃСЏС†|Р СР ВµРЎРѓРЎРЏРЎвЂ /.test(text)) return true;
  return false;
}

function parseCardsPage(html, baseUrl) {
  const $ = cheerio.load(html || '');
  return {
    addedCards: parseAddedCards($, baseUrl),
    replacements: parseReplacementVotes($, baseUrl),
    visibleAuthors: parseVisibleCatalogAuthors($)
  };
}

function parseAddedCards($, baseUrl) {
  const blocks = $('.anime-cards-center.anime-cards--full-page[data-suite-vote-block="1"], .anime-cards-center.anime-cards--full-page')
    .filter((_, section) => $(section).find('.card-votes').length > 0 && $(section).find('.card-replace-vote').length === 0);
  const scope = blocks.length ? blocks : $.root();
  return scope.find('.anime-cards__item[data-id]').toArray()
    .map(node => cardFromNode($, node, baseUrl))
    .filter(card => card.cardId && card.image);
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
async function migrate(schemaSql) {
  await d1.exec(schemaSql);
}

async function logEvent(level, scope, message, data = null) {
  await d1.query(
    'INSERT INTO logs(level, scope, message, data_json, created_at) VALUES(?, ?, ?, ?, ?)',
    [level, scope, message, data ? JSON.stringify(data) : null, nowMs()]
  );
}

async function getActivity({ sinceMs = nowMs() - 60 * 60 * 1000, limit = 50 } = {}) {
  const logs = await d1.query(
    `SELECT level, scope, message, data_json, created_at
     FROM logs
     WHERE created_at >= ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [sinceMs, limit]
  );
  const taskSummary = await d1.query(
    `SELECT type, status, COUNT(*) AS count
     FROM tasks
     GROUP BY type, status
     ORDER BY type, status`
  );
  const recentTasks = await d1.query(
    `SELECT task_key, type, card_id, image, status, author, last_error, updated_at
     FROM tasks
     WHERE updated_at >= ?
     ORDER BY updated_at DESC
     LIMIT ?`,
    [sinceMs, limit]
  );
  const pendingTasks = await d1.query(
    `SELECT task_key, type, card_id, image, status, author, last_error, updated_at
     FROM tasks
     WHERE status IN ('pending', 'checking')
     ORDER BY updated_at ASC
     LIMIT 20`
  );
  return { logs, taskSummary, recentTasks, pendingTasks };
}

async function upsertAuthor(name, patch = {}) {
  const key = authorKey(name);
  if (!key) return;
  const current = await d1.query('SELECT * FROM authors WHERE author_key = ?', [key]);
  const row = current[0] || {};
  await d1.query(
    `INSERT OR REPLACE INTO authors(
      author_key, name, created_score, replacement_score, suggestion_score, inactive,
      last_profile_checked_at, last_suggestion_checked_at, last_suggestion_found_at,
      created_count, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      key,
      patch.name || row.name || name,
      patch.createdScore ?? row.created_score ?? 0,
      patch.replacementScore ?? row.replacement_score ?? 0,
      patch.suggestionScore ?? row.suggestion_score ?? 0,
      patch.inactive ?? row.inactive ?? 0,
      patch.lastProfileCheckedAt ?? row.last_profile_checked_at ?? 0,
      patch.lastSuggestionCheckedAt ?? row.last_suggestion_checked_at ?? 0,
      patch.lastSuggestionFoundAt ?? row.last_suggestion_found_at ?? 0,
      patch.createdCount ?? row.created_count ?? null,
      nowMs()
    ]
  );
}

async function bumpAuthorScore(name, type, amount = 1) {
  await upsertAuthor(name);
  const column = type === 'created' ? 'created_score' : type === 'replacement' ? 'replacement_score' : 'suggestion_score';
  await d1.query(`UPDATE authors SET ${column} = ${column} + ?, updated_at = ? WHERE author_key = ?`, [amount, nowMs(), authorKey(name)]);
}

async function getAuthorsForAuthorship(type, checkedKeys = []) {
  const rows = await d1.query(
    `SELECT * FROM authors
     ORDER BY ${type === 'created' ? 'created_score' : 'replacement_score'} DESC, name COLLATE NOCASE ASC`
  );
  const checked = new Set(checkedKeys);
  return rows.filter(row => !checked.has(row.author_key));
}

async function getAuthorsForSuggestions(limit = 50, now = nowMs(), ratedIntervalMs, zeroIntervalMs) {
  return d1.query(
    `SELECT * FROM authors
     WHERE inactive = 0
       AND (
         (suggestion_score > 0 AND last_suggestion_checked_at <= ?)
         OR
         (suggestion_score <= 0 AND last_suggestion_checked_at <= ?)
       )
     ORDER BY suggestion_score DESC, last_suggestion_checked_at ASC, name COLLATE NOCASE ASC
     LIMIT ?`,
    [now - ratedIntervalMs, now - zeroIntervalMs, limit]
  );
}

async function upsertCard(card, source, author = card.author || null) {
  const now = nowMs();
  const current = await d1.query('SELECT * FROM cards WHERE card_id = ?', [card.cardId]);
  const row = current[0] || {};
  await d1.query(
    `INSERT OR REPLACE INTO cards(
      card_id, author, name, rank, image, image_url, anime_name, anime_link, first_seen_source,
      seen_in_suggestion, seen_on_cards_page, last_seen_suggestion_at, last_seen_cards_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      card.cardId,
      author || row.author || null,
      card.name || row.name || null,
      card.rank || row.rank || null,
      card.image || row.image || null,
      card.imageUrl || row.image_url || null,
      card.animeName || row.anime_name || null,
      card.animeLink || row.anime_link || null,
      row.first_seen_source || source,
      source === 'suggestion' ? 1 : row.seen_in_suggestion || 0,
      source === 'cards_added' ? 1 : row.seen_on_cards_page || 0,
      source === 'suggestion' ? now : row.last_seen_suggestion_at || 0,
      source === 'cards_added' ? now : row.last_seen_cards_at || 0,
      now
    ]
  );
}

async function upsertSuggestion(card, author) {
  const existed = await d1.query('SELECT card_id FROM suggestions WHERE card_id = ?', [card.cardId]);
  await upsertCard(card, 'suggestion', author);
  await d1.query(
    `INSERT OR REPLACE INTO suggestions(
      card_id, author, name, rank, image, image_url, anime_name, anime_link, active, detected_at, last_seen_at
    ) VALUES(
      ?, ?, ?, ?, ?, ?, ?, ?, 1,
      COALESCE((SELECT detected_at FROM suggestions WHERE card_id = ?), ?),
      ?
    )`,
    [
      card.cardId, author, card.name, card.rank, card.image, card.imageUrl,
      card.animeName, card.animeLink, card.cardId, nowMs(), nowMs()
    ]
  );
  return existed.length === 0;
}

async function deactivateMissingSuggestions(author, activeCardIds) {
  const placeholders = activeCardIds.map(() => '?').join(',');
  const params = [authorKey(author)];
  const rows = await d1.query('SELECT name FROM authors WHERE author_key = ?', params);
  const displayName = rows[0]?.name || author;
  if (!activeCardIds.length) {
    await d1.query('UPDATE suggestions SET active = 0 WHERE author = ?', [displayName]);
    return;
  }
  await d1.query(
    `UPDATE suggestions SET active = 0 WHERE author = ? AND card_id NOT IN (${placeholders})`,
    [displayName, ...activeCardIds]
  );
}

async function upsertTask(type, data) {
  const key = taskKey(type, data.cardId, data.newImage || data.image || '');
  const now = nowMs();
  await d1.query(
    `INSERT INTO tasks(task_key, type, card_id, image, status, created_at, updated_at)
     VALUES(?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(task_key) DO UPDATE SET updated_at = excluded.updated_at`,
    [key, type, data.cardId, data.newImage || data.image || '', now, now]
  );
  return key;
}

async function getPendingTasks(limit = 10) {
  return d1.query(
    `SELECT * FROM tasks WHERE status IN ('pending', 'checking')
     ORDER BY CASE type WHEN 'created' THEN 1 WHEN 'replacement' THEN 2 ELSE 3 END, updated_at ASC
     LIMIT ?`,
    [limit]
  );
}

async function updateTask(taskKeyValue, patch) {
  const current = await d1.query('SELECT * FROM tasks WHERE task_key = ?', [taskKeyValue]);
  const row = current[0];
  if (!row) return;
  await d1.query(
    `UPDATE tasks SET status = ?, author = ?, checked_authors_json = ?, last_error = ?, updated_at = ? WHERE task_key = ?`,
    [
      patch.status ?? row.status,
      patch.author ?? row.author,
      patch.checkedAuthorsJson ?? row.checked_authors_json ?? '[]',
      patch.lastError ?? row.last_error,
      nowMs(),
      taskKeyValue
    ]
  );
}

async function getResults(keys) {
  if (!keys.length) return [];
  const placeholders = keys.map(() => '?').join(',');
  return d1.query(
    `SELECT task_key, type, card_id, image, status, author FROM tasks WHERE task_key IN (${placeholders})`,
    keys
  );
}

async function getSuggestions({ rank = '', limit = 60, offset = 0 }) {
  const params = [];
  let where = 'active = 1';
  if (rank) {
    where += ' AND rank = ?';
    params.push(rank);
  }
  params.push(limit, offset);
  return d1.query(
    `SELECT * FROM suggestions WHERE ${where} ORDER BY CAST(card_id AS INTEGER) DESC LIMIT ? OFFSET ?`,
    params
  );
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

  await logEvent('info', 'cards-monitor', 'cards page parsed', {
    addedCards: parsed.addedCards.length,
    replacements: parsed.replacements.length,
    visibleAuthors: parsed.visibleAuthors.length
  });
  return {
    ok: true,
    addedCards: parsed.addedCards.length,
    replacements: parsed.replacements.length,
    visibleAuthors: parsed.visibleAuthors.length
  };
}

async function processOneAuthorshipTask() {
  const tasks = await getPendingTasks(1);
  const task = tasks[0];
  if (!task) return false;

  const checked = new Set(JSON.parse(task.checked_authors_json || '[]'));
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

  await upsertAuthor(authorName, { lastSuggestionCheckedAt: nowMs() });
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

  if (newCount) {
    await bumpAuthorScore(authorName, 'suggestion', newCount);
    await upsertAuthor(authorName, { lastSuggestionFoundAt: nowMs() });
  }
}

async function decaySuggestionScores() {
  const cutoff = nowMs() - config.suggestionDecayDays * 24 * 60 * 60 * 1000;
  const rows = await d1.query(
    'SELECT name FROM authors WHERE suggestion_score > 0 AND last_suggestion_found_at > 0 AND last_suggestion_found_at < ?',
    [cutoff]
  );
  for (const row of rows) {
    await upsertAuthor(row.name, { suggestionScore: 0 });
  }
}

async function checkInactiveAuthors(limit = 20) {
    const rows = await d1.query(
    'SELECT * FROM authors WHERE last_profile_checked_at <= ? ORDER BY last_profile_checked_at ASC LIMIT ?',
    [nowMs() - config.inactiveScanIntervalMs, limit]
  );
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
  lastTickStatus
}));

app.get('/health', async () => ({ ok: true, service: 'anime-cards-server' }));

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
  return { ok: true, running: tickRunning, currentTickStep, lastTickStatus };
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
  const limit = Math.min(Number(request.query?.limit || 100), 500);
  const rows = await d1.query(
    `SELECT name, created_score, replacement_score, suggestion_score, inactive
     FROM authors
     ORDER BY (created_score + replacement_score + suggestion_score) DESC, suggestion_score DESC, name COLLATE NOCASE ASC
     LIMIT ?`,
    [limit]
  );
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
  console.log(`[auto-tick] enabled, interval ${intervalMs}ms`);
}

startAutoTick();

app.listen({ port: config.port, host: '0.0.0.0' });
