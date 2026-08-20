import test from 'node:test';
import assert from 'node:assert/strict';
import { makeQuery, pickBest, scoreCandidate } from '../src/shared/match.js';

const thing1982 = { id: 84787, t: 'The Thing', y: 1982, ty: 'movie', r: 8.2, v: 440000, k: ['the thing', 'thing'] };
const thing2011 = { id: 905372, t: 'The Thing', y: 2011, ty: 'movie', r: 6.2, v: 150000, k: ['the thing', 'thing'] };
const thingShort = { id: 9999999, t: 'The Thing', y: 2018, ty: 'short', r: 7.9, v: 12, k: ['the thing', 'thing'] };
const remakes = [thing1982, thing2011, thingShort];

test('a year resolves a remake exactly', () => {
  assert.equal(pickBest(remakes, makeQuery({ title: 'The Thing', year: 2011 })).record.id, thing2011.id);
  assert.equal(pickBest(remakes, makeQuery({ title: 'The Thing', year: 1982 })).record.id, thing1982.id);
});

test('an exact year match is reported as certain', () => {
  const result = pickBest(remakes, makeQuery({ title: 'The Thing', year: 1982 }));
  assert.ok(result.confidence > 0.9);
});

test('without a year we still pick the likeliest, but say we are unsure', () => {
  const result = pickBest(remakes, makeQuery({ title: 'The Thing' }));
  assert.equal(result.record.id, thing1982.id, 'falls back to the most-voted candidate');
  assert.ok(result.confidence < 0.75, 'but does not claim certainty');
  assert.ok(result.confidence > 0.35, 'and is still worth drawing');
  assert.equal(result.candidateCount, 3);
});

test('an unambiguous title with no year is still confident', () => {
  const only = [{ id: 1, t: 'Paddington', y: 2014, ty: 'movie', r: 7.3, v: 120000, k: ['paddington'] }];
  const result = pickBest(only, makeQuery({ title: 'Paddington' }));
  assert.ok(result.confidence > 0.75);
});

test('a season hint pushes the series above the film of the same name', () => {
  const candidates = [
    { id: 1, t: 'Fargo', y: 1996, ty: 'movie', r: 8.1, v: 700000, k: ['fargo'] },
    { id: 2, t: 'Fargo', y: 2014, ty: 'tvSeries', r: 8.9, v: 380000, k: ['fargo'] },
  ];
  assert.equal(pickBest(candidates, makeQuery({ title: 'Fargo', season: 3 })).record.ty, 'tvSeries');
  assert.equal(pickBest(candidates, makeQuery({ title: 'Fargo' })).record.ty, 'movie');
});

test('a wildly wrong year is penalised below a plausible one', () => {
  const query = makeQuery({ title: 'The Thing', year: 1982 });
  assert.ok(scoreCandidate(thing1982, query).score > scoreCandidate(thing2011, query).score);
});

test('candidates that do not actually match the key are discarded', () => {
  const noise = [{ id: 5, t: 'Something Else', y: 2001, ty: 'movie', r: 9.9, v: 999999, k: ['something else'] }];
  assert.equal(pickBest(noise, makeQuery({ title: 'The Thing' })), null);
});

test('an empty candidate list yields no match rather than a guess', () => {
  assert.equal(pickBest([], makeQuery({ title: 'Whatever' })), null);
  assert.equal(pickBest(null, makeQuery({ title: 'Whatever' })), null);
});

test('a strict key beats a loose one when both are on offer', () => {
  const candidates = [
    { id: 1, t: 'Godfather Part 2', y: 1974, ty: 'movie', r: 9.0, v: 1300000, k: ['godfather part 2'] },
    { id: 2, t: 'The Godfather Part II', y: 1974, ty: 'movie', r: 9.0, v: 1300000, k: ['the godfather part ii', 'godfather part 2'] },
  ];
  const result = pickBest(candidates, makeQuery({ title: 'The Godfather Part II', year: 1974 }));
  assert.equal(result.record.id, 2);
  assert.equal(result.keyMatch, 'strict');
});
