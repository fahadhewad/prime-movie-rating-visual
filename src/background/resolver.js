/**
 * Resolution chain: cache -> local dataset -> OMDb -> negative cache.
 *
 * Also collapses concurrent duplicate requests. A storefront page can show the
 * same title in three carousels; without this they would each fire a lookup.
 */

import { LookupCache } from '../shared/cache.js';
import { SOURCE, STORAGE_KEYS } from '../shared/constants.js';
import { cacheKey } from '../shared/normalise.js';
import { datasetReady, lookupDataset } from './providers/dataset.js';
import { lookupOmdb } from './providers/omdb.js';

export const cache = new LookupCache({
  storage: {
    load: async () => (await chrome.storage.local.get(STORAGE_KEYS.cache))[STORAGE_KEYS.cache] || {},
    save: async (data) => chrome.storage.local.set({ [STORAGE_KEYS.cache]: data }),
  },
});

const pending = new Map();

function toEntry(result) {
  return {
    r: result.rating,
    v: result.votes,
    c: result.confidence,
    s: result.source,
    id: result.id,
    y: result.year,
    ty: result.type,
    mt: result.matchedTitle,
  };
}

function fromEntry(entry, key) {
  if (!entry || entry.miss) return { key, rating: null, miss: true };
  return {
    key,
    rating: entry.r,
    votes: entry.v,
    confidence: entry.c,
    source: entry.s,
    id: entry.id,
    year: entry.y,
    type: entry.ty,
    matchedTitle: entry.mt,
  };
}

async function resolveUncached(request, settings) {
  if (settings.provider !== 'omdb' && (await datasetReady())) {
    const hit = await lookupDataset(request);
    if (hit) return hit;
  }
  if (settings.omdbApiKey) {
    const hit = await lookupOmdb(request, {
      apiKey: settings.omdbApiKey,
      dailyLimit: settings.omdbDailyLimit,
    });
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve one tile. `request` is { title, year, season, asin }.
 */
export async function resolveOne(request, settings) {
  await cache.load();
  cache.configure(settings);

  const key = cacheKey(request);
  const cached = cache.get(key);
  if (cached) return { ...fromEntry(cached, key), source: cached.miss ? undefined : SOURCE.CACHE, cached: true };

  if (pending.has(key)) return pending.get(key);

  const job = (async () => {
    try {
      const result = await resolveUncached(request, settings);
      if (!result) {
        cache.setMiss(key);
        return { key, rating: null, miss: true };
      }
      cache.set(key, toEntry(result));
      return { key, ...result };
    } catch (error) {
      // Do not cache infrastructure failures as misses - they are not answers.
      return { key, rating: null, miss: true, error: String(error?.message || error), transient: true };
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, job);
  return job;
}

/** Resolve a batch, which is how the content script always asks. */
export async function resolveBatch(requests, settings) {
  return Promise.all(requests.map((request) => resolveOne(request, settings)));
}
