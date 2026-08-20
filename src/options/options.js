/**
 * Settings page, and host for the dataset import.
 *
 * The import runs here rather than in the service worker on purpose: MV3 workers
 * are killed after a short idle and can be torn down mid-task, and this job runs
 * for minutes. An options tab is an ordinary document that lives as long as it
 * is open.
 */

import { ratingToColor } from '../shared/color.js';
import { DEFAULT_SETTINGS, IMDB_DATASETS, MSG, STORAGE_KEYS } from '../shared/constants.js';
import { clearTitles, countTitles, getMeta } from '../db/idb.js';
import { importDatasets } from '../db/import.js';
import { invalidateDatasetMeta } from '../background/providers/dataset.js';

const FIELDS = [
  ['enabled', 'checkbox'],
  ['provider', 'string'],
  ['omdbApiKey', 'string'],
  ['omdbDailyLimit', 'number'],
  ['low', 'number'],
  ['mid', 'number'],
  ['high', 'number'],
  ['minConfidence', 'number'],
  ['confidentAt', 'number'],
  ['glowBlur', 'number'],
  ['glowSpread', 'number'],
  ['glowAlpha', 'number'],
  ['colorSpace', 'string'],
  ['showBadge', 'checkbox'],
  ['glowHero', 'checkbox'],
  ['cacheTtlDays', 'number'],
  ['negativeCacheTtlDays', 'number'],
  ['minVotes', 'number'],
  ['debug', 'checkbox'],
];

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };
let importController = null;

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
  for (const [key, kind] of FIELDS) {
    const input = $(key);
    if (!input) continue;
    if (kind === 'checkbox') input.checked = Boolean(settings[key]);
    else input.value = settings[key];
  }
  renderRamp();
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 250);
}

async function save() {
  const next = { ...settings };
  for (const [key, kind] of FIELDS) {
    const input = $(key);
    if (!input) continue;
    if (kind === 'checkbox') next[key] = input.checked;
    else if (kind === 'number') {
      const value = Number(input.value);
      if (Number.isFinite(value)) next[key] = value;
    } else next[key] = input.value;
  }

  // A ramp only makes sense left to right; nudge rather than reject.
  if (next.high <= next.low) next.high = next.low + 0.1;
  next.mid = Math.min(Math.max(next.mid, next.low), next.high);
  if (next.confidentAt < next.minConfidence) next.confidentAt = next.minConfidence;

  settings = next;
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  flash('saved');
  renderRamp();
}

function flash(id) {
  const element = $(id);
  if (!element) return;
  element.hidden = false;
  clearTimeout(element._timer);
  element._timer = setTimeout(() => {
    element.hidden = true;
  }, 1200);
}

/** Preview strip, painted with the same function the content script uses. */
function renderRamp() {
  const ramp = $('ramp');
  ramp.textContent = '';
  const supportsOklch = CSS.supports('color', 'oklch(0.7 0.15 30 / 0.5)');
  for (let rating = 3; rating <= 9.5; rating += 0.5) {
    const step = document.createElement('div');
    step.className = 'step';
    step.style.background = ratingToColor(rating, {
      low: settings.low,
      mid: settings.mid,
      high: settings.high,
      space: settings.colorSpace,
      supportsOklch,
    });
    step.textContent = rating.toFixed(1);
    ramp.appendChild(step);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

async function refreshStatus() {
  const meta = await getMeta('dataset');
  const status = $('dataset-status');
  if (meta && meta.storedTitles) {
    const when = new Date(meta.importedAt).toLocaleString();
    status.textContent =
      `${meta.storedTitles.toLocaleString()} titles stored, imported ${when} ` +
      `(minimum ${meta.minVotes} votes, took ${Math.round(meta.durationMs / 1000)}s).`;
  } else {
    const count = await countTitles().catch(() => 0);
    status.textContent = count
      ? `${count.toLocaleString()} titles stored from an incomplete import - re-import to be safe.`
      : 'Not imported yet. Ratings will come from OMDb until you import.';
  }

  const hasDataset = Boolean(meta && meta.storedTitles);
  const hasKey = Boolean((settings.omdbApiKey || '').trim());
  // The single most common reason for "nothing glows": nowhere to look up.
  $('no-source').hidden = hasDataset || hasKey;

  const response = await chrome.runtime.sendMessage({ type: MSG.STATUS }).catch(() => null);
  if (response) {
    $('cache-status').textContent = `${(response.cacheEntries || 0).toLocaleString()} cached lookups.`;
    const budget = response.omdb;
    if (budget) {
      $('omdb-status').textContent = budget.exhausted
        ? `Key unavailable today: ${budget.reason || 'daily limit reached'}. Resets at UTC midnight.`
        : `${budget.used || 0} of ${settings.omdbDailyLimit} lookups used today.`;
    }
  }
}

function setImporting(active) {
  for (const id of ['import-network', 'import-files', 'clear-dataset']) $(id).disabled = active;
  $('cancel-import').hidden = !active;
  $('progress-wrap').hidden = !active;
  if (!active) $('progress-bar').style.width = '0';
}

function onProgress(update) {
  const text = $('progress-text');
  const bar = $('progress-bar');

  if (update.message) text.textContent = update.message;
  if (update.phase === 'basics' && update.rows) {
    text.textContent = `Scanning titles: ${update.rows.toLocaleString()} rows read, ${(update.kept || 0).toLocaleString()} kept`;
  } else if (update.phase === 'ratings' && update.rows) {
    text.textContent = `Reading ratings: ${update.rows.toLocaleString()} rows`;
  }

  if (update.bytes && update.total) {
    // Compressed content-length against decompressed bytes read overshoots, so
    // this is a rough indicator, not a true percentage.
    const pct = Math.min(100, Math.round((update.bytes / update.total) * 100));
    bar.style.width = `${pct}%`;
    if (update.total) text.textContent += ` (${formatBytes(update.bytes)} read)`;
  }
}

async function runImport(ratings, basics) {
  if (importController) return;
  importController = new AbortController();
  setImporting(true);
  try {
    await importDatasets({
      ratings,
      basics,
      minVotes: settings.minVotes,
      titleTypes: settings.titleTypes || DEFAULT_SETTINGS.titleTypes,
      onProgress,
      signal: importController.signal,
    });
    invalidateDatasetMeta();
    // Tell the worker to re-read the dataset and forget cached misses - titles
    // that missed before the import can be found now.
    await chrome.runtime.sendMessage({ type: MSG.SOURCES_CHANGED }).catch(() => {});
  } catch (error) {
    $('progress-text').textContent = `Import failed: ${error.message}`;
    $('progress-wrap').hidden = false;
    return;
  } finally {
    importController = null;
    setImporting(false);
    await refreshStatus();
  }
}

function pickFiles() {
  return new Promise((resolve) => {
    const ratingsInput = $('file-ratings');
    const basicsInput = $('file-basics');
    ratingsInput.value = '';
    basicsInput.value = '';

    ratingsInput.onchange = () => {
      if (!ratingsInput.files[0]) return resolve(null);
      basicsInput.click();
    };
    basicsInput.onchange = () => {
      if (!basicsInput.files[0]) return resolve(null);
      resolve({ ratings: ratingsInput.files[0], basics: basicsInput.files[0] });
    };
    ratingsInput.click();
  });
}


/**
 * Ask the content script what it sees on an open Prime Video tab.
 *
 * Reported as stages, because each one fails for a different reason: no tab
 * means the match pattern never applied, images but no titles means tile
 * discovery needs adjusting for the current markup, and titles but no paints
 * means the lookup side is the problem.
 */
async function runDiagnostics() {
  const output = $('diagnosis');
  output.hidden = false;
  output.textContent = 'Looking for a Prime Video tab…';

  const tabs = await chrome.tabs
    .query({ url: ['https://*.amazon.co.uk/gp/video/*'] })
    .catch(() => []);

  if (!tabs.length) {
    output.textContent =
      'No Prime Video tab is open.\n\n' +
      'Open https://www.amazon.co.uk/gp/video/storefront in another tab, leave it\n' +
      'on screen for a moment, then run this again.';
    return;
  }

  const lines = [];
  for (const tab of tabs) {
    const report = await chrome.tabs
      .sendMessage(tab.id, { type: MSG.DIAGNOSE })
      .catch((error) => ({ error: String(error?.message || error) }));

    lines.push(`tab ${tab.id}  ${tab.url}`);

    if (!report || report.error) {
      lines.push(
        '  content script did not answer.',
        `  ${report?.error || 'no response'}`,
        '  Reload that tab - a content script only attaches on page load, so a tab',
        '  opened before the extension was installed will not have one.',
        '',
      );
      continue;
    }

    const s = report.stats || {};
    lines.push(
      `  running ${report.running}   enabled ${report.enabled}`,
      `  images on page       ${report.totalImages}`,
      `  looked like tiles    ${s.discovered}`,
      `  title extracted      ${s.described}`,
      `  no usable title      ${s.noTitle}`,
      `  artwork too small    ${s.tooSmall}`,
      `  hero banners skipped ${s.heroSkipped ?? 0}`,
      `  lookups requested    ${s.requested}`,
      `  glows painted        ${s.painted}   (on page now: ${report.tiles})`,
      `  no rating found      ${s.missed}`,
      `  too unsure to draw   ${s.lowConfidence}`,
      `  lookup failed        ${s.failed}`,
    );

    const samples = (s.samples || []).length ? s.samples : report.readableNow || [];
    if (samples.length) {
      lines.push('', '  what it read off the page:');
      for (const sample of samples.slice(0, 6)) {
        lines.push(
          `    "${sample.label}"`,
          `      -> title "${sample.title}"  year ${sample.year ?? '-'}  season ${sample.season ?? '-'}  asin ${sample.asin ?? '-'}`,
        );
      }
    }

    lines.push('', `  ${verdict(report)}`, '');
  }

  output.textContent = lines.join('\n');
}

/** Turn the counters into the one sentence the user actually wants. */
function verdict(report) {
  const s = report.stats || {};
  if (!report.enabled) return 'VERDICT: the extension is switched off at the top of this page.';
  if (!s.discovered) {
    return 'VERDICT: no tiles recognised. Scroll the page so artwork is on screen and re-run; if it stays zero, tile discovery needs updating for the current markup.';
  }
  if (!s.described) {
    return 'VERDICT: tiles found but no titles readable - tile discovery needs updating for the current markup.';
  }
  if (!s.requested) return 'VERDICT: titles read but nothing requested yet. Re-run in a moment.';
  if (s.painted) return `VERDICT: working - ${s.painted} tiles glowing.`;
  if (s.failed) return 'VERDICT: lookups are failing. Check the OMDb key, or import the dataset.';
  if (s.lowConfidence) {
    return 'VERDICT: matches found but all below the confidence floor. Lower "Draw above" under Match confidence.';
  }
  if (s.missed) {
    return 'VERDICT: titles read fine, but no ratings came back. Import the dataset, or set an OMDb key.';
  }
  return 'VERDICT: inconclusive - re-run after scrolling the Prime tab.';
}

function wire() {
  for (const [key] of FIELDS) $(key)?.addEventListener('change', scheduleSave);
  for (const key of ['low', 'mid', 'high', 'colorSpace']) $(key)?.addEventListener('input', scheduleSave);

  $('import-network').addEventListener('click', () => {
    runImport(IMDB_DATASETS.ratings, IMDB_DATASETS.basics);
  });

  $('import-files').addEventListener('click', async () => {
    $('progress-text').textContent = 'Choose title.ratings.tsv.gz, then title.basics.tsv.gz';
    $('progress-wrap').hidden = false;
    const files = await pickFiles();
    if (files) runImport(files.ratings, files.basics);
  });

  $('cancel-import').addEventListener('click', () => {
    importController?.abort();
    $('progress-text').textContent = 'Cancelling…';
  });

  $('clear-dataset').addEventListener('click', async () => {
    if (!confirm('Delete the imported IMDb data? You will need to import again to use it.')) return;
    await clearTitles();
    invalidateDatasetMeta();
    await refreshStatus();
  });

  $('diagnose').addEventListener('click', () => {
    runDiagnostics().catch((error) => {
      $('diagnosis').hidden = false;
      $('diagnosis').textContent = `Diagnostics failed: ${error.message}`;
    });
  });

  $('clear-cache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: MSG.CLEAR_CACHE }).catch(() => {});
    await refreshStatus();
  });

  // Leaving mid-import loses the work; make that explicit.
  window.addEventListener('beforeunload', (event) => {
    if (!importController) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

await loadSettings();
wire();
await refreshStatus();
