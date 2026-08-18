import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureHome } from '../config.js';

/**
 * Vergil / Directory of Classes access.
 *
 * Why this is a browser and not a fetch(): every host under columbia.edu sits
 * behind a Cloudflare *managed challenge*. Probed 2026-08-17:
 *
 *   $ curl -sS -D- https://vergil.registrar.columbia.edu/
 *   HTTP/2 403
 *   cf-mitigated: challenge
 *   <title>Just a moment...</title>
 *
 * A browser UA does not help — the challenge requires JS execution. So the
 * only workable path is a real browser that Jeremy has signed into once. We
 * keep a persistent Chromium profile on disk; the CAS/Duo session and the
 * Cloudflare clearance cookie both live there and survive restarts.
 *
 * Headed by default. Headless Chromium fails managed challenges far more
 * often, and Duo push approval wants a visible window anyway.
 */

const PROFILE = PATHS.browserProfile;

let contextPromise = null;

async function getContext() {
  if (contextPromise) return contextPromise;
  contextPromise = (async () => {
    ensureHome();
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new Error(
        'playwright is not installed. Run `npm install` then '
        + '`npx playwright install chromium` in the columbia-mcp directory.'
      );
    }
    return chromium.launchPersistentContext(PROFILE, {
      headless: process.env.VERGIL_HEADLESS === '1',
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  })();
  return contextPromise;
}

export async function closeContext() {
  if (!contextPromise) return;
  const ctx = await contextPromise.catch(() => null);
  contextPromise = null;
  if (ctx) await ctx.close().catch(() => {});
}

/** True once the persistent profile exists — i.e. login has been done once. */
export function profileExists() {
  return fs.existsSync(path.join(PROFILE, 'Default'));
}

/**
 * Navigate and return the page as readable text plus its links.
 *
 * This is deliberately generic rather than a per-page scraper. Vergil is a
 * client-rendered app whose DOM I have not been able to inspect from here
 * (the challenge blocks it), so hard-coded selectors would be fiction. Text
 * extraction degrades gracefully when the markup changes; selectors don't.
 */
export async function browse(url, { waitFor = null, timeoutMs = 45000 } = {}) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Give a managed challenge time to resolve itself before we read the DOM.
    await settleChallenge(page, timeoutMs);

    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: timeoutMs }).catch(() => {});
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const data = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map((a) => ({ text: a.innerText.trim(), href: a.href }))
        .filter((l) => l.text)
        .slice(0, 300);
      return { title: document.title, text, links };
    });

    return {
      url: page.url(),
      title: data.title,
      text: data.text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000),
      links: data.links,
      needsLogin: /log ?in|uni|duo|authenticate/i.test(data.title),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Wait out "Just a moment..." rather than scraping the interstitial. */
async function settleChallenge(page, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 30000);
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    if (!/just a moment|checking your browser|attention required/i.test(title)) return;
    await page.waitForTimeout(1000);
  }
}

/**
 * Open a login window and block until Jeremy has authenticated by hand.
 *
 * Run this once per profile (and again whenever CAS expires). Duo cannot and
 * should not be automated — the whole point of the second factor is that a
 * human approves it.
 */
export async function login({ startUrl = 'https://vergil.registrar.columbia.edu/', timeoutMs = 300000 } = {}) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const done = !/cas\.columbia\.edu|duosecurity|just a moment/i.test(`${url} ${title}`);
    if (done) {
      await page.waitForTimeout(2000);
      return { ok: true, url: page.url(), title: await page.title() };
    }
    await page.waitForTimeout(2000);
  }
  return { ok: false, error: 'timed out waiting for manual login' };
}

/**
 * Course search.
 *
 * NOTE: the URL template is configurable because I could not confirm Vergil's
 * live query-string scheme from behind the challenge. Verify it once on the
 * Mini and, if it differs, set VERGIL_SEARCH_URL in .env — no code change.
 */
export async function searchCourses({ query, term = '' }) {
  const template = process.env.VERGIL_SEARCH_URL
    || 'https://vergil.registrar.columbia.edu/#/search?q={query}&term={term}';
  const url = template
    .replace('{query}', encodeURIComponent(query))
    .replace('{term}', encodeURIComponent(term));
  const page = await browse(url, { waitFor: 'main, [class*=result], [class*=course]' });
  return { query, term, ...page };
}
