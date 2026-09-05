#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/config.js';
import * as auth from '../src/authcheck.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(ROOT);

/**
 * Sweep every credential the bridge depends on and shout only when something
 * needs a human.
 *
 * Alerts go out over a SEPARATE bot on purpose. The main bot is one of the
 * things being watched, and a monitor that dies with the thing it monitors is
 * not a monitor. A distinct token also means an auth alert still lands if the
 * main bot's token is revoked.
 *
 * Usage:
 *   npm run auth-sweep                 report, alert only on problems
 *   npm run auth-sweep -- --always     alert even when everything is healthy
 *   npm run auth-sweep -- --json       machine-readable, no alert
 *   npm run auth-sweep -- --probe-vergil   also drive a headed browser at
 *                                          Vergil/SSOL for a real verdict
 */

const args = new Set(process.argv.slice(2));
const ALWAYS = args.has('--always');
const JSON_OUT = args.has('--json');
const PROBE = args.has('--probe-vergil');
const QUIET = args.has('--quiet');

async function sendAlert(text) {
  const token = process.env.ALERT_BOT_TOKEN;
  const chat = process.env.ALERT_CHAT_ID;
  if (!token || !chat) {
    return { sent: false, reason: 'ALERT_BOT_TOKEN / ALERT_CHAT_ID not set — printing only.' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json();
    return body.ok ? { sent: true } : { sent: false, reason: body.description ?? 'unknown Telegram error' };
  } catch (err) {
    return { sent: false, reason: String(err.message).slice(0, 160) };
  }
}

/**
 * The only honest Vergil check, and the reason it is opt-in: it needs a headed
 * browser. Headless Chromium does not clear Columbia's Cloudflare managed
 * challenge — probed 2026-09-04, both hosts sat on "Just a moment..." until
 * timeout while needsLogin still read false. A scheduled sweep running this
 * would pop a window on the Mini twice a day and fight the bridge for the
 * profile lock, so it stays behind a flag.
 */
async function probeVergil() {
  const vergil = await import('../src/tools/vergil.js');
  const out = [];
  try {
    for (const [label, url] of [
      ['Vergil', 'https://vergil.registrar.columbia.edu/'],
      ['SSOL', 'https://ssol.columbia.edu/'],
    ]) {
      try {
        const r = await vergil.browse(url, { timeoutMs: 45_000 });
        const challenged = /just a moment|checking your browser|attention required/i.test(r.title || '');
        if (challenged) {
          out.push({ name: `${label} (probe)`, status: 'fail', detail: 'Stuck on the Cloudflare challenge — the clearance cookie is not working.' });
        } else if (r.needsLogin) {
          out.push({ name: `${label} (probe)`, status: 'fail', detail: 'Redirected to CAS — the session has expired. Run `npm run vergil-login`.' });
        } else {
          out.push({ name: `${label} (probe)`, status: 'ok', detail: `Reachable and authenticated ("${String(r.title).slice(0, 50)}").` });
        }
      } catch (err) {
        out.push({ name: `${label} (probe)`, status: 'unknown', detail: `Probe failed: ${String(err.message).slice(0, 120)}` });
      }
    }
  } finally {
    await vergil.closeContext().catch(() => {});
  }
  return out;
}

const now = Date.now();
const state = auth.loadState();

const checks = [];
checks.push(await auth.checkGoogle(state, now));
checks.push(await auth.checkCanvas(state, now));
checks.push(await auth.checkTelegram('Telegram bridge bot', process.env.TELEGRAM_BOT_TOKEN));
checks.push(await auth.checkTelegram('Telegram alert bot', process.env.ALERT_BOT_TOKEN));

const cookies = await auth.readCookies();
checks.push(auth.classifyClearance(cookies, now));
checks.push(auth.classifyCasSession(cookies, now));

if (PROBE) checks.push(...(await probeVergil()));

state.lastRunAt = now;
auth.saveState(state);

const overall = auth.worst(checks);
const bad = auth.problems(checks);

if (JSON_OUT) {
  console.log(JSON.stringify({ at: new Date(now).toISOString(), overall, mute: auth.alertsMuted(now), checks }, null, 2));
  process.exit(overall === 'fail' ? 2 : overall === 'warn' ? 1 : 0);
}

const report = auth.formatReport(checks);
if (!QUIET) {
  console.log(`Columbia auth sweep — ${new Date(now).toLocaleString()}`);
  console.log(`${auth.describeMute(auth.alertsMuted(now), now)}\n`);
  console.log(report);
}

const mute = auth.alertsMuted(now);

// A mute silences sending, never checking: the sweep still runs, still logs,
// and still exits non-zero, so a muted problem is visible the moment he asks.
if ((bad.length || ALWAYS) && mute.muted && !ALWAYS) {
  if (!QUIET) console.log(`\n${auth.describeMute(mute, now)} ${bad.length} problem(s) NOT sent.`);
} else if (bad.length || ALWAYS) {
  const header = bad.length
    ? `Columbia auth: ${bad.length} item(s) need attention`
    : 'Columbia auth: all credentials healthy';
  const body = (bad.length ? bad : checks)
    .map((c) => `${c.status === 'fail' ? '❌' : c.status === 'warn' ? '⚠️' : '✅'} ${c.name}\n${c.detail}`)
    .join('\n\n');
  const { sent, reason } = await sendAlert(`${header}\n\n${body}`);
  if (!QUIET) console.log(`\n${sent ? 'Alert sent to the alert bot.' : `Alert NOT sent — ${reason}`}`);
} else if (!QUIET) {
  console.log('\nNothing to report; no alert sent.');
}

process.exit(overall === 'fail' ? 2 : overall === 'warn' ? 1 : 0);
