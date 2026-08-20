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
