/**
 * A compact in-memory join table for the dataset import.
 *
 * The import is a join: 11M rows in title.basics against 1.5M rows in
 * title.ratings. Doing that as 11M IndexedDB reads is hopeless, and a
 * Map<number, number> of 1.5M entries costs ~100MB. Two parallel Uint32Arrays
 * plus a binary search cost ~12MB and are faster, so the ratings side is held
 * here while basics streams past.
 *
 * `packed` stores votes and rating in one word:
 *   packed = votes * 128 + round(rating * 10)
 * rating*10 is 0..100 so it fits in the low 7 bits, and votes tops out around
 * 3M, well inside Uint32.
 */

const RATING_MASK = 127;
const VOTES_SHIFT = 128;

export class RatingsIndex {
  constructor(initialCapacity = 1 << 20) {
    this.ids = new Uint32Array(initialCapacity);
    this.packed = new Uint32Array(initialCapacity);
    this.length = 0;
    this.sorted = true;
    this._lastId = -1;
  }

  get size() {
    return this.length;
  }

  _grow() {
    const capacity = this.ids.length * 2;
    const ids = new Uint32Array(capacity);
    const packed = new Uint32Array(capacity);
    ids.set(this.ids);
    packed.set(this.packed);
    this.ids = ids;
    this.packed = packed;
  }

  push(id, rating, votes) {
    if (this.length === this.ids.length) this._grow();
    if (id <= this._lastId) this.sorted = false;
    this._lastId = id;
    this.ids[this.length] = id;
    this.packed[this.length] = votes * VOTES_SHIFT + Math.round(rating * 10);
    this.length += 1;
  }

  /**
   * Must be called before any lookup.
   *
   * The dumps do arrive sorted by tconst - but lexicographically, as strings.
   * Once ids pass seven digits that stops matching numeric order ('tt10001002'
   * sorts before 'tt1000102'), so on the real files this sort always runs. It
   * costs ~290ms and ~30MB for 1.7M rows, which is noise against an import that
   * takes minutes, so it is not worth a radix sort.
   */
  finalise() {
    if (!this.sorted) {
      const order = Array.from({ length: this.length }, (_, i) => i);
      order.sort((a, b) => this.ids[a] - this.ids[b]);
      const ids = new Uint32Array(this.length);
      const packed = new Uint32Array(this.length);
      for (let i = 0; i < this.length; i += 1) {
        ids[i] = this.ids[order[i]];
        packed[i] = this.packed[order[i]];
      }
      this.ids = ids;
      this.packed = packed;
      this.sorted = true;
    }
    return this;
  }

  /** Binary search. Returns null when the title has no rating. */
  get(id) {
    let lo = 0;
    let hi = this.length - 1;
    const { ids } = this;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const value = ids[mid];
      if (value === id) {
        const packed = this.packed[mid];
        return { rating: (packed & RATING_MASK) / 10, votes: Math.floor(packed / VOTES_SHIFT) };
      }
      if (value < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }
}
