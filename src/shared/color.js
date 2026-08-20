/**
 * Rating -> glow colour.
 *
 * The ramp is a stop table rather than a straight hue lerp. A naive 0deg->120deg
 * interpolation puts pure yellow (60deg) at the midpoint and skips amber almost
 * entirely; pinning an explicit amber stop at `mid` gives the low half more room
 * and keeps a 6.5 looking meaningfully different from a 7.5.
 *
 * Pure functions - no DOM - so the node tests can drive the ramp directly.
 */

/** Hue stops in HSL degrees: red -> amber -> green. */
const HSL_STOPS = { low: 0, mid: 42, high: 122 };

/** The same three colours in OKLCH, where equal hue steps look equal. */
const OKLCH_STOPS = { low: 27, mid: 72, high: 148 };
const OKLCH_L = 0.74;
const OKLCH_C = 0.185;

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Map a rating onto a hue using the three-stop ramp. Ratings at or below `low`
 * are fully red, at or above `high` fully green.
 */
export function ratingToHue(rating, { low, mid, high }, stops = HSL_STOPS) {
  const value = clamp(Number(rating), 0, 10);
  // A degenerate or inverted config would otherwise divide by zero.
  const safeMid = clamp(mid, low, high);
  if (!(high > low)) return stops.high;
  if (value <= low) return stops.low;
  if (value >= high) return stops.high;
  if (value <= safeMid) {
    const span = safeMid - low;
    return span > 0 ? lerp(stops.low, stops.mid, (value - low) / span) : stops.mid;
  }
  const span = high - safeMid;
  return span > 0 ? lerp(stops.mid, stops.high, (value - safeMid) / span) : stops.high;
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * A CSS colour string for a rating.
 *
 * `space` of 'auto' resolves to OKLCH when the caller says the browser supports
 * it, otherwise HSL. `supportsOklch` is injected so this stays testable.
 */
export function ratingToColor(rating, options = {}) {
  const {
    low = 5.0,
    mid = 6.75,
    high = 8.5,
    alpha = 1,
    space = 'auto',
    supportsOklch = false,
  } = options;

  const useOklch = space === 'oklch' || (space === 'auto' && supportsOklch);
  const a = round(clamp01(alpha), 3);

  if (useOklch) {
    const hue = round(ratingToHue(rating, { low, mid, high }, OKLCH_STOPS), 1);
    return `oklch(${OKLCH_L} ${OKLCH_C} ${hue} / ${a})`;
  }
  const hue = round(ratingToHue(rating, { low, mid, high }, HSL_STOPS), 1);
  return `hsl(${hue} 92% 52% / ${a})`;
}

/**
 * How opaque the glow should be given how sure we are of the match.
 *
 * A confident match glows at full strength. A shakier one - a remake we could
 * not pin to a year - fades toward `floor` instead of quietly lying about a
 * rating that might belong to a different film.
 */
export function confidenceAlpha(confidence, { minConfidence, confidentAt, baseAlpha }, floor = 0.35) {
  const c = clamp01(Number(confidence) || 0);
  if (c >= confidentAt) return baseAlpha;
  const span = confidentAt - minConfidence;
  const t = span > 0 ? clamp01((c - minConfidence) / span) : 0;
  return baseAlpha * lerp(floor, 1, t);
}

/**
 * Everything the content script needs to paint one tile, as CSS custom
 * property values.
 */
export function glowStyle({ rating, confidence = 1, settings, supportsOklch = false }) {
  const alpha = confidenceAlpha(confidence, {
    minConfidence: settings.minConfidence,
    confidentAt: settings.confidentAt,
    baseAlpha: settings.glowAlpha,
  });
  const certain = confidence >= settings.confidentAt;
  return {
    color: ratingToColor(rating, {
      low: settings.low,
      mid: settings.mid,
      high: settings.high,
      alpha,
      space: settings.colorSpace,
      supportsOklch,
    }),
    blur: `${settings.glowBlur}px`,
    // An uncertain match gets a tighter, softer halo as well as a fainter one.
    spread: `${certain ? settings.glowSpread : Math.max(0, settings.glowSpread - 1)}px`,
    certain,
  };
}
