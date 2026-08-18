import { PATHS, readJson, writeJson } from './config.js';

/**
 * Maps a Telegram chat to a Claude Code session id, so context survives
 * between texts. `\clear` just forgets the id — the next message starts a
 * fresh session rather than resuming.
 *
 * We never delete Claude's own transcript; dropping our pointer is enough,
 * and it means an accidental \clear is recoverable from ~/.claude if needed.
 */

function db() {
  const d = readJson(PATHS.sessions, { chats: {} });
  if (!d.chats) d.chats = {};
  return d;
}

export function getSession(chatId) {
  return db().chats[String(chatId)] ?? null;
}

export function setSession(chatId, sessionId) {
  const d = db();
  const key = String(chatId);
  const prev = d.chats[key];
  d.chats[key] = {
    sessionId,
    startedAt: prev?.sessionId === sessionId ? prev.startedAt : Date.now(),
    turns: prev?.sessionId === sessionId ? (prev.turns ?? 0) + 1 : 1,
    lastAt: Date.now(),
  };
  writeJson(PATHS.sessions, d);
  return d.chats[key];
}

export function clearSession(chatId) {
  const d = db();
  const had = Boolean(d.chats[String(chatId)]);
  delete d.chats[String(chatId)];
  writeJson(PATHS.sessions, d);
  return had;
}
