/**
 * OMDb provider: one HTTP call per title.
 *
 * The free tier is ~1000 lookups/day, which a couple of storefront pages can
 * chew through, so this keeps its own daily budget and refuses to spend past it
 * rather than getting itself throttled. Concurrency is capped at 2: OMDb is a
 * small service and a carousel can ask for forty titles at once.
 */

import { SOURCE, STORAGE_KEYS } from '../../shared/constants.js';

const ENDPOINT = 'https://www.omdbapi.com/';
const MAX_CONCURRENT = 2;

let inFlight = 0;
const queue = [];

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/** Budget lives in storage so it survives worker restarts, and resets at UTC midnight. */
async function readBudget() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.omdbBudget);
  const budget = stored[STORAGE_KEYS.omdbBudget];
  if (!budget || budget.date !== todayUtc()) return { date: todayUtc(), used: 0, exhausted: false };
  return budget;
}

async function writeBudget(budget) {
  await chrome.storage.local.set({ [STORAGE_KEYS.omdbBudget]: budget });
}

export async function omdbStatus() {
  return readBudget();
}

async function spend(limit) {
  const budget = await readBudget();
  if (budget.exhausted || budget.used >= limit) return null;
  budget.used += 1;
  await writeBudget(budget);
  return budget;
}

/**
 * A request that never got an answer out of OMDb.
 *
 * Distinct from "not found" on purpose: the resolver negative-caches a null for
 * days, which is right for a title OMDb genuinely does not have and very wrong
 * for a dropped connection.
 */
export class TransientOmdbError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransientOmdbError';
    this.transient = true;
  }
}

/**
 * Give back a lookup that never reached the API.
 *
 * The budget is spent before the request goes out, so without this a flaky
 * connection burns the whole daily allowance without returning one rating.
 */
async function refund() {
  const budget = await readBudget();
  if (budget.used > 0) {
    budget.used -= 1;
    await writeBudget(budget);
  }
}

/** Mark the key as spent for the rest of the UTC day. */
async function markExhausted(reason) {
  const budget = await readBudget();
  budget.exhausted = true;
  budget.reason = reason;
  await writeBudget(budget);
}

function runQueued() {
  while (inFlight < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    inFlight += 1;
    job().finally(() => {
      inFlight -= 1;
      runQueued();
    });
  }
}

function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject));
    runQueued();
  });
}

function parseVotes(raw) {
  if (typeof raw !== 'string') return 0;
  const n = Number.parseInt(raw.replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Confidence for an OMDb hit. OMDb resolves the title itself, so we can only
 * check its answer against what we asked for.
 */
function confidenceFor(payload, request) {
  let confidence = 0.55;
  const year = Number.parseInt(String(payload.Year || '').slice(0, 4), 10);
  if (request.year && Number.isFinite(year)) {
    const delta = Math.abs(year - request.year);
    if (delta === 0) confidence += 0.35;
    else if (delta <= 1) confidence += 0.2;
    else confidence -= 0.3;
  }
  if (parseVotes(payload.imdbVotes) >= 5000) confidence += 0.1;
  return Math.max(0, Math.min(1, confidence));
}

/**
 * @returns {Promise<object|null>} rating, or null when unknown / out of budget
 */
export async function lookupOmdb(request, { apiKey, dailyLimit }) {
  if (!apiKey) return null;
  if (!(await spend(dailyLimit))) return null;

  return schedule(async () => {
    const url = new URL(ENDPOINT);
    url.searchParams.set('apikey', apiKey);
    url.searchParams.set('t', request.title);
    if (request.year) url.searchParams.set('y', String(request.year));
    if (request.season != null) url.searchParams.set('type', 'series');

    let response;
    try {
      response = await fetch(url, { credentials: 'omit' });
    } catch (error) {
      await refund();
      throw new TransientOmdbError(`network error: ${error?.message || error}`);
    }
    if (response.status === 401) {
      await markExhausted('invalid key');
      return null;
    }
    // Server-side trouble says nothing about the title; do not spend or cache it.
    if (response.status >= 500 || response.status === 429) {
      await refund();
      throw new TransientOmdbError(`OMDb responded ${response.status}`);
    }
    if (!response.ok) return null;

    const payload = await response.json().catch(() => null);
    if (!payload) {
      await refund();
      throw new TransientOmdbError('malformed response body');
    }

    if (payload.Response === 'False') {
      // OMDb reports quota exhaustion in the same envelope as "not found".
      if (/limit reached/i.test(payload.Error || '')) await markExhausted(payload.Error);
      return null;
    }

    const rating = Number.parseFloat(payload.imdbRating);
    if (!Number.isFinite(rating)) return null;

    return {
      rating,
      votes: parseVotes(payload.imdbVotes),
      confidence: confidenceFor(payload, request),
      source: SOURCE.OMDB,
      id: payload.imdbID || null,
      year: Number.parseInt(String(payload.Year || '').slice(0, 4), 10) || null,
      type: payload.Type || null,
      matchedTitle: payload.Title || request.title,
    };
  });
}
