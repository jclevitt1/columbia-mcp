#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG, ensureHome, loadEnv } from '../config.js';
import * as approvals from '../approvals.js';
import * as sessions from '../sessions.js';
import * as mail from '../tools/gmail.js';

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

/* The bridge is the only process allowed to approve, so it needs the executor. */
approvals.registerExecutor('gmail.send', (payload) => mail.sendDraft(payload));

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
columbia.edu page, mail_* for Columbia mail.

You may read freely. You may NOT send anything on his behalf: write mail_draft
to save a draft, then mail_request_send to queue it for his approval, then tell
him it is waiting. He approves from Telegram; you cannot approve for him.

If a tool reports it is unconfigured, say so plainly and name the setup step.
Do not guess at data you could not fetch.
`.trim();

const ALLOWED_TOOLS = [
  'mcp__columbia__canvas_courses',
  'mcp__columbia__canvas_assignments',
  'mcp__columbia__canvas_upcoming',
  'mcp__columbia__canvas_todo',
  'mcp__columbia__canvas_announcements',
  'mcp__columbia__canvas_grades',
  'mcp__columbia__vergil_search',
  'mcp__columbia__vergil_browse',
  'mcp__columbia__vergil_session_status',
  'mcp__columbia__mail_search',
  'mcp__columbia__mail_read',
  'mcp__columbia__mail_draft',
  'mcp__columbia__mail_request_send',
  'mcp__columbia__approvals_list',
  'Read',
  'Glob',
  'Grep',
];

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
function runClaude(chatId, prompt) {
  const prior = sessions.getSession(chatId);
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--mcp-config', mcpConfig(),
    '--strict-mcp-config',
    '--append-system-prompt', SYSTEM_APPEND,
    '--allowedTools', ...ALLOWED_TOOLS,
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
\\status    session info + config health
\\pending   list actions waiting on you
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
    await send(chatId, [
      s ? `Session: ${s.sessionId.slice(0, 8)}… (${s.turns} turns)` : 'Session: none — next message starts fresh',
      `Mail backend: ${CONFIG.gmailBackend}`,
      `Canvas token: ${CONFIG.canvasToken ? 'set' : 'MISSING'}`,
      `Pending approvals: ${pending.length}`,
    ].join('\n'));
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

async function main() {
  if (!CONFIG.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN is not set (see .env.example).');
  if (!CONFIG.telegramOwnerId) throw new Error('TELEGRAM_OWNER_CHAT_ID is not set — refusing to run an open bot.');

  const me = await tg('getMe', {});
  console.log(`columbia bridge up as @${me.username}; owner chat ${CONFIG.telegramOwnerId}`);

  // Skip whatever piled up while we were down — replaying old texts as fresh
  // commands is worse than dropping them.
  let offset = 0;
  const backlog = await tg('getUpdates', { timeout: 0, offset: -1 });
  if (backlog.length) offset = backlog[backlog.length - 1].update_id + 1;

  for (;;) {
    try {
      const updates = await tg('getUpdates', { timeout: 50, offset, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
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
