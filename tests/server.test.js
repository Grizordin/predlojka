import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as cheerio from 'cheerio';
import { deflate, inflate } from 'node:zlib';
import { promisify } from 'node:util';
import * as scheduling from '../adaptive-scheduler.js';

const source = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 9, 12, 7);
const makeRow = (name, extra = {}) => ({ author_key: name.toLowerCase(), name,
  suggestion_score: 0, created_score: 0, replacement_score: 0, inactive: 0,
  last_suggestion_checked_at: 0, last_suggestion_found_at: 0, updated_at: NOW, ...extra });

async function harness(rows = [makeRow('Author')]) {
  let now = NOW;
  class Clock extends Date { static now() { return now; } }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const body = source.slice(0, source.lastIndexOf('\nstartAutoTick();'))
    .replace(/^import .*;\r?\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(new URL('../server.js', import.meta.url).href));
  const names = ['fs','Fastify','cors','cheerio','deflate','inflate','promisify',
    'AdaptiveScheduler','activityScore','MAX_INTERVAL','MINUTE','HOUR','DAY','Date','process','fetch'];
  const run = new AsyncFunction(...names, body + `
    return { app, runtime, anime, d1, config, monitorCardsPage, processSuggestionAuthors,
      processOneAuthorshipTask, applyAuthorSuggestions, persistAdaptiveState, ensureRuntimeState,
      persistRuntimeState, runTick, parseCardsPage, AnimeSSSClient, logEvent,
      get scheduler() { return adaptive; },
      setup(rows) {
        hydrateRuntime(rows, [], [], [], [], []);
        adaptive = new AdaptiveScheduler(rows, null, nowMs());
        adaptive.state.createdCoverage = {}; adaptive.state.taskEpoch = {};
        adaptive.state.sweepRetry = {};
      },
      setVisible(type, keys) {
        lastCatalogMonitorAt = nowMs();
        if (type === 'replacement') activeReplacementKeys = new Set(keys);
        else activeCreatedKeys = new Set(keys);
      },
      setUnloaded() { runtime.loaded = false; adaptive = null; }
    };
  `);
  const h = await run(fs, Fastify, cors, cheerio, deflate, inflate, promisify,
    scheduling.AdaptiveScheduler, scheduling.activityScore, scheduling.MAX_INTERVAL,
    scheduling.MINUTE, scheduling.HOUR, scheduling.DAY, Clock,
    { env: { ADMIN_TOKEN: 'test-token' } }, () => { throw new Error('Live network forbidden in tests'); });
  h.setup(rows);
  h.writes = [];
  h.d1.query = async (sql, params = []) => { h.writes.push({ sql, params }); return []; };
  h.time = value => { now = value; };
  h.anime.fetchHtml = async () => { throw new Error('Unexpected page request'); };
  return h;
}

function task(key, type, extra = {}) {
  return { task_key: key, type, card_id: key.split('|')[0],
    image: key.split('|')[1] || '', status: 'pending', created_at: NOW - 1000,
    updated_at: NOW - 1000, checked_authors_json: '[]', ...extra };
}
const card = (id, author = 'Author') => ({ cardId: id, author, image: '/'+id+'.png', name: 'Card', rank: 'a' });

test('catalog parser excludes votes and replacements, wakes inactive once', async () => {
  const h = await harness([makeRow('Author', { inactive: 1 })]);
  const html = '<html><body><div class="anime-cards__item" data-id="123" data-author="Author"><img src="/123.png"></div></body></html>';
  h.anime.fetchHtml = async () => html;
  await h.monitorCardsPage();
  assert.equal(h.runtime.authors.get('author').inactive, 0);
  assert.equal(h.scheduler.state.authors.author.suggestion.due, NOW);
  assert.equal(h.scheduler.state.authors.author.suggestion.days['2026-10-12'], 1);
  const writes = h.writes.length;
  h.time(NOW + 60000);
  await h.monitorCardsPage();
  assert.equal(h.scheduler.state.authors.author.boostUntil, NOW + scheduling.DAY);
  assert.equal(h.writes.length, writes, 'unchanged monitor must not write to D1');
  await h.app.close();
});

test('published known moderation card wakes author but earns no double score', async () => {
  const h = await harness([makeRow('Author', { inactive: 1 })]);
  h.runtime.cards.set('123', { card_id: '123', author: 'Author' });
  h.anime.fetchHtml = async () => '<html><body><div class="anime-cards__item" data-id="123" data-author="Author"><img src="/123.png"></div></body></html>';
  await h.monitorCardsPage();
  assert.equal(h.runtime.authors.get('author').inactive, 0);
  assert.deepEqual(h.scheduler.state.authors.author.suggestion.days, {});
  await h.app.close();
});

test('single replacement page resolves multiple tasks with one request', async () => {
  const h = await harness();
  const a = task('1|/new1.png', 'replacement'), b = task('2|/new2.png', 'replacement');
  h.runtime.tasks.set(a.task_key, a); h.runtime.tasks.set(b.task_key, b);
  h.setVisible('replacement', [a.task_key, b.task_key]);
  let requests = 0;
  h.anime.fetchHtml = async () => { requests++; return '<html><body><div class="card-replacement" data-id="1" data-image="/new1.png"></div><div class="card-replacement" data-id="2" data-image="/new2.png"></div></body></html>'; };
  await h.processOneAuthorshipTask();
  assert.equal(requests, 1);
  assert.equal(h.runtime.tasks.get(a.task_key).status, 'found');
  assert.equal(h.runtime.tasks.get(b.task_key).status, 'found');
  assert.equal(h.runtime.authors.get('author').replacement_score, 2);
  await h.app.close();
});

test('failed request does not count as checked and retries same author later', async () => {
  const h = await harness();
  const a = task('1|/new.png', 'replacement');
  h.runtime.tasks.set(a.task_key, a); h.setVisible('replacement', [a.task_key]);
  h.anime.fetchHtml = async () => { throw new Error('HTTP 502'); };
  await h.processOneAuthorshipTask();
  assert.equal(h.scheduler.state.authors.author.replacement.lastSuccess, 0);
  assert.equal(h.runtime.tasks.get(a.task_key).status, 'pending');
  assert.equal(h.runtime.tasks.get(a.task_key).checked_authors_json, '[]');
  h.time(NOW + 61000);
  h.anime.fetchHtml = async () => '<html><body><div class="card-replacement" data-id="1" data-image="/new.png"></div></body></html>';
  await h.processOneAuthorshipTask();
  assert.equal(h.runtime.tasks.get(a.task_key).status, 'found');
  await h.app.close();
});

test('old S tasks are dormant without a voting block, retained and work when block returns', async () => {
  const h = await harness();
  const a = task('123', 'created');
  h.runtime.tasks.set(a.task_key, a);
  assert.equal(await h.processOneAuthorshipTask(), false);
  assert.ok(h.runtime.tasks.has(a.task_key));
  h.setVisible('created', [a.task_key]);
  h.anime.fetchHtml = async () => '<html><body><div class="anime-cards__item" data-id="123"><img src="/123.png"></div></body></html>';
  await h.processOneAuthorshipTask();
  assert.equal(h.runtime.tasks.get(a.task_key).status, 'found');
  assert.equal(h.runtime.suggestions.has('123'), true);
  await h.app.close();
});

test('unchanged suggestions cost no D1 writes per author and create no phantom S tasks', async () => {
  const h = await harness();
  await h.applyAuthorSuggestions('Author', [card('123')], NOW);
  assert.equal(h.runtime.tasks.size, 0);
  const writes = h.writes.length;
  h.time(NOW + 600000);
  await h.applyAuthorSuggestions('Author', [card('123')], NOW + 600000);
  assert.equal(h.writes.length, writes);
  assert.equal(h.scheduler.state.authors.author.suggestion.days['2026-10-12'], 1);
  await h.app.close();
});

test('compressed checkpoint is one write, unchanged save skipped, schedule restored', async () => {
  const h = await harness();
  await h.persistAdaptiveState();
  const saved = h.writes.at(-1);
  assert.match(saved.sql, /adaptive_authors_v1/);
  const wrapper = JSON.parse(saved.params[0]);
  const state = JSON.parse((await promisify(inflate)(Buffer.from(wrapper.data, 'base64'))).toString());
  assert.equal(state.version, 1);
  const writes = h.writes.length;
  await h.persistAdaptiveState();
  assert.equal(h.writes.length, writes);
  const restored = new scheduling.AdaptiveScheduler([...h.runtime.authors.values()], state, NOW + 100000);
  assert.deepEqual(restored.state.authors, h.scheduler.state.authors);
  await h.app.close();
});

test('full export requires token, has no 500 cap, does not query D1 when loaded', async () => {
  const rows = Array.from({ length: 1075 }, (_, i) => makeRow('A' + i));
  const h = await harness(rows);
  const rejected = await h.app.inject({ method: 'GET', url: '/api/admin/authors' });
  assert.equal(rejected.statusCode, 401);
  const accepted = await h.app.inject({ method: 'GET', url: '/api/admin/authors', headers: { 'x-admin-token': 'test-token' } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().authors.length, 1075);
  assert.equal(h.writes.length, 0);
  assert.equal(accepted.headers['cache-control'], 'no-store');
  await h.app.close();
});

test('bootstrap from old D1 data writes adaptive state once, reload restores exact slots', async () => {
  const h = await harness();
  h.setUnloaded();
  const rows = [makeRow('Author', { inactive: 1 })];
  let payload = null, writes = 0, reads = 0;
  h.d1.query = async (sql, params = []) => {
    if (sql === 'SELECT * FROM authors') { reads++; return rows; }
    if (sql.startsWith('SELECT')) {
      reads++;
      if (sql.includes("key = 'adaptive_authors_v1'") && payload) return [{ value: payload }];
      return [];
    }
    if (sql.includes('adaptive_authors_v1')) { writes++; payload = params[0]; }
    return [];
  };
  await h.ensureRuntimeState();
  const due = h.scheduler.state.authors.author.suggestion.due;
  assert.equal(writes, 1);
  assert.equal(reads, 7);
  await h.ensureRuntimeState();
  assert.equal(reads, 7, 'no re-reading D1 for each tick');
  h.setUnloaded(); h.time(NOW + 100000);
  await h.ensureRuntimeState();
  assert.equal(h.scheduler.state.authors.author.suggestion.due, due);
  assert.equal(writes, 1);
  await h.app.close();
});

test('corrupt state fails closed rather than resetting the entire schedule', async () => {
  const h = await harness();
  h.setUnloaded();
  h.d1.query = async sql => sql.includes("key = 'adaptive_authors_v1'")
    ? [{ value: '{broken' }] : sql === 'SELECT * FROM authors' ? [makeRow('Author')] : [];
  await assert.rejects(h.ensureRuntimeState());
  assert.equal(h.runtime.loaded, false);
  await h.app.close();
});

test('AnimeSSS page requests are serialized; HTTP failure backs off; challenge is not empty data', async () => {
  const h = await harness();
  const client = new h.AnimeSSSClient();
  let current = 0, peak = 0;
  client.fetchHtmlInternal = async () => {
    current++; peak = Math.max(peak, current);
    await new Promise(resolve => setTimeout(resolve, 5));
    current--; return '<html><body>valid</body></html>';
  };
  await Promise.all([client.fetchHtml('/a'), client.fetchHtml('/b')]);
  assert.equal(peak, 1);
  client.fetchHtmlInternal = async () => '<html><body>Checking your browser</body></html>';
  await assert.rejects(client.fetchHtml('/a'), /unrecognized/);
  assert.ok(client.cooldownUntil > NOW);
  await assert.rejects(client.fetchHtml('/b'), /cooldown/);
  await h.app.close();
});

test('not-found replacement is retried after 12h, never immediately', async () => {
  const h = await harness();
  const a = task('1|/new.png', 'replacement', { status: 'not_found', updated_at: NOW });
  h.runtime.tasks.set(a.task_key, a); h.setVisible('replacement', [a.task_key]);
  assert.equal(await h.processOneAuthorshipTask(), false);
  h.time(NOW + scheduling.MAX_INTERVAL + 1);
  h.setVisible('replacement', [a.task_key]);
  h.anime.fetchHtml = async () => '<html><body><div class="card-replacement" data-id="1" data-image="/new.png"></div></body></html>';
  await h.processOneAuthorshipTask();
  assert.equal(h.runtime.tasks.get(a.task_key).status, 'found');
  await h.app.close();
});

test('repeat identical warning stays in memory but writes to D1 at most once per five minutes', async () => {
  const h = await harness();
  for (let i = 0; i < 20; i++) await h.logEvent('warn', 'suggestions', 'HTTP 502');
  assert.equal(h.writes.length, 1);
  assert.equal(h.runtime.logs.length, 20);
  await h.app.close();
});
