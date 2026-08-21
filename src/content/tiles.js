/**
 * Finding tiles and reading what little the storefront tells us about them.
 *
 * Prime Video's markup is generated and unstable - class names churn, test ids
 * come and go - so nothing here depends on a single selector. The one durable
 * fact is that every tile is built around an artwork <img> sitting inside a link
 * to /gp/video/detail/, so images are the anchor and everything else is a
 * best-effort walk outwards from there.
 */

import { parseLabel } from '../shared/normalise.js';

/**
 * Prime Video uses two shapes of detail URL: the storefront's
 * /gp/video/detail/<asin> and the newer web client's bare /detail/<asin>.
 * Matching the shorter substring covers both.
 */
const DETAIL_LINK = 'a[href*="/detail/"]';

/** Elements that usually mark a real card boundary. */
const CARD_SELECTOR = 'li, article, [data-testid], [data-automation-id], [role="listitem"]';

/** Labels that are buttons or badges, not titles. */
const NOT_A_TITLE =
  /^(play|watch|watch now|resume|more info|details|add to watchlist|watchlist|trailer|prime|included with prime|rent or buy|buy|rent|free with ads|subscribe|top \d+|new episode)$/i;

/**
 * Age-rating badges sit inside cards and carry descriptive alt text like
 * "Suitable for ages 12 and older", which reads exactly like a title unless it
 * is named as not one.
 */
const AGE_RATING =
  /^(?:suitable for\b|rated\b|age rating\b|certificate\b|classification\b|\d{1,2}\+$|(?:u|pg|12a?|15|18|r18|nr|tv-[a-z0-9]+)$)/i;

/** Artwork is big; sprites, badges and channel logos are not. */
const MIN_ARTWORK_PX = 60;

/**
 * How much bigger than its artwork a card is allowed to be.
 *
 * Without this the walk outwards does not stop at a hero banner: its container
 * holds exactly one image, so the loop keeps climbing and the glow lands on a
 * full-width section, drawn as a stray line across the page instead of a halo
 * around a tile.
 */
const MAX_CARD_AREA_RATIO = 2.5;

/** Artwork wider than this share of the viewport is a hero banner, not a tile. */
const MAX_ARTWORK_FRACTION = 0.55;

/**
 * Candidate tile images in `root`.
 *
 * Cheap by design: this runs on every mutation batch, so it does no layout and
 * no text extraction. Anything expensive waits until the tile is on screen.
 */
export function discoverImages(root = document, tally = null) {
  const bump = (key) => {
    if (tally) tally[key] = (tally[key] || 0) + 1;
  };
  const out = [];
  for (const img of root.querySelectorAll('img')) {
    if (img.dataset.pvg) {
      bump('alreadyHandled');
      continue;
    }
    const label = (img.getAttribute('alt') || img.getAttribute('aria-label') || '').trim();
    if (label && (AGE_RATING.test(label) || NOT_A_TITLE.test(label))) {
      bump('decorative');
      continue;
    }

    const inDetailLink = Boolean(img.closest(DETAIL_LINK));
    const inCard = Boolean(img.closest(CARD_SELECTOR));
    // Artwork-sized images count on their own: a poster with an empty alt in a
    // container we do not recognise is still a tile, and the card around it can
    // usually supply the title.
    const artwork = isArtworkSized(img);

    if (!inDetailLink && !inCard && !artwork) {
      bump('notInACard');
      continue;
    }
    if (!inDetailLink && !label && !artwork) {
      bump('noLabel');
      continue;
    }
    bump('accepted');
    out.push(img);
  }
  return out;
}

/**
 * Walk out from the artwork to the element the glow should sit on.
 *
 * Stops at the first ancestor holding more than one image - that is a carousel
 * row, not a card - and prefers a semantic card boundary when it finds one.
 */
/**
 * An image whose alt text is a known non-title: an age badge, a channel logo,
 * a "Top 10" flag. Decoration, whatever size the stylesheet gives it.
 */
function isDecorativeImage(candidate) {
  const alt = (candidate.getAttribute('alt') || candidate.getAttribute('aria-label') || '').trim();
  return Boolean(alt) && (AGE_RATING.test(alt) || NOT_A_TITLE.test(alt));
}

/**
 * Is this image artwork, rather than a badge or a channel logo?
 *
 * Alt text is checked first because size is unreliable here: naturalWidth is 0
 * until the image loads, and the fallback to the CSS-driven offsetWidth can
 * make a 24px badge measure as large as the poster beside it.
 */
function isArtworkSized(candidate) {
  if (isDecorativeImage(candidate)) return false;
  const width = candidate.naturalWidth || candidate.offsetWidth || 0;
  return width >= MIN_ARTWORK_PX;
}

/** Artwork images under `node`, counted only far enough to know if it is >1. */
function artworkCount(node) {
  let count = 0;
  for (const candidate of node.querySelectorAll('img')) {
    if (!isArtworkSized(candidate)) continue;
    count += 1;
    if (count > 1) break;
  }
  return count;
}

/**
 * The semantic card an image belongs to, for reading labels out of.
 *
 * Deliberately separate from the glow target: a card holding a poster, an
 * age-rating badge and a channel logo stops the glow walk immediately, and
 * searching for a title on a bare <img> finds nothing, because an <img> has no
 * children. The title usually lives on the card, so labels are read from here.
 */
export function labelScope(img) {
  return img.closest(CARD_SELECTOR) || img.parentElement || img;
}

export function resolveCardRoot(img) {
  const artwork = img.getBoundingClientRect();
  const artworkArea = artwork.width * artwork.height;

  let best = img;
  let node = img.parentElement;
  for (let depth = 0; node && depth < 8; depth += 1) {
    if (node === document.body) break;
    // More than one *artwork* image means a row of cards, not a card. Badges
    // and logos do not count, or every card with one would stop the walk here.
    if (artworkCount(node) > 1) break;
    if (artworkArea > 0) {
      const rect = node.getBoundingClientRect();
      if (rect.width * rect.height > artworkArea * MAX_CARD_AREA_RATIO) break;
    }
    best = node;
    if (node.matches(CARD_SELECTOR)) break;
    node = node.parentElement;
  }
  return best;
}

/** Metadata that sits in a card next to the title: years, runtimes, ratings. */
const METADATA_TEXT = /^(?:\d{4}|\d+\s*(?:min|mins|minutes|h|hr|hrs|seasons?|episodes?)|[\d.]+\s*\/\s*[\d.]+|[A-Z]{1,4}-?\d{0,2}|\d+%)$/i;

/**
 * The first usable piece of leaf text inside a card.
 *
 * Only elements with no children of their own are considered, so this reads one
 * label rather than concatenating a whole card into nonsense.
 */
function leafText(card) {
  const nodes = card.querySelectorAll?.('span, div, p, h1, h2, h3, h4, figcaption');
  if (!nodes) return null;
  const limit = Math.min(nodes.length, 25);
  for (let i = 0; i < limit; i += 1) {
    const node = nodes[i];
    if (node.children.length) continue;
    const text = usableText(node.textContent);
    if (text && !METADATA_TEXT.test(text)) return text;
  }
  return null;
}

/** Resolve aria-labelledby, which Prime uses in place of a direct label. */
function labelledBy(element) {
  const ids = element?.getAttribute?.('aria-labelledby');
  if (!ids) return null;
  return ids
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent || '')
    .join(' ')
    .trim();
}

function usableText(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text.length < 2 || text.length > 200) return null;
  if (NOT_A_TITLE.test(text) || AGE_RATING.test(text)) return null;
  return text;
}

/** The best title-ish string we can find for a tile, in descending reliability. */
export function extractLabel(card, img) {
  const candidates = [
    img?.getAttribute('alt'),
    img?.getAttribute('aria-label'),
    card.getAttribute('data-card-title'),
    card.getAttribute('data-title'),
    card.querySelector('[data-testid*="title" i]')?.textContent,
    img?.closest('a')?.getAttribute('aria-label'),
    card.querySelector('a[aria-label]')?.getAttribute('aria-label'),
    card.getAttribute('aria-label'),
    card.querySelector('h1, h2, h3, h4')?.textContent,
    img?.closest('a')?.getAttribute('title'),
    img?.getAttribute('title'),
    // Artwork frequently carries alt="" with the title in visually hidden text.
    card.querySelector('[class*="screenReader" i], [class*="sr-only" i], .a-offscreen')?.textContent,
    labelledBy(card),
    labelledBy(img),
    // Last resort: the card's own text. Catches titles kept in visually hidden
    // elements, without having to guess at Prime's class names.
    leafText(card),
  ];
  for (const candidate of candidates) {
    const text = usableText(candidate);
    if (text) return text;
  }
  return null;
}

/**
 * Look for a release year rendered somewhere in the card.
 *
 * Only a token that is the entire text of some element counts - scanning the
 * whole card's text picks up episode counts and "Top 10" badges.
 */
export function extractYearFromCard(card) {
  const nodes = card.querySelectorAll('span, div, p, time');
  const limit = Math.min(nodes.length, 40);
  const maxYear = new Date().getFullYear() + 3;
  for (let i = 0; i < limit; i += 1) {
    const text = nodes[i].textContent?.trim();
    if (text && /^(?:19|20)\d{2}$/.test(text)) {
      const year = Number(text);
      if (year >= 1874 && year <= maxYear) return year;
    }
  }
  return null;
}

/** ASIN from the detail link. Stable across sessions, so it makes the best cache key. */
export function extractAsin(card, img) {
  const link = img?.closest(DETAIL_LINK) || card.querySelector?.(DETAIL_LINK);
  const href = link?.getAttribute('href');
  if (!href) return null;
  const match = href.match(/\/detail\/([A-Za-z0-9]{8,})/);
  return match ? match[1] : null;
}

/**
 * Full-bleed hero artwork, which is a banner rather than a tile.
 *
 * A halo around something that spans the whole viewport has no outside edges to
 * show, so it renders as a bar across the page instead of a glow around a
 * title - which reads as a rendering fault, not a rating.
 */
export function looksLikeHero(img, viewportWidth = window.innerWidth) {
  const width = img.getBoundingClientRect().width;
  return viewportWidth > 0 && width > viewportWidth * MAX_ARTWORK_FRACTION;
}

/** Artwork that has laid out too small to be a real tile. */
export function looksTooSmall(img) {
  const width = img.naturalWidth || img.width || img.getBoundingClientRect().width;
  return width > 0 && width < MIN_ARTWORK_PX;
}

/**
 * Everything we know about one tile, or null when it is not describable yet
 * (lazy-loaded artwork often has no alt text on first paint).
 */
export function describeTile(img) {
  const card = resolveCardRoot(img);
  // Glow the artwork, but read the title, year and ASIN from the whole card.
  const scope = labelScope(img);
  const label = extractLabel(scope, img) || extractLabel(card, img);
  if (!label) return null;

  const parsed = parseLabel(label);
  if (!parsed.title) return null;

  return {
    card,
    img,
    label,
    request: {
      title: parsed.title,
      year: parsed.year ?? extractYearFromCard(scope),
      season: parsed.season,
      asin: extractAsin(scope, img),
    },
  };
}
