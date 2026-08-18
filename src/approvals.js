import crypto from 'node:crypto';
import { PATHS, readJson, writeJson } from './config.js';

/**
 * The check-off gate.
 *
 * Every write-class action (send mail, register, submit) is *enqueued* here
 * instead of executed. The MCP server can enqueue and read, but has no tool
 * that sets status to 'approved' — only the Telegram bridge does that, in
 * response to Jeremy typing the confirm word. So a misbehaving or
 * prompt-injected model cannot talk its way into sending anything: the gate
 * is a state machine in a file, not an instruction the model is asked to obey.
 *
 *   pending --approve()--> approved --markDone()--> done
 *          \--reject()--> rejected
 *
 * Only 'approved' actions are runnable, and each runs exactly once.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // stale approvals expire after a day

function load() {
  const db = readJson(PATHS.approvals, { actions: [] });
  if (!Array.isArray(db.actions)) db.actions = [];
  return db;
}

function save(db) {
  writeJson(PATHS.approvals, db);
}

function expire(db) {
  const now = Date.now();
  db.actions = db.actions.filter((a) => {
    if (a.status === 'pending' || a.status === 'approved') {
      return now - a.createdAt < TTL_MS;
    }
    // keep a short tail of resolved actions for the audit trail
    return now - a.createdAt < TTL_MS * 7;
  });
  return db;
}

/** Short, unambiguous, easy to type on a phone. */
function newId() {
  return crypto.randomBytes(3).toString('hex');
}

/**
 * @param {object} action
 * @param {string} action.kind    e.g. 'gmail.send' — dispatch key for executors
 * @param {string} action.summary one line Jeremy sees on his phone
 * @param {string} [action.detail] full body/diff, shown on request
 * @param {object} action.payload arguments the executor needs
 */
export function enqueue({ kind, summary, detail = '', payload = {} }) {
  const db = expire(load());
  const action = {
    id: newId(),
    kind,
    summary,
    detail,
    payload,
    status: 'pending',
    createdAt: Date.now(),
    resolvedAt: null,
    result: null,
  };
  db.actions.push(action);
  save(db);
  return action;
}

export function get(id) {
  return load().actions.find((a) => a.id === id) || null;
}

export function list(status = null) {
  const db = expire(load());
  save(db);
  return status ? db.actions.filter((a) => a.status === status) : db.actions;
}

function transition(id, from, to, patch = {}) {
  const db = expire(load());
  const action = db.actions.find((a) => a.id === id);
  if (!action) return { ok: false, error: `no action ${id}` };
  if (action.status !== from) {
    return { ok: false, error: `action ${id} is ${action.status}, expected ${from}` };
  }
  Object.assign(action, patch, { status: to, resolvedAt: Date.now() });
  save(db);
  return { ok: true, action };
}

/** Bridge-only. Never expose this as an MCP tool. */
export function approve(id) {
  return transition(id, 'pending', 'approved');
}

/** Bridge-only. */
export function reject(id, reason = 'rejected by user') {
  return transition(id, 'pending', 'rejected', { result: { reason } });
}

export function markDone(id, result) {
  return transition(id, 'approved', 'done', { result });
}

export function markFailed(id, error) {
  return transition(id, 'approved', 'failed', { result: { error: String(error) } });
}

/* ---------- executors ---------- */

const executors = new Map();

/** @param {string} kind @param {(payload:object)=>Promise<any>} fn */
export function registerExecutor(kind, fn) {
  executors.set(kind, fn);
}

/**
 * Run an action that has already been approved. Refuses anything else, so
 * this is safe to call from any code path.
 */
export async function runApproved(id) {
  const action = get(id);
  if (!action) return { ok: false, error: `no action ${id}` };
  if (action.status !== 'approved') {
    return { ok: false, error: `action ${id} is ${action.status}, not approved` };
  }
  const fn = executors.get(action.kind);
  if (!fn) {
    markFailed(id, `no executor registered for kind '${action.kind}'`);
    return { ok: false, error: `no executor for ${action.kind}` };
  }
  try {
    const result = await fn(action.payload);
    markDone(id, result);
    return { ok: true, result };
  } catch (err) {
    markFailed(id, err);
    return { ok: false, error: String(err) };
  }
}
