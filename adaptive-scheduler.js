// Pure scheduling logic. No network, credentials, or database side effects.
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const MAX_INTERVAL = 12 * HOUR;
const finite = (x, fallback = 0) => Number.isFinite(Number(x)) ? Number(x) : fallback;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const dayKey = now => new Date(now).toISOString().slice(0, 10);

export function activityScore(lane, now, startedAt) {
  let volume = 0, days = 0;
  const today = Date.parse(dayKey(now));
  for (const [key, count] of Object.entries(lane.days || {})) {
    const age = today - Date.parse(key);
    if (age >= 0 && age < 14 * DAY) volume += finite(count);
    if (age >= 0 && age < 7 * DAY && count > 0) days++;
  }
  const recent = (60 * Math.min(1, Math.log1p(volume) / Math.log(101)) + 40 * days / 7)
    * Math.pow(2, -Math.max(0, now - finite(lane.lastNew, now)) / (7 * DAY));
  // Historical totals are only a bounded, temporary starting estimate.
  const prior = clamp(15 * Math.log2(1 + Math.max(0, finite(lane.prior)) / 5), 0, 60)
    * (lane.priorAt > 0 ? Math.pow(2, -Math.max(0, now - lane.priorAt) / (7 * DAY)) : 0)
    * clamp(1 - (now - startedAt) / (14 * DAY), 0, 1);
  return clamp(Math.max(recent, prior), 0, 100);
}

export function intervalForScore(score) {
  return MAX_INTERVAL / (1 + 71 * Math.pow(clamp(score, 0, 100) / 100, 2));
}

export function distributeRates(scores, budgetPerHour) {
  const baseline = scores.length / 12;
  const desired = scores.map(score => HOUR / intervalForScore(score));
  const extra = desired.reduce((sum, rate) => sum + rate - 1 / 12, 0);
  const scale = extra ? clamp((budgetPerHour - baseline) / extra, 0, 1) : 1;
  return {
    baseline, scale, insufficient: budgetPerHour < baseline,
    intervals: desired.map(rate => HOUR / (1 / 12 + (rate - 1 / 12) * scale))
  };
}

function freshLane(prior = 0, priorAt = 0) {
  return { days: {}, lastNew: 0, prior, priorAt, lastSuccess: 0,
    due: 0, deadline: 0, retryAt: 0, failures: 0, bootstrap: true };
}

export class AdaptiveScheduler {
  constructor(rows, saved = null, now = Date.now(), options = {}) {
    if (saved && saved.version !== 1) throw new Error('Unsupported adaptive scheduler state');
    this.budget = Math.max(1, finite(options.budget, 600));
    this.replacementBudget = Math.max(1, finite(options.replacementBudget, 300));
    this.dutyCycle = clamp(finite(options.dutyCycle, 1), 0.01, 1);
    this.state = saved || { version: 1, startedAt: now, authors: {}, catalogSeen: {},
      eventSeen: {}, nextSuggestionAt: 0, nextReplacementAt: 0 };
    this.state.authors = Object.assign(Object.create(null), this.state.authors || {});
    this.state.catalogSeen ||= {};
    this.state.eventSeen ||= {};
    this.revision = 0;
    const ordered = [...rows].sort((a, b) => a.author_key.localeCompare(b.author_key));
    for (let i = 0; i < ordered.length; i++) {
      const row = ordered[i];
      if (this.state.authors[row.author_key]) continue;
      const s = freshLane(finite(row.suggestion_score), finite(row.last_suggestion_found_at));
      const r = freshLane(finite(row.replacement_score), finite(row.updated_at));
      const interval = row.inactive ? MAX_INTERVAL : intervalForScore(activityScore(s, now, this.state.startedAt));
      // One-time migration grace: spread old/unknown checks instead of starting a burst.
      s.due = now + (i + 0.5) / Math.max(1, ordered.length) * interval;
      s.deadline = now + (i + 0.5) / Math.max(1, ordered.length) * MAX_INTERVAL;
      this.state.authors[row.author_key] = { suggestion: s, replacement: r, boostUntil: 0 };
      this.touch();
    }
  }

  touch() { this.revision++; }

  addAuthor(key, now) {
    if (this.state.authors[key]) return this.state.authors[key];
    const entry = { suggestion: freshLane(), replacement: freshLane(), boostUntil: now + DAY };
    entry.suggestion.due = now;
    entry.suggestion.deadline = now + MAX_INTERVAL;
    this.state.authors[key] = entry;
    this.touch();
    return entry;
  }

  wake(key, now) {
    const entry = this.addAuthor(key, now);
    entry.boostUntil = now + DAY;
    entry.suggestion.due = Math.min(entry.suggestion.due, now);
    // Never erase an outstanding retry/backoff or extend the hard deadline.
    this.touch();
  }

  observe(key, kind, ids, now) {
    const entry = this.addAuthor(key, now);
    const lane = entry[kind];
    let count = 0;
    for (const id of new Set(ids.map(String))) {
      const token = kind + ':' + id;
      if (Object.hasOwn(this.state.eventSeen, token)) continue;
      this.state.eventSeen[token] = now;
      count++;
    }
    if (count) {
      lane.days[dayKey(now)] = finite(lane.days[dayKey(now)]) + count;
      lane.lastNew = now;
      for (const key of Object.keys(lane.days)) {
        if (Date.parse(key) < Date.parse(dayKey(now)) - 13 * DAY) delete lane.days[key];
      }
      this.touch();
    }
    return count;
  }

  seedEvents(cardIds, replacementKeys) {
    for (const [kind, ids] of [['suggestion', cardIds], ['replacement', replacementKeys]]) {
      for (const id of ids) {
        const token = kind + ':' + id;
        if (!Object.hasOwn(this.state.eventSeen, token)) {
          this.state.eventSeen[token] = 0;
          this.touch();
        }
      }
    }
  }

  catalogIsNew(cardId) {
    if (this.state.catalogSeen[String(cardId)]) return false;
    this.state.catalogSeen[String(cardId)] = true;
    this.touch();
    return true;
  }

  plan(rows, now, update = true) {
    const scores = rows.map(row => {
      const entry = this.addAuthor(row.author_key, now);
      if (row.inactive && entry.boostUntil <= now) return 0;
      const score = activityScore(entry.suggestion, now, this.state.startedAt);
      return entry.boostUntil > now ? Math.max(score, 57) : score;
    });
    // A 35s work window every minute cannot spend a full hour's paced budget.
    // Scale desired frequency to that conservative capacity, not the nominal ceiling.
    const allocation = distributeRates(scores, this.budget * this.dutyCycle);
    const planned = rows.map((row, i) => {
      const entry = this.state.authors[row.author_key];
      const lane = entry.suggestion;
      const interval = allocation.intervals[i];
      // Recalculation can bring work forward, never postpone an already saved due time.
      if (update && !lane.bootstrap && lane.lastSuccess) {
        const due = Math.min(lane.due, lane.lastSuccess + interval, lane.deadline);
        if (due !== lane.due) { lane.due = due; this.touch(); }
      }
      return { row, entry, lane, score: scores[i], interval };
    });
    return { ...allocation, planned };
  }

  nextSuggestion(rows, now) {
    if (now < finite(this.state.nextSuggestionAt)) return null;
    const { planned } = this.plan(rows, now);
    return planned.filter(x => x.lane.due <= now && x.lane.retryAt <= now)
      .sort((a, b) => {
        const overdueA = a.lane.deadline <= now, overdueB = b.lane.deadline <= now;
        return Number(overdueB) - Number(overdueA)
          || (overdueA ? a.lane.deadline - b.lane.deadline : a.lane.due - b.lane.due)
          || b.score - a.score;
      })[0] || null;
  }

  reserve(kind, now) {
    const key = kind === 'suggestion' ? 'nextSuggestionAt' : 'nextReplacementAt';
    const budget = kind === 'suggestion' ? this.budget : this.replacementBudget;
    this.state[key] = now + HOUR / budget;
    this.touch();
  }

  success(key, kind, now, interval = MAX_INTERVAL) {
    const lane = this.addAuthor(key, now)[kind];
    lane.lastSuccess = now;
    lane.due = now + Math.min(MAX_INTERVAL, interval);
    lane.deadline = now + MAX_INTERVAL;
    lane.retryAt = 0;
    lane.failures = 0;
    lane.bootstrap = false;
    this.touch();
  }

  failure(key, kind, now) {
    const lane = this.addAuthor(key, now)[kind];
    lane.failures++;
    lane.retryAt = now + Math.min(HOUR, MINUTE * Math.pow(2, Math.min(6, lane.failures - 1)));
    this.touch(); // Last success, deadline, and task coverage are deliberately unchanged.
  }

  report(rows, now) {
    const { planned, baseline, insufficient, scale } = this.plan(rows, now, false);
    return { version: 1, generatedAt: now, baselineRequestsPerHour: baseline,
      suggestionBudgetPerHour: this.budget, replacementBudgetPerHour: this.replacementBudget,
      estimatedSuggestionCapacityPerHour: this.budget * this.dutyCycle,
      capacityInsufficient: insufficient, extraFrequencyScale: scale,
      overdue: planned.filter(x => x.lane.deadline <= now).length,
      authors: planned.map(x => ({ ...x.row, adaptive_score: x.score,
        replacement_activity_score: activityScore(x.entry.replacement, now, this.state.startedAt),
        interval_ms: x.interval, next_check_at: x.lane.due, deadline_at: x.lane.deadline,
        last_success_at: x.lane.lastSuccess, retry_at: x.lane.retryAt,
        consecutive_errors: x.lane.failures, initial_spread: x.lane.bootstrap }))
    };
  }
}
