/**
 * MV3 service worker: settings, message routing, and the resolution chain.
 *
 * Deliberately thin. The heavy work lives either in IndexedDB (already built by
 * the options page) or behind a cache, because this worker can be torn down at
 * any moment and restarted cold on the next message.
 */

import { DEFAULT_SETTINGS, MSG, STORAGE_KEYS } from '../shared/constants.js';
import { datasetMeta, invalidateDatasetMeta } from './providers/dataset.js';
import { omdbStatus } from './providers/omdb.js';
import { cache, resolveBatch } from './resolver.js';

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
}

/**
 * Settings changed - the dataset may have been re-imported, and a key may have
 * appeared. Both change what a cached miss means, so drop the misses.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEYS.settings]) return;
  invalidateDatasetMeta();
  cache
    .load()
    .then(() => cache.clearMisses())
    .catch(() => {});
});

const handlers = {
  async [MSG.LOOKUP](payload) {
    const settings = await getSettings();
    if (!settings.enabled) return { results: [], disabled: true };
    const results = await resolveBatch(payload.items || [], settings);
    return { results, settings: presentableSettings(settings) };
  },

  async [MSG.SETTINGS]() {
    const settings = await getSettings();
    return { settings: presentableSettings(settings) };
  },

  async [MSG.STATUS]() {
    invalidateDatasetMeta();
    const [settings, dataset, omdb] = await Promise.all([getSettings(), datasetMeta(), omdbStatus()]);
    await cache.load();
    return {
      settings: presentableSettings(settings),
      dataset,
      omdb,
      cacheEntries: cache.entries.size,
    };
  },

  /** Sent by the options page once an import finishes. */
  async [MSG.SOURCES_CHANGED]() {
    invalidateDatasetMeta();
    // Read the true current cache: the misses may have been written by a
    // context other than this worker.
    await cache.reload();
    const clearedMisses = cache.clearMisses();
    await cache.flush();
    return { clearedMisses };
  },

  async [MSG.CLEAR_CACHE]() {
    await cache.load();
    await cache.clear();
    return { cleared: true };
  },
};

/** Never hand the API key back out to a content script that did not need it. */
function presentableSettings(settings) {
  const { omdbApiKey, ...rest } = settings;
  return { ...rest, hasOmdbKey: Boolean(omdbApiKey) };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: String(error?.message || error) }));
  // Keep the message channel open for the async reply.
  return true;
});

// Flush any cache writes still pending when the worker is about to go away.
chrome.runtime.onSuspend?.addListener(() => {
  cache.flush().catch(() => {});
});

// No popup: clicking the toolbar icon goes straight to settings.
chrome.action?.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
