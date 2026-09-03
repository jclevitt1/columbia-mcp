import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * All mutable state (tokens, sessions, pending approvals, the Playwright
 * profile) lives OUTSIDE the repo so nothing secret can be committed by
 * accident. Override with COLUMBIA_MCP_HOME if you want it elsewhere.
 */
export const HOME = process.env.COLUMBIA_MCP_HOME
  || path.join(os.homedir(), '.columbia-mcp');

export const PATHS = {
  home: HOME,
  sessions: path.join(HOME, 'sessions.json'),
  approvals: path.join(HOME, 'approvals.json'),
  browserProfile: path.join(HOME, 'browser-profile'),
  logs: path.join(HOME, 'logs'),
};

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(PATHS.logs, { recursive: true, mode: 0o700 });
}

/**
 * Keys loadEnv() set from the file, as opposed to ones already in the
 * environment. The updater strips these before re-exec'ing so the new process
 * re-reads .env instead of inheriting stale values (a re-minted refresh token
 * is the case that matters).
 */
export const ENV_FROM_FILE = new Set();

/** Load .env from the repo root without adding a dependency. */
export function loadEnv(root = process.cwd()) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) { process.env[key] = val; ENV_FROM_FILE.add(key); }
  }
}

/** Read a JSON file, returning `fallback` if it is missing or corrupt. */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically so a crash mid-write cannot truncate state. */
export function writeJson(file, value) {
  ensureHome();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const CONFIG = {
  get canvasBase() {
    return process.env.CANVAS_BASE_URL || 'https://courseworks2.columbia.edu';
  },
  get canvasToken() {
    return process.env.CANVAS_ACCESS_TOKEN || '';
  },
  /** 'none' until Jeremy confirms what CUIT actually permits. See SETUP.md. */
  get gmailBackend() {
    return process.env.GMAIL_BACKEND || 'none';
  },
  get telegramToken() {
    return process.env.TELEGRAM_BOT_TOKEN || '';
  },
  /** Only this chat id may drive the bridge. Non-negotiable — see bridge. */
  get telegramOwnerId() {
    return String(process.env.TELEGRAM_OWNER_CHAT_ID || '');
  },
  get claudeBin() {
    return process.env.CLAUDE_BIN || 'claude';
  },
  get workdir() {
    return process.env.COLUMBIA_WORKDIR || path.join(os.homedir(), 'workspace', 'Columbia');
  },
};
