/**
 * Candidate scoring and disambiguation.
 *
 * A storefront tile usually gives us a title and nothing else. "The Thing"
 * matches a 1982 classic, a 2011 prequel and a handful of obscure shorts. Rather
 * than silently picking the most popular row, we score every candidate, pick the
 * best, and report how sure we are - the caller fades the glow when confidence
 * is low, so an uncertain match looks uncertain instead of authoritative.
 *
 * Candidate records use the compact IndexedDB shape:
 *   { id, t: primaryTitle, o: originalTitle, y: year, ty: titleType, r: rating,
 *     v: numVotes, k: [normalised keys] }
 */

import { clamp01 } from './color.js';
import { looseKey, strictKey } from './normalise.js';

const SERIES_TYPES = new Set(['tvSeries', 'tvMiniSeries']);

/** Type preference when the tile looks like a series (it mentioned a season). */
const SERIES_TYPE_SCORE = {
  tvSeries: 2,
  tvMiniSeries: 2,
  tvSpecial: 0.2,
  tvMovie: -0.5,
  movie: -1.5,
  video: -1.5,
  short: -2,
};

/** Type preference otherwise. Prime shows films and series, rarely shorts. */
const DEFAULT_TYPE_SCORE = {
  movie: 1,
  tvMovie: 0.8,
  tvSeries: 0.6,
  tvMiniSeries: 0.6,
  tvSpecial: 0.2,
  video: 0.1,
  short: -0.5,
  tvEpisode: -3,
};

/** Build the query shape once, so scoring never re-normalises per candidate. */
export function makeQuery({ title, year = null, season = null }) {
  return {
    title,
    year: Number.isFinite(year) ? year : null,
    season: Number.isFinite(season) ? season : null,
    strict: strictKey(title),
    loose: looseKey(title),
  };
}

function yearScore(candidateYear, queryYear) {
  if (queryYear == null) return 0;
  if (candidateYear == null) return -0.5;
  const delta = Math.abs(candidateYear - queryYear);
  if (delta === 0) return 5;
  if (delta === 1) return 3.5;
  if (delta === 2) return 1.5;
  if (delta === 3) return 0;
  return -3;
}

function popularityScore(votes) {
  const v = Number(votes) || 0;
  if (v <= 0) return 0;
  return Math.min(2, Math.log10(v + 1) / 3);
}

/** How well one dataset row answers one tile. Higher is better. */
export function scoreCandidate(candidate, query) {
  const keys = candidate.k || [];
  let score = 0;
  let keyMatch = 'none';

  if (keys.includes(query.strict)) {
    score += 3;
    keyMatch = 'strict';
  } else if (keys.includes(query.loose)) {
    score += 1;
    keyMatch = 'loose';
  }

  score += yearScore(candidate.y ?? null, query.year);

  const table = query.season != null ? SERIES_TYPE_SCORE : DEFAULT_TYPE_SCORE;
  score += table[candidate.ty] ?? 0;

  score += popularityScore(candidate.v);

  return { score, keyMatch };
}

/**
 * Confidence in [0,1], built from interpretable parts rather than a squashed
 * score, so the thresholds in settings mean something to a human.
 */
export function confidenceFor({ keyMatch, candidate, query, margin, candidateCount }) {
  let confidence = 0.15;

  if (keyMatch === 'strict') confidence += 0.3;
  else if (keyMatch === 'loose') confidence += 0.12;

  if (query.year != null && candidate.y != null) {
    const delta = Math.abs(candidate.y - query.year);
    if (delta === 0) confidence += 0.4;
    else if (delta <= 1) confidence += 0.28;
    else if (delta <= 2) confidence += 0.1;
    else confidence -= 0.25;
  } else if (candidateCount === 1) {
    // No year to check, but nothing else claims this title either.
    confidence += 0.05;
  }

  // A clear winner is worth as much as a year check; a photo finish is not.
  confidence += candidateCount === 1 ? 0.25 : clamp01(margin / 4) * 0.25;

  if ((Number(candidate.v) || 0) >= 5000) confidence += 0.05;

  return clamp01(confidence);
}

/**
 * Pick the best candidate for a query.
 *
 * Returns null when nothing scores above the floor - better no glow than a
 * confidently wrong one.
 */
export function pickBest(candidates, query, { floor = 0 } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const scored = candidates
    .map((candidate) => ({ candidate, ...scoreCandidate(candidate, query) }))
    .filter((entry) => entry.keyMatch !== 'none')
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  const best = scored[0];
  if (best.score < floor) return null;

  const margin = scored.length > 1 ? best.score - scored[1].score : Infinity;
  const confidence = confidenceFor({
    keyMatch: best.keyMatch,
    candidate: best.candidate,
    query,
    margin: Number.isFinite(margin) ? margin : 4,
    candidateCount: scored.length,
  });

  return {
    record: best.candidate,
    score: best.score,
    confidence,
    keyMatch: best.keyMatch,
    candidateCount: scored.length,
    runnerUp: scored.length > 1 ? scored[1].candidate : null,
  };
}
