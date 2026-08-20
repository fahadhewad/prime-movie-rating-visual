/**
 * Local dataset provider: queries the imported IMDb dump in IndexedDB.
 *
 * No network, no rate limit, no terms-of-service question about scraping - the
 * dumps are published for exactly this kind of personal use. Costs one indexed
 * getAll per distinct title, which is sub-millisecond.
 */

import { findByKey, getMeta } from '../../db/idb.js';
import { makeQuery, pickBest } from '../../shared/match.js';
import { SOURCE } from '../../shared/constants.js';

let metaCache = null;

export async function datasetReady() {
  if (metaCache === null) {
    metaCache = (await getMeta('dataset')) || false;
  }
  return Boolean(metaCache && metaCache.storedTitles > 0);
}

/** Called after an import so the worker stops using a stale answer. */
export function invalidateDatasetMeta() {
  metaCache = null;
}

export async function datasetMeta() {
  metaCache = null;
  return (await getMeta('dataset')) || null;
}

/**
 * @param {{title: string, year: number|null, season: number|null}} request
 * @returns {Promise<object|null>} best match with confidence, or null
 */
export async function lookupDataset(request) {
  const query = makeQuery(request);
  if (!query.strict) return null;

  let candidates = await findByKey(query.strict);
  // Fall back to the forgiving key only when the exact one finds nothing.
  if (!candidates.length && query.loose && query.loose !== query.strict) {
    candidates = await findByKey(query.loose);
  }
  const best = pickBest(candidates, query);
  if (!best) return null;

  return {
    rating: best.record.r,
    votes: best.record.v,
    confidence: best.confidence,
    source: SOURCE.DATASET,
    id: best.record.id,
    year: best.record.y,
    type: best.record.ty,
    matchedTitle: best.record.t,
    candidateCount: best.candidateCount,
  };
}
