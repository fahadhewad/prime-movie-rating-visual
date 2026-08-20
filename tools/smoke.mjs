/**
 * End-to-end smoke test in a real Chromium with the extension loaded.
 *
 * Prime Video's markup churns, so the useful question is not "do the pure
 * functions pass" - the node tests answer that - but "does the whole chain
 * still light up a tile". This imports a miniature IMDb dataset through the
 * real import pipeline, serves a fixture page at the real storefront URL so the
 * content script's match pattern applies, and checks that glows land.
 *
 * Needs playwright-core and the Chromium at PLAYWRIGHT_BROWSERS_PATH:
 *   npm install --no-save playwright-core && node tools/smoke.mjs
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.log('SKIP: playwright-core is not installed (npm install --no-save playwright-core)');
  process.exit(0);
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(base)) return null;
  for (const entry of readdirSync(base)) {
    if (!entry.startsWith('chromium-')) continue;
    const candidate = join(base, entry, 'chrome-linux', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** A miniature stand-in for the real dumps, including a remake to disambiguate. */
const RATINGS_TSV = [
  'tconst\taverageRating\tnumVotes',
  'tt0084787\t8.2\t440000', // The Thing (1982)
  'tt0905372\t6.2\t150000', // The Thing (2011)
  'tt1160419\t8.0\t780000', // Dune (2021)
  'tt1190634\t8.7\t620000', // The Boys (series)
  'tt0068646\t9.2\t1900000', // The Godfather
  'tt0000009\t5.3\t50', // too few votes: must be filtered out
].join('\n');

const BASICS_TSV = [
  'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres',
  'tt0084787\tmovie\tThe Thing\tThe Thing\t0\t1982\t\\N\t109\tHorror',
  'tt0905372\tmovie\tThe Thing\tThe Thing\t0\t2011\t\\N\t103\tHorror',
  'tt1160419\tmovie\tDune\tDune\t0\t2021\t\\N\t155\tSci-Fi',
  'tt1190634\ttvSeries\tThe Boys\tThe Boys\t0\t2019\t\\N\t60\tAction',
  'tt0068646\tmovie\tThe Godfather\tThe Godfather\t0\t1972\t\\N\t175\tCrime',
  'tt0000009\tmovie\tMiss Jerry\tMiss Jerry\t0\t1894\t\\N\t45\tRomance',
  'tt9999998\tmovie\tUnrated Obscurity\tUnrated Obscurity\t0\t2020\t\\N\t90\tDrama',
].join('\n');

const ART = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='220'%3E%3Crect width='150' height='220' fill='%23333'/%3E%3C/svg%3E";
const HERO_ART = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1280' height='400'%3E%3Crect width='1280' height='400' fill='%23222'/%3E%3C/svg%3E";

/** Mimics the shape of a Prime storefront row: cards, detail links, alt text. */
function fixture() {
  const tile = (label, asin, year) => `
    <li data-testid="card">
      <a href="/gp/video/detail/${asin}/ref=atv_dp">
        <img alt="${label}" src="${ART}">
      </a>
      ${year ? `<div class="meta"><span>${year}</span></div>` : ''}
    </li>`;

  // A full-bleed hero, then a row of cards. The hero's container holds exactly
  // one image, which is what used to send the card walk all the way up to it.
  const hero = `<div class="hero"><div class="inner">
      <a href="/detail/B09HERO001/ref=x"><img alt="Dune" src="${HERO_ART}"></a>
    </div></div>`;

  // The newer web client links to /detail/<asin> rather than /gp/video/detail/,
  // and often leaves alt empty with the title in a label or hidden text.
  const modern = `
    <li data-testid="card"><a href="/detail/B09OPPN001/ref=x" aria-label="The Godfather">
      <img alt="" src="${ART}"></a></li>
    <li data-testid="card"><a href="/detail/B09HIDE001/ref=x">
      <img alt="" src="${ART}"><span class="sr">The Thing</span></a></li>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Prime Video</title>
    <style>body{background:#0f171e;margin:0}ul{display:flex;gap:12px;list-style:none;padding:20px}
    li{width:150px}li img{width:150px;height:220px;display:block}.meta{color:#aaa;font:12px sans-serif}
    .hero{width:100%;height:400px}.hero img{width:100%;height:400px;display:block}
    .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style>
    </head><body>
    ${hero}
    <ul data-testid="carousel">
      ${tile('Dune', 'B09KHFHVQ2', 2021)}
      ${tile('Watch The Boys - Season 3 | Prime Video', 'B09BOYS001', '')}
      ${tile('The Godfather', 'B09GODF001', 1972)}
      ${tile('The Thing', 'B09THING82', 1982)}
      ${tile('Nothing Anyone Has Ever Rated', 'B09NOPE001', 2020)}
      ${modern}
    </ul>
    <div id="late"></div>
    </body></html>`;
}

const executablePath = findChromium();
if (!executablePath) {
  console.log('SKIP: no Chromium found');
  process.exit(0);
}

const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
    failures.push(name);
  }
};

const userDataDir = mkdtempSync(join(tmpdir(), 'pvg-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: true,
  args: [
    '--headless=new',
    '--no-sandbox',
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
  ],
});

try {
  // The worker registers on first load; give it a moment if it is not up yet.
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  console.log(`extension id ${extensionId}`);

  // --- 1. Import a miniature dataset through the real pipeline -------------
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);

  const imported = await optionsPage.evaluate(
    async ([ratingsTsv, basicsTsv]) => {
      const { importDatasets } = await import('/src/db/import.js');
      const { countTitles } = await import('/src/db/idb.js');
      const file = (name, text) => new File([text], name, { type: 'text/tab-separated-values' });
      const meta = await importDatasets({
        ratings: file('title.ratings.tsv', ratingsTsv),
        basics: file('title.basics.tsv', basicsTsv),
        minVotes: 100,
        titleTypes: ['movie', 'tvMovie', 'tvSeries', 'tvMiniSeries', 'tvSpecial', 'video'],
      });
      return { meta, stored: await countTitles() };
    },
    [RATINGS_TSV, BASICS_TSV],
  );

  console.log('\ndataset import');
  check('import stores the rated titles', imported.stored === 5, `stored ${imported.stored}`);
  check('low-vote titles are filtered out', imported.meta.storedTitles === 5);
  check('ratings index saw every rated row', imported.meta.ratedTitles === 6);

  // --- 2. Query the dataset provider directly ------------------------------
  const lookups = await optionsPage.evaluate(async () => {
    const { lookupDataset } = await import('/src/background/providers/dataset.js');
    const ask = (request) => lookupDataset(request);
    return {
      dune: await ask({ title: 'Dune', year: 2021, season: null }),
      thing1982: await ask({ title: 'The Thing', year: 1982, season: null }),
      thing2011: await ask({ title: 'The Thing', year: 2011, season: null }),
      thingNoYear: await ask({ title: 'The Thing', year: null, season: null }),
      boys: await ask({ title: 'The Boys', year: null, season: 3 }),
      missing: await ask({ title: 'Nothing Anyone Has Ever Rated', year: 2020, season: null }),
    };
  });

  console.log('\ndataset lookups');
  check('finds a plain title', lookups.dune?.rating === 8.0, JSON.stringify(lookups.dune));
  check('a year picks the right remake', lookups.thing1982?.rating === 8.2 && lookups.thing2011?.rating === 6.2);
  check('an exact year match is confident', lookups.thing1982?.confidence > 0.9);
  check('no year still resolves', lookups.thingNoYear?.rating === 8.2);
  check(
    'no year is reported as uncertain',
    lookups.thingNoYear?.confidence < 0.75,
    `confidence ${lookups.thingNoYear?.confidence}`,
  );
  check('a season label finds the series', lookups.boys?.rating === 8.7);
  check('an unknown title returns nothing', lookups.missing === null);

  // --- 3. Transport failures must not be cached as "no rating" -------------
  const failure = await optionsPage.evaluate(async () => {
    const { resolveOne, cache } = await import('/src/background/resolver.js');
    const settings = {
      provider: 'omdb', omdbApiKey: 'test-key', omdbDailyLimit: 1000,
      cacheTtlDays: 30, negativeCacheTtlDays: 3, cacheMaxEntries: 500,
    };
    const real = window.fetch;
    const out = {};
    try {
      window.fetch = async () => { throw new TypeError('Failed to fetch'); };
      out.dropped = await resolveOne(
        { title: 'Connection Dropped Here', year: null, season: null, asin: 'BDROPPED01' }, settings,
      );
      out.droppedCached = cache.entries.has('asin:BDROPPED01');

      window.fetch = async () =>
        new Response(JSON.stringify({ Response: 'False', Error: 'Movie not found!' }), { status: 200 });
      out.notFound = await resolveOne(
        { title: 'Genuinely Unknown Title', year: null, season: null, asin: 'BUNKNOWN01' }, settings,
      );
      out.notFoundCached = cache.entries.has('asin:BUNKNOWN01');
    } finally {
      window.fetch = real;
    }
    return out;
  });

  // Configuring a ratings source must un-stick titles cached as misses while
  // there was nowhere to look them up.
  const recovery = await optionsPage.evaluate(async () => {
    const { cache } = await import('/src/background/resolver.js');
    await cache.load();
    // Writes are debounced; make sure the miss has actually reached storage
    // before asking the worker to act on it.
    await cache.flush();
    const before = cache.entries.has('asin:BUNKNOWN01');
    const reply = await chrome.runtime.sendMessage({ type: 'pvg:sources-changed' });
    // Observe the true contents, not this context's stale view.
    await cache.reload();
    return { before, reply, after: cache.entries.has('asin:BUNKNOWN01') };
  });

  console.log('\nfailure handling');
  check('a dropped connection is reported as transient', failure.dropped?.transient === true);
  check('a dropped connection is NOT cached as a miss', failure.droppedCached === false);
  check('a genuine "not found" is a miss', failure.notFound?.miss === true);
  check('a genuine "not found" IS cached', failure.notFoundCached === true);
  check('configuring a source clears cached misses', recovery.before === true && recovery.after === false,
    JSON.stringify(recovery));

  // --- 3. The content script on a page matching the manifest pattern -------
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route('https://www.amazon.co.uk/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture() }),
  );
  await page.goto('https://www.amazon.co.uk/gp/video/storefront');

  await page.waitForFunction(() => document.querySelectorAll('.pvg-tile').length >= 6, null, {
    timeout: 20000,
  }).catch(() => {});
  // The glow fades in over 220ms, so computed style has to be read after the
  // transition settles - sampling earlier returns an interpolated frame.
  await page
    .waitForFunction(
      () => {
        const tile = document.querySelector('.pvg-tile');
        if (!tile) return false;
        const parts = getComputedStyle(tile).boxShadow.match(/([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px/);
        return Boolean(parts) && Number(parts[3]) > 10;
      },
      null,
      { timeout: 5000 },
    )
    .catch(() => {});

  const painted = await page.evaluate(() =>
    [...document.querySelectorAll('.pvg-tile')].map((el) => ({
      rating: el.dataset.pvgRating,
      color: el.style.getPropertyValue('--pvg-color'),
      uncertain: el.classList.contains('pvg-uncertain'),
      title: el.querySelector('img')?.alt,
      shadow: getComputedStyle(el).boxShadow,
      width: Math.round(el.getBoundingClientRect().width),
      artWidth: Math.round((el.querySelector('img') || el).getBoundingClientRect().width),
    })),
  );

  console.log('\ncontent script');
  check('tiles are glowing', painted.length === 6, `${painted.length} painted`);
  check('no page errors', errors.length === 0, errors.join('; '));

  const byTitle = Object.fromEntries(painted.map((p) => [p.title, p]));
  check('Dune got its rating', byTitle.Dune?.rating === '8.0');
  check('The Godfather got its rating', byTitle['The Godfather']?.rating === '9.2');
  check(
    'the series tile resolved through a messy label',
    byTitle['Watch The Boys - Season 3 | Prime Video']?.rating === '8.7',
  );
  check(
    'the unrated tile was left alone',
    !painted.some((p) => p.title === 'Nothing Anyone Has Ever Rated'),
  );
  const blurPx = Number(
    (byTitle.Dune?.shadow || '').match(/[\d.]+px\s+[\d.]+px\s+([\d.]+)px/)?.[1] ?? 0,
  );
  check('a box-shadow actually landed', blurPx > 10, byTitle.Dune?.shadow);

  const godfather = byTitle['The Godfather']?.color || '';
  const thing = byTitle['The Thing']?.color || '';
  check('high and low ratings differ in hue', godfather !== thing, `${godfather} vs ${thing}`);
  check(
    'the year in the card disambiguated the remake',
    byTitle['The Thing']?.rating === '8.2',
    `got ${byTitle['The Thing']?.rating}`,
  );

  // Regression: the newer /detail/ links were invisible to tile discovery, and
  // a hero swallowed the glow into a bar across the page.
  const modernPainted = await page.evaluate(() => ({
    ariaLabelled: Boolean(document.querySelector('a[href*="B09OPPN001"]')?.closest('.pvg-tile')),
    hiddenTitle: Boolean(document.querySelector('a[href*="B09HIDE001"]')?.closest('.pvg-tile')),
    heroPainted: Boolean(document.querySelector('.hero.pvg-tile, .hero .pvg-tile')),
  }));
  check('a /detail/ link with an aria-label resolves', modernPainted.ariaLabelled);
  check('a title in visually hidden text resolves', modernPainted.hiddenTitle);
  check('the hero banner is left alone', modernPainted.heroPainted === false);
  check(
    'no glow is wider than its artwork',
    painted.every((p) => !p.artWidth || p.width <= p.artWidth * 1.6),
    JSON.stringify(painted.map((p) => [p.width, p.artWidth])),
  );

  // --- 4. Lazy-loaded tiles, the MutationObserver's whole job --------------
  await page.evaluate((art) => {
    const li = document.createElement('li');
    li.dataset.testid = 'card';
    li.innerHTML = `<a href="/gp/video/detail/B09LATE001/ref=x"><img alt="Dune" src="${art}"></a><div><span>2021</span></div>`;
    document.getElementById('late').appendChild(li);
  }, ART);

  const lateGlowed = await page
    .waitForFunction(
      () => {
        const late = document.querySelector('#late [data-testid="card"]');
        return Boolean(late && late.querySelector('.pvg-tile, [data-pvg-rating]')) ||
          Boolean(late?.classList.contains('pvg-tile'));
      },
      null,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);

  console.log('\nlazy loading');
  check('a tile added after load also glows', lateGlowed);

  // --- 5. Second visit should be served from cache ------------------------
  await page.goto('https://www.amazon.co.uk/gp/video/storefront?again=1');
  await page.waitForFunction(() => document.querySelectorAll('.pvg-tile').length >= 6, null, { timeout: 20000 }).catch(() => {});
  const cached = await page.evaluate(() =>
    [...document.querySelectorAll('.pvg-tile')].map((el) => el.title),
  );
  console.log('\ncaching');
  check('tiles resolve again on a fresh page', cached.length === 6, `${cached.length}`);
  check('at least one came from cache', cached.some((t) => /\[cache\]/.test(t)), cached.join(' | '));
} finally {
  await context.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
