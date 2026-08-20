/**
 * Streaming TSV helpers for the IMDb dataset dumps.
 *
 * title.basics.tsv is ~1GB uncompressed and ~11M rows, so nothing here ever
 * holds the whole file: chunks go in, parsed rows come out.
 */

/** `\N` is IMDb's null. */
function field(value) {
  return value === '\\N' || value === '' || value === undefined ? null : value;
}

function intField(value) {
  const raw = field(value);
  if (raw == null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Splits a byte/character stream into lines across chunk boundaries.
 * Feed decoded strings; call flush() at the end for any trailing partial line.
 */
export class LineSplitter {
  constructor() {
    this.tail = '';
  }

  feed(chunk) {
    const text = this.tail + chunk;
    const lines = text.split('\n');
    // The last element is either a partial line or '' - either way it is the tail.
    this.tail = lines.pop() ?? '';
    return lines;
  }

  flush() {
    const rest = this.tail;
    this.tail = '';
    return rest ? [rest] : [];
  }
}

/** 'tt0111161' -> 111161. Returns -1 for anything that is not a tconst. */
export function tconstToId(tconst) {
  if (typeof tconst !== 'string' || !tconst.startsWith('tt')) return -1;
  const n = Number.parseInt(tconst.slice(2), 10);
  return Number.isFinite(n) && n >= 0 ? n : -1;
}

/** 111161 -> 'tt0111161'. IMDb pads to at least 7 digits. */
export function idToTconst(id) {
  return `tt${String(id).padStart(7, '0')}`;
}

/**
 * title.ratings.tsv: tconst, averageRating, numVotes
 */
export function parseRatingsLine(line) {
  if (!line || line.startsWith('tconst')) return null;
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const id = tconstToId(parts[0]);
  if (id < 0) return null;
  const rating = Number.parseFloat(parts[1]);
  const votes = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(rating) || !Number.isFinite(votes)) return null;
  return { id, rating, votes };
}

/**
 * title.basics.tsv: tconst, titleType, primaryTitle, originalTitle, isAdult,
 * startYear, endYear, runtimeMinutes, genres
 */
export function parseBasicsLine(line) {
  if (!line || line.startsWith('tconst')) return null;
  const parts = line.split('\t');
  if (parts.length < 6) return null;
  const id = tconstToId(parts[0]);
  if (id < 0) return null;
  const primaryTitle = field(parts[2]);
  if (!primaryTitle) return null;
  return {
    id,
    titleType: field(parts[1]),
    primaryTitle,
    originalTitle: field(parts[3]),
    isAdult: parts[4] === '1',
    startYear: intField(parts[5]),
  };
}
