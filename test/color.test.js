import test from 'node:test';
import assert from 'node:assert/strict';
import { confidenceAlpha, glowStyle, ratingToColor, ratingToHue } from '../src/shared/color.js';

const STOPS = { low: 5.0, mid: 6.75, high: 8.5 };

test('the ramp runs red -> amber -> green across the configured band', () => {
  assert.equal(ratingToHue(5.0, STOPS), 0);
  assert.equal(ratingToHue(6.75, STOPS), 42);
  assert.equal(ratingToHue(8.5, STOPS), 122);
});

test('ratings outside the band clamp instead of wrapping the colour wheel', () => {
  assert.equal(ratingToHue(1.2, STOPS), 0);
  assert.equal(ratingToHue(4.9, STOPS), 0);
  assert.equal(ratingToHue(9.6, STOPS), 122);
  assert.equal(ratingToHue(11, STOPS), 122);
  assert.equal(ratingToHue(-3, STOPS), 0);
});

test('hue increases monotonically with rating', () => {
  let previous = -1;
  for (let rating = 0; rating <= 10; rating += 0.1) {
    const hue = ratingToHue(rating, STOPS);
    assert.ok(hue >= previous, `hue dipped at ${rating.toFixed(1)}`);
    previous = hue;
  }
});

test('a degenerate band does not divide by zero', () => {
  assert.equal(ratingToHue(7, { low: 8, mid: 8, high: 8 }), 122);
  assert.ok(Number.isFinite(ratingToHue(7, { low: 5, mid: 5, high: 8.5 })));
  assert.ok(Number.isFinite(ratingToHue(7, { low: 5, mid: 8.5, high: 8.5 })));
});

test('a mid stop outside the band is clamped back into it', () => {
  const hue = ratingToHue(7, { low: 5, mid: 99, high: 8.5 });
  assert.ok(hue >= 0 && hue <= 122);
});

test('ratingToColor emits valid CSS in both spaces', () => {
  assert.equal(ratingToColor(8.5, { ...STOPS, supportsOklch: false }), 'hsl(122 92% 52% / 1)');
  assert.equal(ratingToColor(8.5, { ...STOPS, supportsOklch: true }), 'oklch(0.74 0.185 148 / 1)');
  assert.equal(ratingToColor(5, { ...STOPS, space: 'hsl', supportsOklch: true }), 'hsl(0 92% 52% / 1)');
});

test('alpha is clamped into range', () => {
  assert.match(ratingToColor(7, { ...STOPS, alpha: 5 }), /\/ 1\)$/);
  assert.match(ratingToColor(7, { ...STOPS, alpha: -2 }), /\/ 0\)$/);
});

test('confidence fades the glow rather than hiding the uncertainty', () => {
  const bounds = { minConfidence: 0.35, confidentAt: 0.75, baseAlpha: 1 };
  assert.equal(confidenceAlpha(0.9, bounds), 1);
  assert.equal(confidenceAlpha(0.75, bounds), 1);
  assert.equal(confidenceAlpha(0.35, bounds), 0.35);
  const middling = confidenceAlpha(0.55, bounds);
  assert.ok(middling > 0.35 && middling < 1);
});

test('glowStyle marks an uncertain match and tightens its halo', () => {
  const settings = { ...STOPS, minConfidence: 0.35, confidentAt: 0.75, glowAlpha: 0.95, glowBlur: 18, glowSpread: 2, colorSpace: 'hsl' };
  const sure = glowStyle({ rating: 8.2, confidence: 0.95, settings });
  const unsure = glowStyle({ rating: 8.2, confidence: 0.5, settings });
  assert.equal(sure.certain, true);
  assert.equal(unsure.certain, false);
  assert.equal(sure.spread, '2px');
  assert.equal(unsure.spread, '1px');
  assert.notEqual(sure.color, unsure.color);
});
