#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG, ensureHome, loadEnv } from '../config.js';
import * as approvals from '../approvals.js';
import * as sessions from '../sessions.js';
import * as updater from '../updater.js';
import { registerAll as registerExecutors } from '../executors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv(ROOT);
ensureHome();

/**
 * Telegram <-> Claude Code bridge.
 *
 * Long-polls Telegram and pipes each message into a headless `claude -p`
 * session on this machine, with columbia-mcp attached over stdio.
 *
 * Two properties worth stating explicitly, because they are the reason this
 * shape was chosen over exposing an MCP server to the Claude app:
 *
 *  1. No inbound network exposure. getUpdates is an *outbound* HTTPS poll, so
 *     nothing listens on a port and there is no tunnel to secure.
 *  2. No API key. `claude -p` uses the Claude Code login already on this box,
 *     so this rides the existing subscription.
 */

const API = `https://api.telegram.org/bot${CONFIG.telegramToken}`;
const CONFIRM_WORDS = ['yes', 'y', 'ok', 'approve', 'send it', 'do it'];
const DENY_WORDS = ['no', 'n', 'cancel', 'reject', 'stop'];
const TELEGRAM_LIMIT = 4000; // real cap is 4096; leave room for our framing
const RUN_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 15 * 60 * 1000);

/* The bridge is the only process allowed to approve, so it needs every executor. */
registerExecutors();

/* ---------------- Telegram plumbing ---------------- */

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
  return data.result;
}

async function send(chatId, text) {
  for (const chunk of chunkText(String(text ?? '').trim() || '(empty response)')) {
    await tg('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true });
  }
}

/** Split on paragraph, then line, then hard — never mid-message-drop. */
function chunkText(text) {
  if (text.length <= TELEGRAM_LIMIT) return [text];
  const chunks = [];
  let cur = '';
  for (const para of text.split('\n')) {
    if (cur.length + para.length + 1 > TELEGRAM_LIMIT) {
      if (cur) chunks.push(cur);
      cur = '';
      while (para.length > TELEGRAM_LIMIT) {
        chunks.push(para.slice(0, TELEGRAM_LIMIT));
        cur = para.slice(TELEGRAM_LIMIT);
      }
      if (!cur) cur = para;
    } else {
      cur = cur ? `${cur}\n${para}` : para;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const typing = (chatId) => tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

/* ---------------- Claude Code invocation ---------------- */

const SYSTEM_APPEND = `
You are Jeremy's Columbia assistant, reached over Telegram from his phone.
Keep replies short and plain-text — no markdown tables, no code fences unless
asked. He is reading this on a phone.

Tools: canvas_* for CourseWorks, vergil_* for the course catalog and any
columbia.edu page, mail_* for Columbia mail, calendar_* for his Google
Calendar, drive_*/docs_*/sheets_* for his Drive.

You may read freely. You may NOT send, create or delete anything on his
behalf: every *_request_* tool only queues the action for his approval. Call
it, then tell him it is waiting. He approves from Telegram; you cannot approve
for him.

If a tool reports it is unconfigured, say so plainly and name the setup step.
Do not guess at data you could not fetch.
`.trim();

/**
 * Built-in tools the session gets on top of whatever columbia-mcp exposes.
 *
 * Read/Glob/Grep/Write/Edit, and deliberately not Bash. This agent routinely
 * ingests text written by other people — mail_read, vergil_browse and
 * canvas_announcements all return attacker-controllable content into the same
 * context that holds a live Gmail token. File tools confine the blast radius
 * of a prompt injection to files; Bash does not confine it to anything.
 *
 * Widen with BRIDGE_EXTRA_TOOLS=Bash if you decide you want that, rather than
 * reaching for --dangerously-skip-permissions, which drops the sandbox for
 * every tool at once instead of the one you actually wanted.
 */
const BUILTIN_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit'];

const EXTRA_TOOLS = (process.env.BRIDGE_EXTRA_TOOLS || '')
  .split(',').map((t) => t.trim()).filter(Boolean);

/**
 * Ask the MCP server what it actually exposes, rather than keeping a hand
 * written list in sync with it.
 *
 * This exists because the hand-written version silently rotted: three Canvas
 * tools were added to the server and the bridge kept denying them, which
 * surfaced to Jeremy as "permission denied" rather than "tool missing" — a
 * confusing failure a long way from its cause. Discovery makes that class of
 * bug impossible.
 */
let allowedToolsCache = null;

async function discoverTools() {
  if (allowedToolsCache) return allowedToolsCache;

  const names = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp', 'server.js')], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: process.env,
    });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); resolve([]); }, 15000);

    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve((msg.result?.tools ?? []).map((t) => t.name));
        }
      }
    });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bridge', version: '1' } },
    })}\n`);
  });

  if (!names.length) {
    console.error('tool discovery failed; falling back to built-ins only');
    allowedToolsCache = [...BUILTIN_TOOLS, ...EXTRA_TOOLS];
  } else {
    allowedToolsCache = [...names.map((n) => `mcp__columbia__${n}`), ...BUILTIN_TOOLS, ...EXTRA_TOOLS];
  }
  return allowedToolsCache;
}

function mcpConfig() {
  return JSON.stringify({
    mcpServers: {
      columbia: {
        command: process.execPath,
        args: [path.join(ROOT, 'src', 'mcp', 'server.js')],
        env: { COLUMBIA_MCP_HOME: process.env.COLUMBIA_MCP_HOME || '' },
      },
    },
  });
}

/**
 * Run one turn. Resumes the chat's session when we have one so context
 * carries across texts; otherwise starts fresh and records the new id.
 */
async function runClaude(chatId, prompt) {
  const prior = sessions.getSession(chatId);
  const allowed = await discoverTools();
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--mcp-config', mcpConfig(),
    '--strict-mcp-config',
    '--append-system-prompt', SYSTEM_APPEND,
    '--allowedTools', ...allowed,
    '--permission-mode', process.env.CLAUDE_PERMISSION_MODE || 'dontAsk',
  ];
  if (prior?.sessionId) args.push('--resume', prior.sessionId);

  return new Promise((resolve) => {
    const child = spawn(CONFIG.claudeBin, args, {
      cwd: CONFIG.workdir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, text: `Timed out after ${Math.round(RUN_TIMEOUT_MS / 60000)} min.` });
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `Could not start claude: ${e.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        if (parsed.session_id) sessions.setSession(chatId, parsed.session_id);
        const text = parsed.result ?? parsed.error ?? '(no result)';
        resolve({ ok: !parsed.is_error, text });
      } catch {
        resolve({
          ok: false,
          text: code === 0
            ? `Could not parse claude output: ${out.slice(0, 500)}`
            : `claude exited ${code}: ${(err || out).slice(0, 800)}`,
        });
      }
    });
  });
}

/* ---------------- commands ---------------- */

const HELP = `Columbia bot — commands

\\clear     forget this conversation, start fresh next message
\\status    session info + config health + running version
\\pending   list actions waiting on you
\\update    pull the latest from GitHub and restart the bridge
\\help      this

Approving: reply  yes <id>  or  no <id>
(just "yes" works when only one is pending)

Anything else is sent to Claude with your Columbia tools attached.`;

async function handleCommand(chatId, text) {
  const cmd = text.trim().toLowerCase().replace(/^\//, '\\');

  if (cmd === '\\help') { await send(chatId, HELP); return true; }

  if (cmd === '\\clear' || cmd === '\\new') {
    const had = sessions.clearSession(chatId);
    await send(chatId, had ? 'Context cleared. Next message starts fresh.' : 'No active context.');
    return true;
  }

  if (cmd === '\\status') {
    const s = sessions.getSession(chatId);
    const pending = approvals.list('pending');
    const head = await updater.describeHead(ROOT);
    await send(chatId, [
      s ? `Session: ${s.sessionId.slice(0, 8)}… (${s.turns} turns)` : 'Session: none — next message starts fresh',
      `Mail backend: ${CONFIG.gmailBackend}`,
      `Canvas token: ${CONFIG.canvasToken ? 'set' : 'MISSING'}`,
      `Pending approvals: ${pending.length}`,
      head ? `Version: ${head.branch} @ ${head.sha} — ${head.subject}` : 'Version: not a git checkout',
      `Supervisor: ${process.env.BRIDGE_SUPERVISOR || 'none (manual run)'}`,
    ].join('\n'));
    return true;
  }

  if (cmd === '\\update') {
    await handleUpdate(chatId);
    return true;
  }

  if (cmd === '\\pending') {
    const pending = approvals.list('pending');
    await send(chatId, pending.length
      ? pending.map((a) => `${a.id}  ${a.summary}`).join('\n')
      : 'Nothing pending.');
    return true;
  }

  return false;
}

/**
 * `\update`: fetch, fast-forward, reinstall deps if needed, restart.
 *
 * Safe to run at any time because the poll loop awaits each message in turn,
 * so this can never interrupt a Claude session in flight. The last thing it
 * does before exiting is confirm the current Telegram offset, so the restarted
 * bridge does not receive `\update` a second time.
 */
async function handleUpdate(chatId) {
  await typing(chatId);
  let check;
  try {
    check = await updater.checkForUpdate(ROOT);
  } catch (err) {
    await send(chatId, `Update check failed: ${err.message.slice(0, 600)}`);
    return;
  }
  if (check.blocked) { await send(chatId, `Not updating.\n${check.blocked}`); return; }

  const head = await updater.describeHead(ROOT);
  if (check.upToDate) {
    await send(chatId, `Already up to date: ${head.branch} @ ${head.sha} — ${head.subject}`);
    return;
  }

  await send(chatId, `Pulling ${check.commits.length} commit(s)${check.depsChanged ? ' (deps changed — npm install too)' : ''}:\n`
    + check.commits.slice(0, 10).join('\n')
    + (check.commits.length > 10 ? `\n…and ${check.commits.length - 10} more` : ''));

  let after;
  try {
    after = await updater.applyUpdate(ROOT, check);
  } catch (err) {
    await send(chatId, `Update failed: ${err.message.slice(0, 800)}`);
    return;
  }

  updater.noteRestart({ chatId, from: head?.sha, to: after?.sha });
  await send(chatId, `Now at ${after.sha}. Restarting…`);
  await confirmOffset();
  updater.restart();
}

/** Returns true if the message was an approval decision. */
async function handleApproval(chatId, text) {
  const words = text.trim().toLowerCase().split(/\s+/);
  const verb = words[0];
  const isYes = CONFIRM_WORDS.includes(verb) || CONFIRM_WORDS.includes(text.trim().toLowerCase());
  const isNo = DENY_WORDS.includes(verb);
  if (!isYes && !isNo) return false;

  const pending = approvals.list('pending');
  if (!pending.length) return false;

  let id = words.find((w) => /^[0-9a-f]{6}$/.test(w));
  if (!id) {
    if (pending.length > 1) {
      await send(chatId, `${pending.length} actions pending — say "yes <id>":\n`
        + pending.map((a) => `${a.id}  ${a.summary}`).join('\n'));
      return true;
    }
    id = pending[0].id;
  }

  if (isNo) {
    approvals.reject(id);
    await send(chatId, `Cancelled ${id}.`);
    return true;
  }

  const approved = approvals.approve(id);
  if (!approved.ok) { await send(chatId, `Could not approve: ${approved.error}`); return true; }

  await typing(chatId);
  const run = await approvals.runApproved(id);
  await send(chatId, run.ok ? `Done — ${approved.action.summary}` : `Failed: ${run.error}`);
  return true;
}

/** Surface anything the model queued during the turn. */
async function announcePending(chatId) {
  const pending = approvals.list('pending');
  if (!pending.length) return;
  await send(chatId, 'Waiting on you:\n'
    + pending.map((a) => `${a.id}  ${a.summary}${a.detail ? `\n   ${a.detail.slice(0, 300)}` : ''}`).join('\n\n')
    + '\n\nReply "yes <id>" to go ahead, "no <id>" to drop it.');
}

/* ---------------- main loop ---------------- */

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = msg.text;
  if (!chatId || !text) return;

  // Single-tenant by construction. Anyone who finds the bot gets nothing.
  if (String(chatId) !== CONFIG.telegramOwnerId) {
    console.warn(`ignored message from unauthorised chat ${chatId}`);
    return;
  }

  try {
    if (await handleCommand(chatId, text)) return;
    if (await handleApproval(chatId, text)) return;

    await typing(chatId);
    const keepAlive = setInterval(() => typing(chatId), 5000);
    const result = await runClaude(chatId, text);
    clearInterval(keepAlive);

    await send(chatId, result.text);
    await announcePending(chatId);
  } catch (err) {
    console.error(err);
    await send(chatId, `Bridge error: ${err.message}`).catch(() => {});
  }
}

/**
 * Telegram treats an update as delivered once a later getUpdates call passes
 * an offset beyond it. Module-level so `\update` can flush before exiting.
 */
let pollOffset = 0;
const confirmOffset = () => tg('getUpdates', { timeout: 0, offset: pollOffset }).catch(() => {});

async function main() {
  if (!CONFIG.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN is not set (see .env.example).');
  if (!CONFIG.telegramOwnerId) throw new Error('TELEGRAM_OWNER_CHAT_ID is not set — refusing to run an open bot.');

  const me = await tg('getMe', {});
  const tools = await discoverTools();
  const head = await updater.describeHead(ROOT);
  console.log(`columbia bridge up as @${me.username}; owner chat ${CONFIG.telegramOwnerId}`
    + (head ? `; ${head.branch} @ ${head.sha}` : ''));
  console.log(`${tools.length} tools allowed: ${tools.join(', ')}`);

  // Skip whatever piled up while we were down — replaying old texts as fresh
  // commands is worse than dropping them.
  const backlog = await tg('getUpdates', { timeout: 0, offset: -1 });
  if (backlog.length) pollOffset = backlog[backlog.length - 1].update_id + 1;

  // If we are the process a `\update` restarted into, close the loop.
  const restarted = updater.takeRestartMarker();
  if (restarted?.chatId) {
    await send(restarted.chatId, `Back up on ${head?.sha ?? '?'}${head?.subject ? ` — ${head.subject}` : ''}. `
      + `${tools.length} tools loaded.`).catch(() => {});
  }

  for (;;) {
    try {
      const updates = await tg('getUpdates', { timeout: 50, offset: pollOffset, allowed_updates: ['message'] });
      for (const u of updates) {
        pollOffset = u.update_id + 1;
        if (u.message) await handleMessage(u.message);
      }
    } catch (err) {
      console.error(`poll error: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
