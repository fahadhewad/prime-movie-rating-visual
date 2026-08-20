/**
 * Shared, dependency-free constants. Safe to import from any context
 * (content script, service worker, options page, node tests).
 */

export const MSG = {
  LOOKUP: 'pvg:lookup',
  SETTINGS: 'pvg:settings',
  STATUS: 'pvg:status',
  CLEAR_CACHE: 'pvg:clear-cache',
};

export const STORAGE_KEYS = {
  settings: 'pvg:settings',
  cache: 'pvg:cache',
  omdbBudget: 'pvg:omdb-budget',
};

export const SOURCE = {
  DATASET: 'dataset',
  OMDB: 'omdb',
  CACHE: 'cache',
};

/** IMDb title types worth keeping when importing the dataset dump. */
export const DEFAULT_TITLE_TYPES = [
  'movie',
  'tvMovie',
  'tvSeries',
  'tvMiniSeries',
  'tvSpecial',
  'video',
];

export const DEFAULT_SETTINGS = {
  enabled: true,
  /** 'dataset' tries the local IndexedDB dump first, then OMDb; 'omdb' skips the dump. */
  provider: 'dataset',
  omdbApiKey: '',
  /** OMDb's free tier is ~1000/day. Stay under it and fail soft when we hit the wall. */
  omdbDailyLimit: 1000,
  /** Ratings below this are drawn red, above `high` green, with amber in between. */
  low: 5.0,
  mid: 6.75,
  high: 8.5,
  /** Below this match confidence we dim the glow instead of pretending we are sure. */
  minConfidence: 0.35,
  /** Match confidence at or above this is treated as certain. */
  confidentAt: 0.75,
  glowBlur: 18,
  glowSpread: 2,
  glowAlpha: 0.95,
  colorSpace: 'auto', // 'auto' | 'oklch' | 'hsl'
  showBadge: false,
  /** Positive results are re-checked after this long; misses expire sooner. */
  cacheTtlDays: 30,
  negativeCacheTtlDays: 3,
  cacheMaxEntries: 20000,
  /** Dataset import filters. */
  minVotes: 100,
  titleTypes: DEFAULT_TITLE_TYPES,
  debug: false,
};

export const IMDB_DATASETS = {
  ratings: 'https://datasets.imdbws.com/title.ratings.tsv.gz',
  basics: 'https://datasets.imdbws.com/title.basics.tsv.gz',
};

export const DB_NAME = 'pvg';
export const DB_VERSION = 1;
export const STORE_TITLES = 'titles';
export const STORE_META = 'meta';
export const INDEX_KEYS = 'keys';
