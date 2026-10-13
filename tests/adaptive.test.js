import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveScheduler, activityScore, intervalForScore, distributeRates, MAX_INTERVAL, DAY, HOUR, MINUTE } from '../adaptive-scheduler.js';

const NOW = Date.UTC(2026, 9, 12, 7);
const row = (i, extra = {}) => ({ author_key: 'author-' + String(i).padStart(4, '0'),
  name: 'Author ' + i, inactive: 0, suggestion_score: 0, ...extra });
const clone = x => JSON.parse(JSON.stringify(x));

test('score combines volume and days, caps at 100 and decays with silence', () => {
  const lane = { days: {}, lastNew: NOW, prior: 0 };
  for (let d = 0; d < 7; d++) lane.days[new Date(NOW - d * DAY).toISOString().slice(0, 10)] = 15;
  assert.equal(activityScore(lane, NOW, NOW), 100);
  assert.ok(activityScore(lane, NOW + 7 * DAY, NOW) <= 50);
  assert.equal(activityScore(lane, NOW + 15 * DAY, NOW), 0);
  const once = { days: { '2026-10-12': 1000 }, lastNew: NOW };
  assert.ok(activityScore(once, NOW, NOW) < 66);
  assert.ok(activityScore({ days: { '2026-10-12': 20 }, lastNew: NOW }, NOW, NOW)
    > activityScore({ days: { '2026-10-12': 5 }, lastNew: NOW }, NOW, NOW));
});

test('historical prior fades out and never becomes a permanent high rank', () => {
  const lane = { days: {}, prior: 1664, priorAt: NOW };
  assert.equal(activityScore(lane, NOW, NOW), 60);
  assert.equal(activityScore(lane, NOW + 14 * DAY, NOW), 0);
  assert.equal(activityScore({ ...lane, priorAt: 0 }, NOW, NOW), 0);
});

test('interval limits and dynamic budget preserve the 12-hour floor', () => {
  assert.equal(intervalForScore(0), MAX_INTERVAL);
  assert.equal(intervalForScore(100), 10 * MINUTE);
  const result = distributeRates([...Array(163).fill(100), ...Array(912).fill(0)], 600);
  const rate = result.intervals.reduce((sum, ms) => sum + HOUR / ms, 0);
  assert.ok(Math.abs(rate - 600) < 0.00001);
  assert.ok(result.intervals.every(ms => ms <= MAX_INTERVAL && ms >= 10 * MINUTE));
  assert.equal(result.insufficient, false);
  assert.equal(distributeRates(Array(1075).fill(0), 50).insufficient, true);
});

test('172 inactive authors are evenly distributed, survive restart, never all start at once', () => {
  const authors = Array.from({ length: 172 }, (_, i) => row(i, { inactive: 1 }));
  const scheduler = new AdaptiveScheduler(authors, null, NOW);
  const deadlines = authors.map(x => scheduler.state.authors[x.author_key].suggestion.due);
  const bins = Array(12).fill(0);
  deadlines.forEach(due => bins[Math.floor((due - NOW) / HOUR)]++);
  assert.ok(bins.every(n => n >= 14 && n <= 15));
  assert.equal(scheduler.nextSuggestion(authors, NOW), null);
  const restarted = new AdaptiveScheduler(authors, clone(scheduler.state), NOW + HOUR);
  assert.deepEqual(restarted.state, scheduler.state);
});

test('new author / catalog wake brings work forward without erasing network backoff', () => {
  const authors = [row(1, { inactive: 1 })];
  const scheduler = new AdaptiveScheduler(authors, null, NOW);
  const key = authors[0].author_key;
  scheduler.failure(key, 'suggestion', NOW);
  scheduler.wake(key, NOW);
  assert.equal(scheduler.nextSuggestion(authors, NOW), null);
  assert.ok(scheduler.nextSuggestion(authors, NOW + MINUTE));
  assert.equal(scheduler.catalogIsNew('100'), true);
  assert.equal(scheduler.catalogIsNew('100'), false);
  assert.equal(scheduler.addAuthor('new', NOW).suggestion.due, NOW);
});

test('one unique card scores once, even after restart; old seeded IDs do not score', () => {
  const scheduler = new AdaptiveScheduler([row(1)], null, NOW);
  const key = row(1).author_key;
  scheduler.seedEvents(['old'], ['old-replacement']);
  assert.equal(scheduler.observe(key, 'suggestion', ['old'], NOW), 0);
  assert.equal(scheduler.observe(key, 'suggestion', ['new', 'new'], NOW), 1);
  const restarted = new AdaptiveScheduler([row(1)], clone(scheduler.state), NOW);
  assert.equal(restarted.observe(key, 'suggestion', ['new'], NOW), 0);
  assert.equal(restarted.observe(key, 'replacement', ['new'], NOW), 1);
});

test('errors do not advance success/deadline; exponential retry is capped', () => {
  const scheduler = new AdaptiveScheduler([row(1)], null, NOW);
  const key = row(1).author_key;
  scheduler.success(key, 'suggestion', NOW, 10 * MINUTE);
  const before = clone(scheduler.state.authors[key].suggestion);
  for (let i = 0; i < 20; i++) scheduler.failure(key, 'suggestion', NOW + MINUTE);
  const lane = scheduler.state.authors[key].suggestion;
  assert.equal(lane.lastSuccess, before.lastSuccess);
  assert.equal(lane.deadline, before.deadline);
  assert.ok(lane.retryAt <= NOW + MINUTE + HOUR);
  scheduler.success(key, 'suggestion', NOW + 2 * HOUR);
  assert.equal(lane.failures, 0);
});

test('replanning cannot postpone saved due time; overdue low score outranks recent high score', () => {
  const authors = [row(1), row(2, { suggestion_score: 1000, last_suggestion_found_at: NOW })];
  const scheduler = new AdaptiveScheduler(authors, null, NOW);
  scheduler.success(authors[0].author_key, 'suggestion', NOW - MAX_INTERVAL - 1);
  scheduler.success(authors[1].author_key, 'suggestion', NOW - HOUR, 10 * MINUTE);
  const due = scheduler.state.authors[authors[1].author_key].suggestion.due;
  scheduler.plan(authors, NOW + DAY);
  assert.ok(scheduler.state.authors[authors[1].author_key].suggestion.due <= due);
  assert.equal(scheduler.nextSuggestion(authors, NOW).row.author_key, authors[0].author_key);
});

test('reserved requests are paced with no catch-up burst', () => {
  const scheduler = new AdaptiveScheduler([row(1)], null, NOW);
  scheduler.wake(row(1).author_key, NOW);
  scheduler.reserve('suggestion', NOW);
  assert.equal(scheduler.nextSuggestion([row(1)], NOW + 5999), null);
  assert.ok(scheduler.nextSuggestion([row(1)], NOW + 6000));
});

test('simulate 1075 authors for 24 hours under a 35-second/minute duty cycle', () => {
  const authors = Array.from({ length: 1075 }, (_, i) => row(i, {
    inactive: i < 172 ? 1 : 0, suggestion_score: i >= 912 ? 1500 : 0,
    last_suggestion_found_at: i >= 912 ? NOW : 0
  }));
  const scheduler = new AdaptiveScheduler(authors, null, NOW);
  let calls = 0, maximumGap = 0;
  const seen = new Map();
  for (let time = NOW; time < NOW + DAY; time += 1000) {
    if ((time - NOW) % MINUTE >= 35000) continue;
    const next = scheduler.nextSuggestion(authors, time);
    if (!next) continue;
    if (seen.has(next.row.author_key)) maximumGap = Math.max(maximumGap, time - seen.get(next.row.author_key));
    seen.set(next.row.author_key, time);
    scheduler.reserve('suggestion', time);
    scheduler.success(next.row.author_key, 'suggestion', time, next.interval);
    calls++;
  }
  assert.equal(seen.size, 1075);
  assert.ok(calls <= 600 * 24);
  // Deadline delivery is subject to tick granularity and the one-request-at-a-time queue.
  assert.ok(maximumGap <= MAX_INTERVAL + MINUTE, 'gap: ' + maximumGap);
});
