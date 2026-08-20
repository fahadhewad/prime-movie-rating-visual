import test from 'node:test';
import assert from 'node:assert/strict';
import { LookupCache } from '../src/shared/cache.js';

const DAY = 24 * 60 * 60 * 1000;

function harness({ initial = {}, start = 1_000_000 } = {}) {
  let saved = { ...initial };
  let clock = start;
  const cache = new LookupCache({
    storage: {
      load: async () => ({ ...saved }),
      save: async (data) => {
        saved = { ...data };
      },
    },
    now: () => clock,
    // Run writes inline so tests do not wait on timers.
    schedule: (fn) => {
      fn();
      return null;
    },
    writeDelayMs: 0,
  });
  cache.configure({ cacheTtlDays: 30, negativeCacheTtlDays: 3, cacheMaxEntries: 5 });
  return { cache, advance: (ms) => { clock += ms; }, saved: () => saved };
}

test('a stored hit comes back', async () => {
  const { cache } = harness();
  await cache.load();
  cache.set('asin:B01', { r: 7.7, v: 1000, c: 0.9, s: 'dataset' });
  assert.equal(cache.get('asin:B01').r, 7.7);
  assert.equal(cache.get('asin:missing'), null);
});

test('entries persist through storage', async () => {
  const { cache, saved } = harness();
  await cache.load();
  cache.set('asin:B01', { r: 7.7 });
  await cache.flush();
  assert.equal(saved()['asin:B01'].r, 7.7);
  assert.equal(typeof saved()['asin:B01'].ts, 'number');
});

test('a loaded cache sees what a previous session wrote', async () => {
  const { cache } = harness({ initial: { 'asin:B01': { r: 6.1, ts: 1_000_000 } } });
  await cache.load();
  assert.equal(cache.get('asin:B01').r, 6.1);
});

test('hits expire after the positive TTL', async () => {
  const { cache, advance } = harness();
  await cache.load();
  cache.set('asin:B01', { r: 7.7 });
  advance(29 * DAY);
  assert.ok(cache.get('asin:B01'));
  advance(2 * DAY);
  assert.equal(cache.get('asin:B01'), null);
});

test('misses expire sooner than hits', async () => {
  const { cache, advance } = harness();
  await cache.load();
  cache.setMiss('t:unknowable|y:-');
  advance(2 * DAY);
  assert.equal(cache.get('t:unknowable|y:-').miss, 1, 'still remembered, so we do not re-query');
  advance(2 * DAY);
  assert.equal(cache.get('t:unknowable|y:-'), null, 'but retried eventually');
});

test('reading a stale entry evicts it', async () => {
  const { cache, advance } = harness();
  await cache.load();
  cache.set('asin:B01', { r: 7.7 });
  advance(31 * DAY);
  cache.get('asin:B01');
  assert.equal(cache.entries.has('asin:B01'), false);
});

test('pruning drops the oldest entries once over the cap', async () => {
  const { cache, advance, saved } = harness();
  await cache.load();
  for (let i = 0; i < 8; i += 1) {
    cache.set(`asin:B0${i}`, { r: i });
    advance(1000);
  }
  await cache.flush();
  const keys = Object.keys(saved());
  assert.equal(keys.length, 5);
  assert.ok(!keys.includes('asin:B00'));
  assert.ok(keys.includes('asin:B07'));
});

test('clear empties both memory and storage', async () => {
  const { cache, saved } = harness();
  await cache.load();
  cache.set('asin:B01', { r: 7.7 });
  await cache.flush();
  await cache.clear();
  assert.equal(cache.get('asin:B01'), null);
  assert.deepEqual(saved(), {});
});

test('flushing a clean cache does not write', async () => {
  const { cache, saved } = harness({ initial: { existing: { r: 1, ts: 1_000_000 } } });
  await cache.load();
  await cache.flush();
  assert.deepEqual(Object.keys(saved()), ['existing']);
});

test('the default scheduler works when called as a method', async () => {
  // Regression: the default used to be a bare `setTimeout`, so calling it as
  // this.schedule(...) invoked it with the cache as `this`. That throws
  // "Illegal invocation" in a service worker, which turned every lookup into a
  // transient failure. Every other test injects its own scheduler, so only an
  // instance built the way the extension builds it catches this.
  let saved = null;
  const cache = new LookupCache({
    storage: { load: async () => ({}), save: async (data) => { saved = data; } },
    writeDelayMs: 1,
  });
  await cache.load();
  assert.doesNotThrow(() => cache.set('asin:B01', { r: 7.7 }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(saved?.['asin:B01']?.r, 7.7, 'the debounced write actually ran');
});

test('clearMisses drops misses and keeps hits', async () => {
  // Regression: loading Prime with no ratings source cached every title as a
  // miss, and the negative TTL then hid them for days - so importing the
  // dataset appeared to do nothing at all.
  const { cache, saved } = harness();
  await cache.load();
  cache.set('asin:B01', { r: 8.2 });
  cache.setMiss('asin:B02');
  cache.setMiss('asin:B03');

  assert.equal(cache.clearMisses(), 2);
  assert.equal(cache.get('asin:B01').r, 8.2, 'a real rating survives');
  assert.equal(cache.get('asin:B02'), null);
  assert.equal(cache.get('asin:B03'), null);

  await cache.flush();
  assert.deepEqual(Object.keys(saved()), ['asin:B01']);
});

test('clearMisses on a cache with no misses is a no-op', async () => {
  const { cache } = harness();
  await cache.load();
  cache.set('asin:B01', { r: 8.2 });
  assert.equal(cache.clearMisses(), 0);
  assert.equal(cache.get('asin:B01').r, 8.2);
});

test('reload picks up writes made by another context', async () => {
  // The service worker and the options page each hold their own instance over
  // the same storage. load() is one-shot, so acting on the true contents has to
  // be asked for.
  let backing = { 'asin:B01': { r: 8.2, ts: 1_000_000 } };
  const cache = new LookupCache({
    storage: {
      load: async () => ({ ...backing }),
      save: async (data) => { backing = { ...data }; },
    },
    now: () => 1_000_000,
    schedule: (fn) => { fn(); return null; },
  });
  await cache.load();
  assert.equal(cache.entries.size, 1);

  // Another context writes a miss straight to storage.
  backing['asin:B02'] = { miss: 1, ts: 1_000_000 };
  await cache.load();
  assert.equal(cache.entries.size, 1, 'load() alone does not re-read');

  await cache.reload();
  assert.equal(cache.entries.size, 2, 'reload() does');
  assert.equal(cache.clearMisses(), 1);
});

test('reload does not lose writes that had not been flushed', async () => {
  let backing = {};
  const cache = new LookupCache({
    storage: {
      load: async () => ({ ...backing }),
      save: async (data) => { backing = { ...data }; },
    },
    now: () => 1_000_000,
    // Never fire the debounce, so the write is still pending at reload time.
    schedule: () => null,
  });
  await cache.load();
  cache.set('asin:B01', { r: 7.1 });
  await cache.reload();
  assert.equal(cache.get('asin:B01')?.r, 7.1);
});
