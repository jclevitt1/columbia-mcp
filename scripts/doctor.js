#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG, PATHS, loadEnv } from '../src/config.js';
import * as vergil from '../src/tools/vergil.js';

const exec = promisify(execFile);
loadEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

/** Checks every prerequisite and says exactly what to do about each failure. */

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

// 1. Claude Code CLI, using the existing login rather than an API key.
try {
  const { stdout } = await exec(CONFIG.claudeBin, ['--version']);
  add('claude CLI', true, stdout.trim());
} catch {
  add('claude CLI', false, `'${CONFIG.claudeBin}' not runnable — set CLAUDE_BIN in .env`);
}

// 2. Canvas token.
if (!CONFIG.canvasToken) {
  add('Canvas token', false, `unset — mint one at ${CONFIG.canvasBase}/profile/settings`);
} else {
  try {
    const res = await fetch(`${CONFIG.canvasBase}/api/v1/users/self/profile`, {
      headers: { Authorization: `Bearer ${CONFIG.canvasToken}` },
    });
    const body = await res.json().catch(() => ({}));
    add('Canvas token', res.ok, res.ok ? `authenticated as ${body.name ?? body.id}` : `HTTP ${res.status}`);
  } catch (e) {
    add('Canvas token', false, String(e.message));
  }
}

// 3. Mail backend.
add('Mail backend', CONFIG.gmailBackend !== 'none',
  CONFIG.gmailBackend === 'none'
    ? 'unset — see SETUP.md step 3 (apple_mail needs no admin approval)'
    : CONFIG.gmailBackend);

// 4. Telegram.
if (!CONFIG.telegramToken) {
  add('Telegram bot', false, 'TELEGRAM_BOT_TOKEN unset — talk to @BotFather');
} else {
  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.telegramToken}/getMe`);
    const body = await res.json();
    add('Telegram bot', body.ok, body.ok ? `@${body.result.username}` : body.description);
  } catch (e) {
    add('Telegram bot', false, String(e.message));
  }
}
add('Telegram owner lock', Boolean(CONFIG.telegramOwnerId),
  CONFIG.telegramOwnerId || 'TELEGRAM_OWNER_CHAT_ID unset — bridge refuses to start');

// 5. Browser profile for the Cloudflare-challenged columbia.edu hosts.
add('Vergil browser profile', vergil.profileExists(),
  vergil.profileExists() ? PATHS.browserProfile : 'missing — run `npm run vergil-login` at the Mini');

const pad = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) {
  console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(pad)}  ${c.detail}`);
}
process.exit(checks.every((c) => c.ok) ? 0 : 1);
