/**
 * Content script orchestration.
 *
 * Three moving parts, in the order they matter:
 *
 *  - MutationObserver, because carousels lazy-load. Tiles appear long after
 *    load, on scroll, on hover, and on client-side navigation. Debounced,
 *    because Prime mutates the DOM continuously and a per-mutation scan would
 *    cost more than the lookups do.
 *
 *  - IntersectionObserver, because a storefront page holds hundreds of tiles and
 *    only a dozen are visible. Nothing is looked up until it is near the
 *    viewport, which is what keeps us inside OMDb's daily budget.
 *
 *  - A request batcher, because a row scrolling into view yields twenty tiles in
 *    the same frame and they should cost one message, not twenty.
 */

import { glowStyle } from '../shared/color.js';
import { DEFAULT_SETTINGS, MSG } from '../shared/constants.js';
import { applyGlow, clearGlow, getState, markState, STATE } from './glow.js';
import { describeTile, discoverImages, looksLikeHero, looksTooSmall } from './tiles.js';

const SCAN_DEBOUNCE_MS = 150;
const BATCH_DELAY_MS = 60;
const BATCH_MAX = 24;
// Margin on all four sides, not just vertical: storefront rows scroll
// sideways, so the next few tiles along should resolve before they are
// swiped into view. Still bounded, so an off-screen page costs nothing.
const VIEWPORT_MARGIN = '300px';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 700;
const MAX_LOOKUP_RETRIES = 3;
const LOOKUP_RETRY_MS = 1500;

let settings = { ...DEFAULT_SETTINGS };
let supportsOklch = false;
let stopped = false;

const pendingBatch = [];
const retries = new WeakMap();
const lookupRetries = new WeakMap();
const painted = new Set();
let batchTimer = null;
let scanTimer = null;

/**
 * Running tally of what happened to every tile, so "nothing is glowing" can be
 * answered with a stage rather than a shrug. Read by the options page.
 */
const stats = {
  discovered: 0,
  described: 0,
  noTitle: 0,
  tooSmall: 0,
  heroSkipped: 0,
  requested: 0,
  painted: 0,
  missed: 0,
  lowConfidence: 0,
  failed: 0,
  samples: [],
};

const log = (...args) => {
  if (settings.debug) console.debug('[pvg]', ...args);
};

/** The extension was reloaded; this script is orphaned and must go quiet. */
function contextIsDead(error) {
  return /Extension context invalidated|receiving end does not exist/i.test(String(error?.message || error));
}

async function send(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({ type, ...payload });
  } catch (error) {
    if (contextIsDead(error)) teardown();
    else log('message failed', error);
    return null;
  }
}

const intersection = new IntersectionObserver(onIntersect, {
  rootMargin: VIEWPORT_MARGIN,
  threshold: 0,
});

const mutations = new MutationObserver(() => scheduleScan());

function scheduleScan() {
  if (stopped || scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    const run = () => scan();
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 500 });
    else run();
  }, SCAN_DEBOUNCE_MS);
}

function scan() {
  if (stopped || !settings.enabled) return;
  let found = 0;
  for (const img of discoverImages(document)) {
    markState(img, STATE.QUEUED);
    intersection.observe(img);
    found += 1;
    stats.discovered += 1;
  }
  if (found) log('queued', found, 'tiles');
}

/**
 * Send a tile back to the observer after a failed lookup.
 *
 * Re-marking it QUEUED is not enough: onIntersect already unobserved it, and a
 * later scan skips anything that carries a state attribute. Retries are bounded
 * and backed off, because re-observing an element that is already on screen
 * fires the callback immediately - an unbounded version would spin.
 */
function requeue(img) {
  const attempts = (lookupRetries.get(img) || 0) + 1;
  if (attempts > MAX_LOOKUP_RETRIES) {
    markState(img, STATE.SKIP);
    return;
  }
  lookupRetries.set(img, attempts);
  markState(img, STATE.QUEUED);
  setTimeout(() => {
    if (stopped || !img.isConnected || getState(img) !== STATE.QUEUED) return;
    intersection.observe(img);
  }, LOOKUP_RETRY_MS * attempts);
}

function onIntersect(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    intersection.unobserve(img);
    if (getState(img) !== STATE.QUEUED) continue;
    consider(img);
  }
}

function consider(img) {
  if (looksTooSmall(img)) {
    stats.tooSmall += 1;
    markState(img, STATE.SKIP);
    return;
  }

  if (!settings.glowHero && looksLikeHero(img)) {
    stats.heroSkipped += 1;
    markState(img, STATE.SKIP);
    return;
  }

  const tile = describeTile(img);
  if (!tile) {
    // Artwork often paints before its alt text arrives. Give it another go or
    // two before writing the tile off.
    const attempts = (retries.get(img) || 0) + 1;
    if (attempts > MAX_RETRIES) {
      stats.noTitle += 1;
      markState(img, STATE.SKIP);
      return;
    }
    retries.set(img, attempts);
    setTimeout(() => {
      if (stopped || getState(img) !== STATE.QUEUED) return;
      consider(img);
    }, RETRY_DELAY_MS * attempts);
    return;
  }

  markState(img, STATE.PENDING);
  stats.described += 1;
  // Keep a few worked examples: seeing what we read off the page is the
  // quickest way to tell a discovery problem from a lookup problem.
  if (stats.samples.length < 8) {
    stats.samples.push({ label: tile.label, ...tile.request });
  }
  pendingBatch.push(tile);
  if (pendingBatch.length >= BATCH_MAX) flushBatch();
  else scheduleFlush();
}

function scheduleFlush() {
  if (batchTimer) return;
  batchTimer = setTimeout(() => {
    batchTimer = null;
    flushBatch();
  }, BATCH_DELAY_MS);
}

async function flushBatch() {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (!pendingBatch.length) return;

  const tiles = pendingBatch.splice(0, pendingBatch.length);
  stats.requested += tiles.length;
  const response = await send(MSG.LOOKUP, { items: tiles.map((tile) => tile.request) });
  if (!response || response.error) {
    // Put them back in the queue rather than leaving them permanently pending.
    for (const tile of tiles) requeue(tile.img);
    log('lookup failed', response?.error);
    return;
  }
  if (response.settings) settings = { ...settings, ...response.settings };
  if (response.disabled) return;

  const results = response.results || [];
  tiles.forEach((tile, i) => paint(tile, results[i]));
}

function paint(tile, result) {
  if (!result || result.miss || typeof result.rating !== 'number') {
    // A transient failure deserves another chance; a real miss does not.
    if (result?.transient) {
      stats.failed += 1;
      requeue(tile.img);
    } else {
      stats.missed += 1;
      markState(tile.img, STATE.MISS);
    }
    return;
  }

  const confidence = typeof result.confidence === 'number' ? result.confidence : 1;
  if (confidence < settings.minConfidence) {
    log('too unsure to draw', tile.request.title, confidence.toFixed(2));
    stats.lowConfidence += 1;
    markState(tile.img, STATE.MISS);
    return;
  }

  const style = glowStyle({ rating: result.rating, confidence, settings, supportsOklch });
  applyGlow(tile.card, style, {
    rating: result.rating,
    confidence,
    matchedTitle: result.matchedTitle || tile.request.title,
    source: result.source || 'cache',
    showBadge: settings.showBadge,
  });
  painted.add(tile.card);
  stats.painted += 1;
  markState(tile.img, STATE.DONE);
}

/** Settings changed - drop every glow and start over. */
function repaintAll() {
  for (const card of painted) clearGlow(card);
  painted.clear();
  for (const img of document.querySelectorAll('img[data-pvg]')) delete img.dataset.pvg;
  if (settings.enabled) scan();
}

function teardown() {
  if (stopped) return;
  stopped = true;
  mutations.disconnect();
  intersection.disconnect();
  clearTimeout(scanTimer);
  clearTimeout(batchTimer);
  log('stopped');
}

async function start() {
  supportsOklch =
    typeof CSS !== 'undefined' && CSS.supports?.('color', 'oklch(0.7 0.15 30 / 0.5)') === true;

  const response = await send(MSG.SETTINGS);
  if (response?.settings) settings = { ...settings, ...response.settings };
  if (!settings.enabled) {
    log('disabled in settings');
    return;
  }

  mutations.observe(document.body, { childList: true, subtree: true });
  scan();
  log('watching', location.pathname, { supportsOklch });
}

/**
 * Answer the options page's "why is nothing glowing?" probe.
 *
 * Re-runs discovery live so the numbers describe the page as it is now, not as
 * it was when the script first loaded.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MSG.DIAGNOSE) return false;
  const freshImages = discoverImages(document).length;
  const readable = [];
  for (const img of document.querySelectorAll('img')) {
    if (readable.length >= 5) break;
    const tile = describeTile(img);
    if (tile) readable.push({ label: tile.label, ...tile.request });
  }
  sendResponse({
    url: location.href,
    running: !stopped,
    enabled: settings.enabled,
    stats: { ...stats },
    // Anything discovery finds now that is not yet tracked is a fresh batch.
    undiscovered: freshImages,
    readableNow: readable,
    totalImages: document.querySelectorAll('img').length,
    tiles: document.querySelectorAll('.pvg-tile').length,
  });
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || stopped) return;
  if (!Object.keys(changes).some((key) => key.endsWith('settings'))) return;
  send(MSG.SETTINGS).then((response) => {
    if (!response?.settings) return;
    settings = { ...settings, ...response.settings };
    repaintAll();
  });
});

// Prime is a single-page app: a client-side navigation swaps the whole grid
// without a page load. The MutationObserver catches it, but a nudge on
// history changes makes the first paint noticeably quicker.
for (const event of ['popstate', 'pushstate', 'pageshow']) {
  window.addEventListener(event, () => scheduleScan());
}

start();
