/**
 * Resolution cache.
 *
 * A storefront row re-renders constantly and the same twenty films show up on
 * every page, so a title should be looked up once and then never again. Misses
 * are cached too, with a shorter life - without that, every unmatchable tile
 * burns an OMDb request on every single page view.
 *
 * Storage is injected (chrome.storage.local in the extension, a plain object in
 * tests) and writes are debounced, because storage.local has a write-rate quota
 * and carousels resolve in bursts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export class LookupCache {
  /**
   * @param {object} options
   * @param {{load: () => Promise<object>, save: (data: object) => Promise<void>}} options.storage
   * @param {() => number} [options.now]
   * @param {(fn: () => void, ms: number) => any} [options.schedule]
   */
  constructor({ storage, now = Date.now, schedule = null, writeDelayMs = 2000 }) {
    this.storage = storage;
    this.now = now;
    // Wrapped rather than passed bare: an unbound setTimeout called as
    // this.schedule(...) throws 'Illegal invocation' in a service worker.
    this.schedule = schedule || ((fn, ms) => setTimeout(fn, ms));
    this.writeDelayMs = writeDelayMs;
    this.entries = new Map();
    this.loaded = false;
    this.dirty = false;
    this.pendingWrite = null;
    this.settings = { cacheTtlDays: 30, negativeCacheTtlDays: 3, cacheMaxEntries: 20000 };
  }

  configure(settings) {
    this.settings = { ...this.settings, ...settings };
  }

  async load() {
    if (this.loaded) return;
    const data = (await this.storage.load()) || {};
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object') this.entries.set(key, value);
    }
    this.loaded = true;
  }

  _ttlFor(entry) {
    const days = entry.miss ? this.settings.negativeCacheTtlDays : this.settings.cacheTtlDays;
    return days * DAY_MS;
  }

  isFresh(entry) {
    if (!entry || typeof entry.ts !== 'number') return false;
    return this.now() - entry.ts < this._ttlFor(entry);
  }

  /** Returns the entry, or null when absent or stale. Stale entries are dropped. */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (!this.isFresh(entry)) {
      this.entries.delete(key);
      this.dirty = true;
      return null;
    }
    return entry;
  }

  set(key, value) {
    this.entries.set(key, { ...value, ts: this.now() });
    this.dirty = true;
    this._scheduleWrite();
  }

  setMiss(key) {
    this.set(key, { miss: 1 });
  }

  /** Drop the oldest entries once we are over the cap. */
  prune() {
    const max = this.settings.cacheMaxEntries;
    if (this.entries.size <= max) return 0;
    const sorted = [...this.entries.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    const excess = this.entries.size - max;
    for (let i = 0; i < excess; i += 1) this.entries.delete(sorted[i][0]);
    this.dirty = true;
    return excess;
  }

  _scheduleWrite() {
    if (this.pendingWrite) return;
    this.pendingWrite = this.schedule(() => {
      this.pendingWrite = null;
      this.flush();
    }, this.writeDelayMs);
  }

  async flush() {
    if (!this.dirty) return;
    this.prune();
    this.dirty = false;
    await this.storage.save(Object.fromEntries(this.entries));
  }

  async clear() {
    this.entries.clear();
    this.dirty = false;
    await this.storage.save({});
  }
}
