import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PATHS, readJson, writeJson, ensureHome } from './config.js';

const exec = promisify(execFile);

/**
 * Credential sweep for the Columbia bridge.
 *
 * The honest framing matters here, so it is worth stating up front: most of
 * these credentials do not publish an expiry, and this module refuses to
 * invent one. Probed 2026-09-04:
 *
 *   cf_clearance      real expires_utc in the cookie DB      -> true countdown
 *   CAS / SSOL        session cookies, no expiry at all      -> liveness only
 *   Google refresh    no expiry field; lifetime depends on
 *                     OAuth publishing status                -> learned (below)
 *   Canvas token      /users/self returns 200 and no expiry
 *                     metadata in body or headers            -> liveness only
 *   Telegram token    does not expire                        -> liveness only
 *
 * So a check reports one of ok / warn / fail / unknown, and `unknown` is a
 * first-class result rather than something rounded down to "fine". A sweeper
 * that says "4 days left" when the server never told it that is worse than
 * one that admits it cannot know.
 */

export const STATE_FILE = path.join(PATHS.home, 'auth-sweep.json');

/* ---------------- time helpers ---------------- */

/** Chromium stores microseconds since 1601-01-01. */
export const CHROME_EPOCH_OFFSET_SEC = 11644473600;

export function chromeTimeToMs(microseconds) {
  if (!microseconds || microseconds <= 0) return null;
  return (microseconds / 1000 - CHROME_EPOCH_OFFSET_SEC * 1000);
}

export function daysBetween(fromMs, toMs) {
  return (toMs - fromMs) / 86_400_000;
}

/** "3.2 days" / "5.1 hours" / "12 minutes" — whichever reads best. */
export function humanDuration(ms) {
  const abs = Math.abs(ms);
  if (abs >= 86_400_000) return `${(ms / 86_400_000).toFixed(1)} days`;
  if (abs >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} hours`;
  return `${Math.round(ms / 60_000)} minutes`;
}

/* ---------------- state ---------------- */

export function loadState() {
  return readJson(STATE_FILE, { google: {}, canvas: {}, vergil: {}, telegram: {} });
}

export function saveState(state) {
  ensureHome();
  writeJson(STATE_FILE, state);
}

/** Identify a token without ever storing it. */
export function fingerprint(secret) {
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/* ---------------- Google ---------------- */

/**
 * Learn the refresh token's real lifetime instead of assuming one.
 *
 * A Google OAuth app in "Testing" hands out refresh tokens that die after 7
 * days; a published one issues tokens that last until revoked. Nothing in the
 * token or the API says which you have, and the publishing status is not
 * readable with the scopes we hold. But the distinction is observable:
 *
 *   - a token still working on day 8 cannot be a Testing token
 *   - a token that dies with invalid_grant tells us the lifetime it reached
 *
 * So we record first-success time per token fingerprint and let the answer
 * emerge. Until it does, the mode stays "unknown" and we warn on approach to
 * day 7 — the cautious reading — rather than pretending to know.
 */
export const TESTING_LIFETIME_DAYS = 7;

export function classifyGoogle(entry, { ok, invalidGrant }, now = Date.now()) {
  const ageDays = entry.firstOkAt ? daysBetween(entry.firstOkAt, now) : 0;

  if (!ok && invalidGrant) {
    return {
      status: 'fail',
      mode: entry.publishingMode ?? 'unknown',
      ageDays,
      detail: `Refresh token rejected (invalid_grant) after ${ageDays.toFixed(1)} days. `
        + 'Re-run `npm run gmail-auth` at the Mini.',
    };
  }
  if (!ok) {
    return { status: 'unknown', mode: entry.publishingMode ?? 'unknown', ageDays,
      detail: 'Could not reach Google to check the token (network or API error).' };
  }

  // Surviving past the Testing cliff is proof of a published app.
  if (ageDays > TESTING_LIFETIME_DAYS + 1) {
    return { status: 'ok', mode: 'production', ageDays,
      detail: `Working, ${ageDays.toFixed(1)} days old — past the 7-day Testing cliff, so this project is published.` };
  }
  if (entry.publishingMode === 'production') {
    return { status: 'ok', mode: 'production', ageDays,
      detail: `Working, ${ageDays.toFixed(1)} days old. Project is published; token lasts until revoked.` };
  }
  if (ageDays >= TESTING_LIFETIME_DAYS - 2) {
    return { status: 'warn', mode: 'unknown', ageDays,
      detail: `Working but ${ageDays.toFixed(1)} days old. If this project is still in Testing it expires at day `
        + `${TESTING_LIFETIME_DAYS}. Survive past day ${TESTING_LIFETIME_DAYS + 1} and we will know it is published.` };
  }
  return { status: 'ok', mode: entry.publishingMode ?? 'unknown', ageDays,
    detail: `Working, ${ageDays.toFixed(1)} days old. Lifetime not yet observed.` };
}

export async function checkGoogle(state, now = Date.now()) {
  const token = process.env.GMAIL_REFRESH_TOKEN;
  if (!token) {
    return { name: 'Google OAuth', status: 'unknown', detail: 'GMAIL_REFRESH_TOKEN is not set.' };
  }

  const fp = fingerprint(token);
  const entry = state.google ?? {};
  // A changed fingerprint means a fresh consent; the age clock restarts and
  // anything we learned about the previous token no longer applies.
  if (entry.fingerprint !== fp) {
    state.google = { fingerprint: fp, firstOkAt: now, lastOkAt: null, publishingMode: undefined };
  }

  let ok = false;
  let invalidGrant = false;
  let scopesMissing = [];
  try {
    const ga = await import('./tools/google-auth.js');
    scopesMissing = await ga.missingScopes();
    ok = true;
  } catch (err) {
    const msg = String(err?.message || err);
    invalidGrant = /invalid_grant|Token has been expired or revoked/i.test(msg);
  }

  const cur = state.google;
  if (ok) {
    cur.lastOkAt = now;
    if (!cur.firstOkAt) cur.firstOkAt = now;
  }
  const verdict = classifyGoogle(cur, { ok, invalidGrant }, now);
  if (verdict.mode === 'production') cur.publishingMode = 'production';
  if (verdict.status === 'fail') cur.observedLifetimeDays = verdict.ageDays;

  let detail = verdict.detail;
  let status = verdict.status;
  if (ok && scopesMissing.length) {
    status = 'warn';
    detail += ` Missing scopes: ${scopesMissing.map((s) => s.split('/').pop()).join(', ')} — re-run \`npm run gmail-auth\`.`;
  }
  return { name: 'Google OAuth', status, detail };
}

/* ---------------- Canvas ---------------- */

export async function checkCanvas(state, now = Date.now()) {
  const base = process.env.CANVAS_BASE_URL;
  const token = process.env.CANVAS_ACCESS_TOKEN;
  if (!base || !token) {
    return { name: 'Canvas token', status: 'unknown', detail: 'CANVAS_BASE_URL or CANVAS_ACCESS_TOKEN is not set.' };
  }
  try {
    const res = await fetch(`${base}/api/v1/users/self`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { name: 'Canvas token', status: 'fail',
        detail: `Rejected with HTTP ${res.status}. Mint a new token in Canvas > Account > Settings and update CANVAS_ACCESS_TOKEN.` };
    }
    if (!res.ok) {
      return { name: 'Canvas token', status: 'unknown', detail: `Unexpected HTTP ${res.status}; token state unclear.` };
    }
    const who = await res.json();
    state.canvas = { ...(state.canvas ?? {}), lastOkAt: now };
    // Canvas exposes no expiry for access tokens, so this is liveness only.
    return { name: 'Canvas token', status: 'ok',
      detail: `Valid — authenticated as ${who.name}. Canvas publishes no expiry, so this is a liveness check.` };
  } catch (err) {
    return { name: 'Canvas token', status: 'unknown', detail: `Could not reach Canvas: ${String(err.message).slice(0, 120)}` };
  }
}

/* ---------------- Telegram ---------------- */

export async function checkTelegram(label, token) {
  if (!token) return { name: label, status: 'unknown', detail: 'Token not set.' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(20_000) });
    const body = await res.json();
    if (!body.ok) {
      return { name: label, status: 'fail', detail: `Rejected: ${body.description ?? 'unknown error'}` };
    }
    return { name: label, status: 'ok', detail: `Live as @${body.result.username}. Bot tokens do not expire.` };
  } catch (err) {
    return { name: label, status: 'unknown', detail: `Could not reach Telegram: ${String(err.message).slice(0, 120)}` };
  }
}

/* ---------------- Vergil / SSOL cookies ---------------- */

/**
 * CAS issues a ticket-granting cookie on cas.columbia.edu when single sign-on
 * succeeds. It is the SSO credential itself, and it is the only cookie here
 * whose presence tracked reality in both states we have observed:
 *
 *   2026-09-05 21:27  logged out   TGC absent, PF + JSESSIONID still present
 *   2026-09-05 21:31  logged in    TGC present
 *
 * The downstream cookies are the trap. PF (PingFederate) and JSESSIONID
 * (Shibboleth) are written by services CAS redirected through, and nothing
 * cleans them up when the session dies — a stale pair sat in the profile for
 * 26 hours after the login they belonged to had expired. Watching those is
 * what made the sweep report "session cookies present" while Vergil was
 * refusing every request.
 */
const CAS_TICKET_COOKIE = 'TGC';
const CAS_DOWNSTREAM_COOKIES = ['PF', '__Host-JSESSIONID', 'JSESSIONID'];

/**
 * How long a ticket is assumed good. A heuristic, not a published figure:
 * Columbia does not document the CAS session lifetime and it cannot be read
 * from the cookie, which carries no expiry. One measured data point says a
 * session established 18:59 was dead within 26 hours. Twelve hours keeps a
 * normal day's work inside `ok` while still flagging a ticket that has almost
 * certainly lapsed overnight.
 */
export const CAS_STALE_HOURS = 12;

/**
 * Read cookie metadata without launching a browser.
 *
 * The DB is copied first: Chromium holds a lock while the bridge has a
 * context open, and a scheduled sweep must never contend with it. Only
 * timestamps are read — the values stay encrypted and are never touched.
 */
export async function readCookies(profile = PATHS.browserProfile) {
  const db = path.join(profile, 'Default', 'Cookies');
  if (!fs.existsSync(db)) return null;
  const tmp = path.join(os.tmpdir(), `colauth-${process.pid}-${Date.now()}.db`);
  try {
    fs.copyFileSync(db, tmp);
    const { stdout } = await exec('sqlite3', [
      tmp,
      '-json',
      "SELECT host_key, name, has_expires, expires_utc, creation_utc FROM cookies "
      + "WHERE host_key LIKE '%columbia.edu%' OR name = 'cf_clearance';",
    ], { timeout: 20_000 });
    return stdout.trim() ? JSON.parse(stdout) : [];
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

export const CF_WARN_DAYS = 14;

/** cf_clearance is the one credential here with a real, readable expiry. */
export function classifyClearance(rows, now = Date.now()) {
  if (rows === null) return { name: 'Cloudflare clearance', status: 'unknown', detail: 'Could not read the cookie database.' };
  const cf = rows.find((r) => r.name === 'cf_clearance');
  if (!cf) {
    return { name: 'Cloudflare clearance', status: 'fail',
      detail: 'No cf_clearance cookie. Every columbia.edu host sits behind a managed challenge, so browsing will fail until you re-run `npm run vergil-login`.' };
  }
  const expMs = chromeTimeToMs(cf.expires_utc);
  if (!expMs) return { name: 'Cloudflare clearance', status: 'unknown', detail: 'Cookie present but carries no expiry.' };
  const days = daysBetween(now, expMs);
  if (days <= 0) return { name: 'Cloudflare clearance', status: 'fail', detail: `Expired ${humanDuration(now - expMs)} ago. Re-run \`npm run vergil-login\`.` };
  if (days <= CF_WARN_DAYS) return { name: 'Cloudflare clearance', status: 'warn', detail: `Expires in ${days.toFixed(1)} days (${new Date(expMs).toISOString().slice(0, 10)}).` };
  return { name: 'Cloudflare clearance', status: 'ok', detail: `Valid for ${days.toFixed(0)} more days (${new Date(expMs).toISOString().slice(0, 10)}).` };
}

/**
 * The CAS session itself. Deliberately never returns "ok": these are session
 * cookies with no expiry, and the only way to know the session still works is
 * to drive a headed browser at it, which a scheduled sweep must not do. We
 * report what is knowable — that a session was established, and when — and
 * label the rest unverified.
 */
export function classifyCasSession(rows, now = Date.now()) {
  if (rows === null) {
    return { name: 'CAS / SSOL session', status: 'unknown', detail: 'Could not read the cookie database.' };
  }

  const ticket = rows.find((r) => r.name === CAS_TICKET_COOKIE);
  const downstream = rows.filter((r) => CAS_DOWNSTREAM_COOKIES.includes(r.name));

  if (!ticket) {
    // Definitive. Say so even when the downstream cookies are still sitting
    // there, because that combination is exactly the expired-session case.
    const misleading = downstream.length
      ? ` (${downstream.map((d) => d.name).join(', ')} are still in the profile, but they outlive the session and mean nothing on their own.)`
      : '';
    return {
      name: 'CAS / SSOL session', status: 'fail',
      detail: `No CAS ticket-granting cookie — signed out.${misleading} Run \`npm run vergil-login\`.`,
    };
  }

  const ageMs = now - (chromeTimeToMs(ticket.creation_utc) ?? now);
  const ageHours = ageMs / 3_600_000;
  const age = humanDuration(ageMs);

  if (ageHours >= CAS_STALE_HOURS) {
    return {
      name: 'CAS / SSOL session', status: 'warn',
      detail: `CAS ticket is ${age} old, past the ${CAS_STALE_HOURS}h mark where it has usually lapsed. `
        + 'Expect a re-login. `npm run auth-sweep -- --probe-vergil` confirms it for real (opens a browser).',
    };
  }

  return {
    name: 'CAS / SSOL session', status: 'ok',
    detail: `CAS ticket present, issued ${age} ago. Inferred from the ticket, not verified against the server — `
      + 'only `--probe-vergil` does that.',
  };
}

/* ---------------- rollup ---------------- */

export const RANK = { fail: 3, warn: 2, unknown: 1, ok: 0 };

export function worst(checks) {
  return checks.reduce((acc, c) => (RANK[c.status] > RANK[acc] ? c.status : acc), 'ok');
}

/** Problems are what we alert on: failures and warnings, never `unknown`. */
export function problems(checks) {
  return checks.filter((c) => c.status === 'fail' || c.status === 'warn');
}

export function formatReport(checks, { color = false } = {}) {
  const mark = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL', unknown: '??  ' };
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${mark[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`).join('\n');
}
