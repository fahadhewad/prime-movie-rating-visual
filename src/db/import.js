/**
 * One-time import of the IMDb dataset dumps into IndexedDB.
 *
 * Why this runs on the options page and not in the service worker: MV3 workers
 * are killed after ~30s of idle and can be torn down mid-job. This import reads
 * roughly a gigabyte of decompressed TSV and takes minutes. A normal extension
 * page has an ordinary document lifetime, so the import runs there, and the
 * worker just reads the finished store.
 *
 * Shape of the job:
 *   pass 1  title.ratings.tsv (~1.5M rows) -> compact typed-array index in RAM
 *   pass 2  title.basics.tsv  (~11M rows)  -> stream past, keep only rows that
 *                                             have a rating, pass the filters,
 *                                             and write them out in batches
 *
 * The join has to happen this way round: 11M individual IndexedDB reads would
 * take hours, whereas 1.5M ratings fit in ~12MB of typed arrays.
 */

import { recordKeys } from '../shared/normalise.js';
import { RatingsIndex } from '../shared/ratings-index.js';
import { LineSplitter, parseBasicsLine, parseRatingsLine } from '../shared/tsv.js';
import { clearTitles, putTitles, setMeta } from './idb.js';

const BATCH_SIZE = 4000;

/**
 * Turn a URL or a File into a stream of decoded text, gunzipping on the way if
 * needed. DecompressionStream is native, so no bundled zlib.
 */
async function textStream(source, { onTotal } = {}) {
  let stream;
  let name;

  if (typeof source === 'string') {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${source} responded ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > 0) onTotal?.(length);
    stream = response.body;
    name = source;
  } else {
    onTotal?.(source.size);
    stream = source.stream();
    name = source.name || 'file';
  }

  if (!stream) throw new Error('no readable stream for this source');
  if (/\.gz$/i.test(name)) {
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  return stream.pipeThrough(new TextDecoderStream('utf-8'));
}

/**
 * Read a text stream line by line. `onLine` is sync and hot - it runs ~11M
 * times - so it must stay allocation-light.
 */
async function forEachLine(source, onLine, { onProgress, label } = {}) {
  let total = 0;
  const stream = await textStream(source, { onTotal: (value) => { total = value; } });
  const reader = stream.getReader();
  const splitter = new LineSplitter();
  let bytes = 0;
  let rows = 0;
  let sinceReport = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Approximate: byte progress against a compressed content-length is only
      // ever a progress bar, never a correctness input.
      bytes += value.length;
      for (const line of splitter.feed(value)) {
        onLine(line);
        rows += 1;
      }
      sinceReport += 1;
      if (sinceReport >= 64) {
        sinceReport = 0;
        onProgress?.({ label, rows, bytes, total });
        // Yield so the options page can repaint its progress bar.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    for (const line of splitter.flush()) {
      onLine(line);
      rows += 1;
    }
  } finally {
    reader.releaseLock();
  }

  onProgress?.({ label, rows, bytes, total, done: true });
  return rows;
}

/**
 * Run the full import.
 *
 * @param {object} options
 * @param {string|File} options.ratings   title.ratings.tsv(.gz) URL or file
 * @param {string|File} options.basics    title.basics.tsv(.gz) URL or file
 * @param {number} options.minVotes       drop thinly-rated titles; keeps the store small
 * @param {string[]} options.titleTypes   IMDb titleTypes worth keeping
 * @param {(update: object) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 */
export async function importDatasets({
  ratings,
  basics,
  minVotes = 100,
  titleTypes,
  onProgress,
  signal,
}) {
  const started = Date.now();
  const typeFilter = new Set(titleTypes);
  const abort = () => {
    if (signal?.aborted) throw new Error('import cancelled');
  };

  onProgress?.({ phase: 'ratings', message: 'Reading title.ratings.tsv' });
  const index = new RatingsIndex();
  await forEachLine(
    ratings,
    (line) => {
      const row = parseRatingsLine(line);
      if (row) index.push(row.id, row.rating, row.votes);
    },
    {
      label: 'ratings',
      onProgress: (update) => {
        abort();
        onProgress?.({ phase: 'ratings', ...update, kept: index.size });
      },
    },
  );
  index.finalise();
  onProgress?.({ phase: 'ratings', done: true, kept: index.size, message: `${index.size.toLocaleString()} rated titles` });

  onProgress?.({ phase: 'titles', message: 'Clearing previous import' });
  await clearTitles();

  onProgress?.({ phase: 'basics', message: 'Reading title.basics.tsv' });
  let kept = 0;
  let batch = [];
  const writes = [];

  const flush = async () => {
    if (!batch.length) return;
    const pending = batch;
    batch = [];
    await putTitles(pending);
  };

  await forEachLine(
    basics,
    (line) => {
      const row = parseBasicsLine(line);
      if (!row || row.isAdult) return;
      if (typeFilter.size && !typeFilter.has(row.titleType)) return;
      const rating = index.get(row.id);
      if (!rating || rating.votes < minVotes) return;

      kept += 1;
      batch.push({
        id: row.id,
        t: row.primaryTitle,
        o: row.originalTitle !== row.primaryTitle ? row.originalTitle : null,
        y: row.startYear,
        ty: row.titleType,
        r: rating.rating,
        v: rating.votes,
        k: recordKeys(row.primaryTitle, row.originalTitle),
      });
      if (batch.length >= BATCH_SIZE) writes.push(flush());
    },
    {
      label: 'basics',
      onProgress: async (update) => {
        abort();
        // Keep the write queue from running away ahead of the reader.
        if (writes.length) {
          await Promise.all(writes.splice(0, writes.length));
        }
        onProgress?.({ phase: 'basics', ...update, kept });
      },
    },
  );

  await Promise.all(writes);
  await flush();

  const meta = {
    importedAt: Date.now(),
    durationMs: Date.now() - started,
    ratedTitles: index.size,
    storedTitles: kept,
    minVotes,
    titleTypes: [...typeFilter],
  };
  await setMeta('dataset', meta);
  onProgress?.({ phase: 'done', ...meta, message: `Stored ${kept.toLocaleString()} titles` });
  return meta;
}
