/**
 * Title cleaning and key building.
 *
 * Prime Video hands us marketing strings, not catalogue entries: "Watch The Boys
 * - Season 3 | Prime Video", "Dune (4K UHD)", "Ocean's Eleven [Blu-ray]". IMDb
 * hands us catalogue entries. This module squashes both sides onto the same key
 * space so they can be compared, and pulls out the year when it happens to be
 * sitting in the string.
 *
 * Pure functions only - no DOM, no chrome APIs - so the node tests can drive it.
 */

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Leading articles dropped from the loose key, so "The Thing" matches "Thing". */
const LEADING_ARTICLES =
  /^(?:the|a|an|le|la|les|el|los|las|il|lo|gli|un|una|der|die|das|den|det|de|het|o|os)\s+/;

const ROMAN_NUMERALS = new Map([
  ['i', '1'], ['ii', '2'], ['iii', '3'], ['iv', '4'], ['v', '5'],
  ['vi', '6'], ['vii', '7'], ['viii', '8'], ['ix', '9'], ['x', '10'],
  ['xi', '11'], ['xii', '12'], ['xiii', '13'], ['xiv', '14'], ['xv', '15'],
]);

/** Chrome/Prime chrome that is never part of a title. Applied in order. */
const NOISE = [
  /\s*\|\s*prime video\s*$/i,
  /\s*-\s*prime video\s*$/i,
  /^\s*(?:watch|stream)\s+/i,
  /^\s*(?:included with prime|prime video)\s*[:-]\s*/i,
  /\s*[-–—]\s*official\s+trailer\b.*$/i,
  /\s*\(\s*(?:official\s+)?trailer\s*\)\s*$/i,
  /\s*\[[^\]]*(?:blu-?ray|dvd|4k|uhd|ultra hd|region\s*\d|box ?set|steelbook)[^\]]*\]\s*/gi,
  /\s*\(\s*(?:4k(?:\s*uhd)?|uhd|hdr|hd|sd|dubbed|subtitled|censored|uncut|unrated|extended(?:\s+cut)?|theatrical(?:\s+cut)?|director'?s\s+cut|imax|remastered|restored|special\s+edition|anniversary\s+edition)\s*\)\s*/gi,
  /\s*\(\s*(?:english|french|german|spanish|italian|portuguese|hindi|tamil|telugu|japanese|korean|mandarin)(?:\s+(?:dub|dubbed|audio|subtitles?))?\s*\)\s*/gi,
];

/** "Sherlock: Series 4", "The Boys - Season 3", "Vikings, Season 2". */
const SEASON_SUFFIX =
  /\s*(?:[-–—:,]\s*)?(?:the\s+)?(?:complete\s+)?(?:season|series|staffel|temporada|saison|part|volume|vol\.?)\s+(\d{1,3})\s*$/i;
/**
 * A four-digit number is only a release year if it could plausibly be one.
 * Without this, 'Blade Runner 2049' loses half its name.
 */
const MIN_YEAR = 1874;
const MAX_YEAR = new Date().getFullYear() + 3;

function plausibleYear(value) {
  return Number.isFinite(value) && value >= MIN_YEAR && value <= MAX_YEAR;
}

const SEASON_ANY = /\b(?:season|series|staffel|temporada|saison)\s+(\d{1,3})\b/i;

/**
 * Strip storefront noise. Returns the bare title, or the original string if
 * stripping would leave nothing behind.
 */
export function stripNoise(raw) {
  if (typeof raw !== 'string') return '';
  let out = raw.replace(/\s+/g, ' ').trim();
  for (const pattern of NOISE) {
    const next = out.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
    if (next) out = next;
  }
  return out.replace(/\s*[-–—:,]\s*$/, '').trim();
}

/**
 * Pull a season number out of a label, if there is one. Useful context: a tile
 * for "Season 3" is a tvSeries, which is a strong type hint when matching.
 */
export function extractSeason(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(SEASON_ANY);
  return match ? Number(match[1]) : null;
}

/**
 * Split a trailing/parenthesised year off a title.
 *
 * Only splits when text survives the removal, so the film "2012" keeps its name
 * and reports no year rather than becoming an empty string.
 */
export function splitTitleYear(raw) {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return { title: '', year: null };

  const parenthesised = [...input.matchAll(/\((?:19|20)(\d{2})\)/g)];
  if (parenthesised.length) {
    const last = parenthesised[parenthesised.length - 1];
    const rest = (input.slice(0, last.index) + input.slice(last.index + last[0].length))
      .replace(/\s+/g, ' ')
      .trim();
    const year = Number(last[0].slice(1, 5));
    if (rest && plausibleYear(year)) return { title: rest, year };
  }

  const trailing = input.match(/^(.*\S)\s+((?:19|20)\d{2})$/);
  if (trailing && trailing[1].trim() && plausibleYear(Number(trailing[2]))) {
    return { title: trailing[1].trim(), year: Number(trailing[2]) };
  }

  return { title: input, year: null };
}

/**
 * Everything we can infer from a single storefront label, in one pass.
 */
export function parseLabel(raw) {
  const cleaned = stripNoise(raw);
  const season = extractSeason(cleaned);
  const withoutSeason = cleaned.replace(SEASON_SUFFIX, '').trim() || cleaned;
  const { title, year } = splitTitleYear(withoutSeason);
  return { title, year, season, cleaned };
}

/** Lowercase, de-accent, de-punctuate. The common half of both key forms. */
export function normaliseTitle(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[‘’'`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Exact-ish key: articles and numerals preserved. */
export function strictKey(raw) {
  return normaliseTitle(raw);
}

/**
 * Forgiving key: leading article dropped and roman numerals folded to digits,
 * so "The Godfather Part II" and "Godfather Part 2" collide on purpose.
 */
export function looseKey(raw) {
  const base = normaliseTitle(raw).replace(LEADING_ARTICLES, '');
  const folded = base
    .split(' ')
    .map((word) => ROMAN_NUMERALS.get(word) ?? word)
    .join(' ');
  return folded.trim();
}

/** Both keys, de-duplicated. What goes into the IndexedDB multiEntry index. */
export function keysFor(raw) {
  const keys = new Set();
  for (const key of [strictKey(raw), looseKey(raw)]) {
    if (key) keys.add(key);
  }
  return [...keys];
}

/** Index keys for a dataset record, covering primary and original titles. */
export function recordKeys(primaryTitle, originalTitle) {
  const keys = new Set(keysFor(primaryTitle));
  if (originalTitle && originalTitle !== primaryTitle) {
    for (const key of keysFor(originalTitle)) keys.add(key);
  }
  return [...keys];
}

/** Cache key for a resolved lookup. ASIN wins when we have one: it is stable. */
export function cacheKey({ asin, title, year }) {
  const key = looseKey(title);
  // The ASIN pins an entry to one storefront tile, which is what lets a remake
  // be disambiguated once and then never again. The title stays in the key so
  // that an ASIN which no longer describes what is on screen - a recycled tile,
  // or one read from the wrong link in a card with several - cannot serve
  // another film's rating.
  if (asin) return `asin:${asin}|t:${key}`;
  return `t:${key}|y:${year ?? '-'}`;
}
