import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-test-'));
process.env.COLUMBIA_MCP_HOME = tmp;

const { getSession, setSession, clearSession } = await import('../src/sessions.js');

describe('sessions', () => {
  beforeEach(() => {
    const file = path.join(tmp, 'sessions.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  it('returns null for unknown chat', () => {
    assert.equal(getSession('999'), null);
  });

  it('stores and retrieves a session', () => {
    setSession('42', 'session-abc');
    const s = getSession('42');
    assert.equal(s.sessionId, 'session-abc');
    assert.equal(s.turns, 1);
    assert.equal(typeof s.startedAt, 'number');
    assert.equal(typeof s.lastAt, 'number');
  });

  it('increments turns on same session id', () => {
    setSession('42', 'session-abc');
    setSession('42', 'session-abc');
    setSession('42', 'session-abc');
    const s = getSession('42');
    assert.equal(s.turns, 3);
    assert.equal(s.sessionId, 'session-abc');
  });

  it('resets turns on new session id', () => {
    setSession('42', 'session-abc');
    setSession('42', 'session-abc');
    const s1 = getSession('42');
    assert.equal(s1.turns, 2);

    setSession('42', 'session-def');
    const s2 = getSession('42');
    assert.equal(s2.turns, 1);
    assert.equal(s2.sessionId, 'session-def');
  });

  it('clears a session and returns whether one existed', () => {
    setSession('42', 'session-abc');
    assert.equal(clearSession('42'), true);
    assert.equal(getSession('42'), null);
    assert.equal(clearSession('42'), false);
  });

  it('handles numeric and string chat ids identically', () => {
    setSession(42, 'session-abc');
    const s = getSession('42');
    assert.equal(s.sessionId, 'session-abc');
  });

  it('isolates different chat ids', () => {
    setSession('1', 'session-a');
    setSession('2', 'session-b');
    assert.equal(getSession('1').sessionId, 'session-a');
    assert.equal(getSession('2').sessionId, 'session-b');
  });
});
