/**
 * Painting the glow.
 *
 * Values go on as custom properties and the actual box-shadow lives in
 * glow.css, so the look can be re-themed without touching JS, and so we only
 * ever write four properties per tile instead of a full style string.
 */

const STATE_ATTR = 'pvg';

export const STATE = {
  QUEUED: 'q',
  PENDING: 'p',
  DONE: 'd',
  MISS: 'm',
  SKIP: 'x',
};

export function markState(element, state) {
  element.dataset[STATE_ATTR] = state;
}

export function getState(element) {
  return element.dataset[STATE_ATTR] || null;
}

export function applyGlow(card, style, { rating, confidence, matchedTitle, source, showBadge }) {
  card.style.setProperty('--pvg-color', style.color);
  card.style.setProperty('--pvg-blur', style.blur);
  card.style.setProperty('--pvg-spread', style.spread);
  card.classList.add('pvg-tile');
  card.classList.toggle('pvg-uncertain', !style.certain);
  card.dataset.pvgRating = rating.toFixed(1);

  // Hover text is the cheapest honest way to expose what we matched against,
  // including when we are not sure.
  const suffix = style.certain ? '' : ` (uncertain match, ${Math.round(confidence * 100)}%)`;
  card.title = `IMDb ${rating.toFixed(1)} - ${matchedTitle}${suffix} [${source}]`;

  if (showBadge) renderBadge(card, rating, style);
  else removeBadge(card);
}

function renderBadge(card, rating, style) {
  let badge = card.querySelector(':scope > .pvg-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'pvg-badge';
    card.appendChild(badge);
  }
  badge.textContent = rating.toFixed(1);
  badge.style.setProperty('--pvg-badge-color', style.color);
}

function removeBadge(card) {
  card.querySelector(':scope > .pvg-badge')?.remove();
}

export function clearGlow(card) {
  card.classList.remove('pvg-tile', 'pvg-uncertain');
  card.style.removeProperty('--pvg-color');
  card.style.removeProperty('--pvg-blur');
  card.style.removeProperty('--pvg-spread');
  delete card.dataset.pvgRating;
  removeBadge(card);
}
