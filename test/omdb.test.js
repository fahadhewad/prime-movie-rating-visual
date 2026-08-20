import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The provider talks to chrome.storage and fetch, so both are stubbed here.
 * The response bodies are genuine OMDb payloads, captured from the live API,
 * because the fiddly parts are all in its formatting: votes arrive as
 * "1,038,179" and a series year as the en-dash range "2019-2026".
 */
function installChromeStub() {
  const store = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => (key in store ? { [key]: store[key] } : {}),
        set: async (data) => Object.assign(store, data),
      },
    },
  };
  return store;
}

const MOVIE = JSON.stringify({
  Title: 'Dune: Part One', Year: '2021', Type: 'movie',
  imdbRating: '8.0', imdbVotes: '1,038,179', imdbID: 'tt1160419', Response: 'True',
});
const SERIES = JSON.stringify({
  Title: 'The Boys', Year: '2019–2026', Type: 'series',
  imdbRating: '8.5', imdbVotes: '1,004,801', imdbID: 'tt1190634', Response: 'True',
});
const NOT_FOUND = JSON.stringify({ Response: 'False', Error: 'Movie not found!' });
const OVER_LIMIT = JSON.stringify({ Response: 'False', Error: 'Request limit reached!' });

async function load() {
  // Fresh module per test: the provider keeps a request queue in module scope.
  return import(`../src/background/providers/omdb.js?t=${Math.random()}`);
}

const KEY = { apiKey: 'test-key', dailyLimit: 1000 };

test('parses a real movie payload', async () => {
  installChromeStub();
  globalThis.fetch = async () => new Response(MOVIE, { status: 200 });
  const { lookupOmdb } = await load();
  const result = await lookupOmdb({ title: 'Dune', year: 2021, season: null }, KEY);
  assert.equal(result.rating, 8.0);
  assert.equal(result.votes, 1038179, 'comma-separated votes');
  assert.equal(result.id, 'tt1160419');
  assert.ok(result.confidence > 0.9, 'exact year match is confident');
});

test('reads the first year out of a series range', async () => {
  installChromeStub();
  globalThis.fetch = async () => new Response(SERIES, { status: 200 });
  const { lookupOmdb } = await load();
  const result = await lookupOmdb({ title: 'The Boys', year: null, season: 3 }, KEY);
  assert.equal(result.rating, 8.5);
  assert.equal(result.year, 2019, '"2019-2026" is not a number');
});

test('a season tile asks OMDb for a series', async () => {
  installChromeStub();
  let seen = '';
  globalThis.fetch = async (url) => {
    seen = String(url);
    return new Response(SERIES, { status: 200 });
  };
  const { lookupOmdb } = await load();
  await lookupOmdb({ title: 'The Boys', year: null, season: 3 }, KEY);
  assert.match(seen, /type=series/);
});

test('"not found" is a real answer, so it returns null and spends the lookup', async () => {
  const store = installChromeStub();
  globalThis.fetch = async () => new Response(NOT_FOUND, { status: 200 });
  const { lookupOmdb } = await load();
  assert.equal(await lookupOmdb({ title: 'Nope', year: null, season: null }, KEY), null);
  assert.equal(store['pvg:omdb-budget'].used, 1);
});

test('a network failure is transient, not a miss, and is refunded', async () => {
  // Regression: this used to return null, so the resolver cached a dropped
  // connection as "this title has no rating" for days - and still charged the
  // daily budget for it.
  const store = installChromeStub();
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  const { lookupOmdb, TransientOmdbError } = await load();
  await assert.rejects(
    () => lookupOmdb({ title: 'Dune', year: 2021, season: null }, KEY),
    TransientOmdbError,
  );
  assert.equal(store['pvg:omdb-budget'].used, 0, 'budget refunded');
});

test('a 5xx is transient and refunded', async () => {
  const store = installChromeStub();
  globalThis.fetch = async () => new Response('upstream boom', { status: 503 });
  const { lookupOmdb, TransientOmdbError } = await load();
  await assert.rejects(() => lookupOmdb({ title: 'Dune', year: 2021, season: null }, KEY), TransientOmdbError);
  assert.equal(store['pvg:omdb-budget'].used, 0);
});

test('a truncated body is transient and refunded', async () => {
  const store = installChromeStub();
  globalThis.fetch = async () => new Response('{"Title": "Dun', { status: 200 });
  const { lookupOmdb, TransientOmdbError } = await load();
  await assert.rejects(() => lookupOmdb({ title: 'Dune', year: 2021, season: null }, KEY), TransientOmdbError);
  assert.equal(store['pvg:omdb-budget'].used, 0);
});

test('the daily limit is respected without calling out', async () => {
  installChromeStub();
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response(MOVIE, { status: 200 });
  };
  const { lookupOmdb } = await load();
  assert.equal(await lookupOmdb({ title: 'Dune', year: 2021, season: null }, { apiKey: 'k', dailyLimit: 0 }), null);
  assert.equal(called, false, 'no request is made once the budget is gone');
});

test('quota exhaustion stops any further lookups that day', async () => {
  const store = installChromeStub();
  globalThis.fetch = async () => new Response(OVER_LIMIT, { status: 200 });
  const { lookupOmdb } = await load();
  await lookupOmdb({ title: 'Dune', year: 2021, season: null }, KEY);
  assert.equal(store['pvg:omdb-budget'].exhausted, true);
  assert.equal(await lookupOmdb({ title: 'Heat', year: 1995, season: null }, KEY), null);
});

test('an invalid key is reported rather than retried forever', async () => {
  const store = installChromeStub();
  globalThis.fetch = async () => new Response('Invalid API key!', { status: 401 });
  const { lookupOmdb } = await load();
  assert.equal(await lookupOmdb({ title: 'Dune', year: 2021, season: null }, KEY), null);
  assert.equal(store['pvg:omdb-budget'].exhausted, true);
  assert.match(store['pvg:omdb-budget'].reason, /invalid key/i);
});

test('no key means no request at all', async () => {
  installChromeStub();
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response(MOVIE, { status: 200 });
  };
  const { lookupOmdb } = await load();
  assert.equal(await lookupOmdb({ title: 'Dune', year: 2021, season: null }, { apiKey: '', dailyLimit: 1000 }), null);
  assert.equal(called, false);
});
