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
 * Term code used by the Directory of Classes: year + season digit,
 * where 1=Spring, 2=Summer, 3=Fall. "Fall 2026" -> 20263.
 * Confirmed against the live <select name="semes"> options.
 */
export function termCode(term) {
  if (!term) return '';
  if (/^\d{5}$/.test(term.trim())) return term.trim();
  const m = term.trim().match(/(spring|summer|fall|autumn)\s+(\d{4})/i);
  if (!m) return '';
  const season = { spring: '1', summer: '2', fall: '3', autumn: '3' }[m[1].toLowerCase()];
  return `${m[2]}${season}`;
}

/**
 * Search the Directory of Classes.
 *
 * Verified live 2026-08-17: doc.sis.columbia.edu's keyword form GETs
 * https://doc.search.columbia.edu/search?q=...&semes=<code>, and each hit
 * renders as a div.col-md-11 holding a title link of the form
 * #subj/STAT/GR5204-20263-001/, a description, and a section table.
 *
 * Public — no CAS login needed. Only Cloudflare stands in the way, which is
 * why this still goes through the browser. Note the DOC itself warns that
 * meeting days/times now live only in Vergil, so use vergil_browse (logged
 * in) when the question is about scheduling rather than catalog content.
 */
export async function searchCourses({ query, term = '', limit = 25 }) {
  const url = new URL('https://doc.search.columbia.edu/search');
  url.searchParams.set('q', query);
  const code = termCode(term);
  if (code) url.searchParams.set('semes', code);

  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settleChallenge(page, 45000);
    await page.waitForSelector('div.col-md-11 table', { timeout: 20000 }).catch(() => {});

    const results = await page.evaluate((max) => {
      const out = [];
      for (const box of document.querySelectorAll('div.col-md-11')) {
        const table = box.querySelector('table');
        const link = box.querySelector('a[href*="#subj/"]');
        if (!table || !link) continue;

        // href looks like .../#subj/STAT/GR5204-20263-001/
        const m = link.getAttribute('href').match(/#subj\/([A-Z]+)\/([A-Z]{0,3}\d+[A-Z]?)-(\d{5})-(\d+)/i);
        const rows = Array.from(table.querySelectorAll('tr'));
        const cells = rows.length > 1
          ? Array.from(rows[1].querySelectorAll('td')).map((td) => td.innerText.trim())
          : [];

        const lines = box.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
        const description = lines.find((l) => l.length > 120) || '';

        out.push({
          title: link.innerText.trim(),
          subject: m ? m[1] : null,
          number: m ? m[2] : null,
          section: m ? m[4] : (cells[0] || null),
          callNumber: cells[1] || null,
          semester: cells[2] || null,
          instructor: cells[3] || null,
          department: cells[4] || null,
          methodOfInstruction: cells[5] || null,
          description: description.slice(0, 1200),
          url: link.href,
        });
        if (out.length >= max) break;
      }
      return out;
    }, limit);

    const countText = await page.evaluate(() => {
      const m = document.body.innerText.match(/Showing (\d+) results/i);
      return m ? Number(m[1]) : null;
    });

    return { query, term: term || 'all', termCode: code || null, totalResults: countText, returned: results.length, results };
  } finally {
    await page.close().catch(() => {});
  }
}
