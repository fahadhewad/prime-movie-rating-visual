import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheKey,
  extractSeason,
  keysFor,
  looseKey,
  normaliseTitle,
  parseLabel,
  recordKeys,
  splitTitleYear,
  stripNoise,
  strictKey,
} from '../src/shared/normalise.js';

test('stripNoise removes storefront chrome', () => {
  assert.equal(stripNoise('Watch The Boys | Prime Video'), 'The Boys');
  assert.equal(stripNoise("Ocean's Eleven [Blu-ray]"), "Ocean's Eleven");
  assert.equal(stripNoise('Dune (4K UHD)'), 'Dune');
  assert.equal(stripNoise('Parasite (Subtitled)'), 'Parasite');
  assert.equal(stripNoise('Heat - Official Trailer'), 'Heat');
});

test('stripNoise never strips a title down to nothing', () => {
  assert.equal(stripNoise('Prime Video'), 'Prime Video');
  assert.equal(stripNoise('Watch'), 'Watch');
});

test('splitTitleYear pulls a year out only when a title survives', () => {
  assert.deepEqual(splitTitleYear('Dune (2021)'), { title: 'Dune', year: 2021 });
  // 2049 is part of the name, not a release year - it is decades past plausible.
  assert.deepEqual(splitTitleYear('Blade Runner 2049'), { title: 'Blade Runner 2049', year: null });
  assert.deepEqual(splitTitleYear('Space Odyssey 1999'), { title: 'Space Odyssey', year: 1999 });
  // The film "2012" is not a year-suffixed title.
  assert.deepEqual(splitTitleYear('2012'), { title: '2012', year: null });
  assert.deepEqual(splitTitleYear('1917'), { title: '1917', year: null });
});

test('extractSeason finds season numbers in several dialects', () => {
  assert.equal(extractSeason('The Boys - Season 3'), 3);
  assert.equal(extractSeason('Sherlock: Series 4'), 4);
  assert.equal(extractSeason('Dune'), null);
});

test('parseLabel handles a realistic Prime aria-label', () => {
  assert.deepEqual(parseLabel('Watch The Boys - Season 3 | Prime Video'), {
    title: 'The Boys',
    year: null,
    season: 3,
    cleaned: 'The Boys - Season 3',
  });
});

test('parseLabel keeps title and year apart when both are present', () => {
  const parsed = parseLabel('Watch The Thing (1982) | Prime Video');
  assert.equal(parsed.title, 'The Thing');
  assert.equal(parsed.year, 1982);
});

test('normaliseTitle folds accents, punctuation and ampersands', () => {
  assert.equal(normaliseTitle('Amélie'), 'amelie');
  assert.equal(normaliseTitle('Léon: The Professional'), 'leon the professional');
  assert.equal(normaliseTitle('Fast & Furious'), 'fast and furious');
  assert.equal(normaliseTitle("Ocean's Eleven"), 'oceans eleven');
  assert.equal(normaliseTitle('Mission: Impossible - Fallout'), 'mission impossible fallout');
});

test('looseKey drops leading articles and folds roman numerals', () => {
  assert.equal(looseKey('The Godfather Part II'), 'godfather part 2');
  assert.equal(looseKey('Godfather Part 2'), 'godfather part 2');
  assert.equal(looseKey('A Quiet Place'), 'quiet place');
  assert.equal(strictKey('The Godfather Part II'), 'the godfather part ii');
});

test('keysFor returns both forms without duplicates', () => {
  assert.deepEqual(keysFor('Dune'), ['dune']);
  assert.deepEqual(keysFor('The Thing'), ['the thing', 'thing']);
});

test('recordKeys covers primary and original titles', () => {
  const keys = recordKeys('The Wages of Fear', 'Le salaire de la peur');
  assert.ok(keys.includes('the wages of fear'));
  assert.ok(keys.includes('wages of fear'));
  assert.ok(keys.includes('le salaire de la peur'));
  assert.ok(keys.includes('salaire de la peur'));
});

test('cacheKey prefers the ASIN because it is stable', () => {
  assert.equal(cacheKey({ asin: 'B08KHFHVQ2', title: 'Dune', year: 2021 }), 'asin:B08KHFHVQ2');
  assert.equal(cacheKey({ title: 'The Thing', year: 1982 }), 't:thing|y:1982');
  assert.equal(cacheKey({ title: 'The Thing' }), 't:thing|y:-');
});
