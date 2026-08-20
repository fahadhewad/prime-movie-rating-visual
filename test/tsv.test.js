import test from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter, idToTconst, parseBasicsLine, parseRatingsLine, tconstToId } from '../src/shared/tsv.js';
import { RatingsIndex } from '../src/shared/ratings-index.js';

test('LineSplitter reassembles lines across chunk boundaries', () => {
  const splitter = new LineSplitter();
  assert.deepEqual(splitter.feed('alpha\nbra'), ['alpha']);
  assert.deepEqual(splitter.feed('vo\ncharlie\n'), ['bravo', 'charlie']);
  assert.deepEqual(splitter.feed('delta'), []);
  assert.deepEqual(splitter.flush(), ['delta']);
  assert.deepEqual(splitter.flush(), []);
});

test('tconst ids round-trip', () => {
  assert.equal(tconstToId('tt0111161'), 111161);
  assert.equal(idToTconst(111161), 'tt0111161');
  assert.equal(idToTconst(tconstToId('tt15398776')), 'tt15398776');
  assert.equal(tconstToId('nm0000001'), -1);
  assert.equal(tconstToId(''), -1);
  assert.equal(tconstToId(null), -1);
});

test('parseRatingsLine reads a ratings row and skips the header', () => {
  assert.equal(parseRatingsLine('tconst\taverageRating\tnumVotes'), null);
  assert.deepEqual(parseRatingsLine('tt0111161\t9.3\t2900000'), { id: 111161, rating: 9.3, votes: 2900000 });
  assert.equal(parseRatingsLine('tt0111161\t9.3'), null);
  assert.equal(parseRatingsLine(''), null);
});

test('parseBasicsLine reads a basics row and honours IMDb nulls', () => {
  const row = parseBasicsLine('tt0111161\tmovie\tThe Shawshank Redemption\tThe Shawshank Redemption\t0\t1994\t\\N\t142\tDrama');
  assert.deepEqual(row, {
    id: 111161,
    titleType: 'movie',
    primaryTitle: 'The Shawshank Redemption',
    originalTitle: 'The Shawshank Redemption',
    isAdult: false,
    startYear: 1994,
  });
  const undated = parseBasicsLine('tt9999999\ttvSeries\tSomething\t\\N\t1\t\\N\t\\N\t\\N\t\\N');
  assert.equal(undated.startYear, null);
  assert.equal(undated.originalTitle, null);
  assert.equal(undated.isAdult, true);
  assert.equal(parseBasicsLine('tconst\ttitleType\tprimaryTitle'), null);
});

test('RatingsIndex stores and finds ratings after finalise', () => {
  const index = new RatingsIndex(4);
  index.push(100, 7.5, 1234);
  index.push(200, 9.3, 2900000);
  index.push(300, 1.9, 8);
  index.finalise();
  assert.equal(index.size, 3);
  assert.deepEqual(index.get(100), { rating: 7.5, votes: 1234 });
  assert.deepEqual(index.get(200), { rating: 9.3, votes: 2900000 });
  assert.deepEqual(index.get(300), { rating: 1.9, votes: 8 });
  assert.equal(index.get(150), null);
  assert.equal(index.get(0), null);
  assert.equal(index.get(999), null);
});

test('RatingsIndex grows past its initial capacity', () => {
  const index = new RatingsIndex(2);
  for (let i = 1; i <= 1000; i += 1) index.push(i * 3, (i % 100) / 10, i);
  index.finalise();
  assert.equal(index.size, 1000);
  assert.deepEqual(index.get(3), { rating: 0.1, votes: 1 });
  assert.deepEqual(index.get(3000), { rating: 0, votes: 1000 });
  assert.equal(index.get(3001), null);
});

test('RatingsIndex sorts input that did not arrive in tconst order', () => {
  const index = new RatingsIndex(8);
  for (const [id, rating, votes] of [[500, 5.5, 50], [100, 1.1, 10], [900, 9.9, 90], [300, 3.3, 30]]) {
    index.push(id, rating, votes);
  }
  assert.equal(index.sorted, false);
  index.finalise();
  assert.equal(index.sorted, true);
  assert.deepEqual(index.get(100), { rating: 1.1, votes: 10 });
  assert.deepEqual(index.get(900), { rating: 9.9, votes: 90 });
  assert.deepEqual(index.get(300), { rating: 3.3, votes: 30 });
});

test('every rating value survives the pack/unpack round trip', () => {
  const index = new RatingsIndex(256);
  let id = 1;
  for (let tenths = 0; tenths <= 100; tenths += 1) index.push(id++, tenths / 10, tenths * 977);
  index.finalise();
  id = 1;
  for (let tenths = 0; tenths <= 100; tenths += 1) {
    assert.deepEqual(index.get(id++), { rating: tenths / 10, votes: tenths * 977 });
  }
});

test('packing survives a vote count larger than any real film', () => {
  const index = new RatingsIndex(2);
  index.push(1, 9.3, 3_000_000);
  index.finalise();
  assert.deepEqual(index.get(1), { rating: 9.3, votes: 3_000_000 });
});

test('input in IMDb dump order is sorted correctly', () => {
  // The real dumps are sorted lexicographically by tconst, which stops matching
  // numeric order once ids pass seven digits: 'tt10001002' < 'tt1000102' as
  // strings, but 10001002 > 1000102 as numbers. Verified against the live file,
  // where numeric order first breaks around line 475,575.
  const tconsts = ['tt0000001', 'tt1000100', 'tt10001002', 'tt1000102', 'tt10001058', 'tt9999999'];
  const index = new RatingsIndex(4);
  tconsts.forEach((tconst, i) => index.push(tconstToId(tconst), (i % 10) + 0.5, (i + 1) * 100));
  assert.equal(index.sorted, false, 'dump order is not numerically sorted');
  index.finalise();
  for (let i = 0; i < index.length - 1; i += 1) {
    assert.ok(index.ids[i] < index.ids[i + 1], 'ids are ascending after finalise');
  }
  tconsts.forEach((tconst, i) => {
    assert.deepEqual(index.get(tconstToId(tconst)), { rating: (i % 10) + 0.5, votes: (i + 1) * 100 });
  });
});
