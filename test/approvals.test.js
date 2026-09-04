import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point state at a temp dir so tests never touch real data.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-test-'));
process.env.COLUMBIA_MCP_HOME = tmp;

const approvals = await import('../src/approvals.js');

describe('approvals', () => {
  beforeEach(() => {
    // Wipe state between tests.
    const file = path.join(tmp, 'approvals.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  afterEach(() => {
    // Clean up .tmp files if any.
    for (const f of fs.readdirSync(tmp)) {
      if (f.endsWith('.tmp')) fs.unlinkSync(path.join(tmp, f));
    }
  });

  describe('enqueue', () => {
    it('creates an action with status pending', () => {
      const action = approvals.enqueue({
        kind: 'gmail.send',
        summary: 'Send test email',
        payload: { draftId: '123' },
      });

      assert.equal(action.status, 'pending');
      assert.equal(action.kind, 'gmail.send');
      assert.equal(action.summary, 'Send test email');
      assert.deepStrictEqual(action.payload, { draftId: '123' });
      assert.equal(typeof action.id, 'string');
      assert.equal(action.id.length, 6); // 3 random bytes = 6 hex chars
      assert.equal(action.resolvedAt, null);
    });

    it('assigns unique ids', () => {
      const ids = new Set();
      for (let i = 0; i < 20; i++) {
        const a = approvals.enqueue({ kind: 'test', summary: `t${i}`, payload: {} });
        ids.add(a.id);
      }
      assert.equal(ids.size, 20);
    });

    it('defaults detail to empty string and payload to empty object', () => {
      const a = approvals.enqueue({ kind: 'test', summary: 's' });
      assert.equal(a.detail, '');
      assert.deepStrictEqual(a.payload, {});
    });
  });

  describe('get', () => {
    it('returns the action by id', () => {
      const a = approvals.enqueue({ kind: 'test', summary: 'find me', payload: {} });
      const found = approvals.get(a.id);
      assert.equal(found.id, a.id);
      assert.equal(found.summary, 'find me');
    });

    it('returns null for unknown id', () => {
      assert.equal(approvals.get('000000'), null);
    });
  });

  describe('list', () => {
    it('returns all actions when no status filter', () => {
      approvals.enqueue({ kind: 'a', summary: '1', payload: {} });
      approvals.enqueue({ kind: 'b', summary: '2', payload: {} });
      const all = approvals.list();
      assert.equal(all.length, 2);
    });

    it('filters by status', () => {
      const a = approvals.enqueue({ kind: 'test', summary: '1', payload: {} });
      approvals.enqueue({ kind: 'test', summary: '2', payload: {} });
      approvals.approve(a.id);

      const pending = approvals.list('pending');
      assert.equal(pending.length, 1);
      assert.equal(pending[0].summary, '2');

      const approved = approvals.list('approved');
      assert.equal(approved.length, 1);
      assert.equal(approved[0].id, a.id);
    });
  });

  describe('state transitions', () => {
    it('pending -> approved -> done', () => {
      const a = approvals.enqueue({ kind: 'test', summary: 's', payload: {} });

      const r1 = approvals.approve(a.id);
      assert.equal(r1.ok, true);
      assert.equal(r1.action.status, 'approved');

      const r2 = approvals.markDone(a.id, { result: 'ok' });
      assert.equal(r2.ok, true);
      assert.equal(r2.action.status, 'done');
    });

    it('pending -> rejected', () => {
      const a = approvals.enqueue({ kind: 'test', summary: 's', payload: {} });
      const r = approvals.reject(a.id, 'nope');
      assert.equal(r.ok, true);
      assert.equal(r.action.status, 'rejected');
      assert.equal(r.action.result.reason, 'nope');
    });

    it('approved -> failed', () => {
      const a = approvals.enqueue({ kind: 'test', summary: 's', payload: {} });
      approvals.approve(a.id);
      const r = approvals.markFailed(a.id, 'boom');
      assert.equal(r.ok, true);
      assert.equal(r.action.status, 'failed');
      assert.equal(r.action.result.error, 'boom');
    });

    it('rejects invalid transitions', () => {
      const a = approvals.enqueue({ kind: 'test', summary: 's', payload: {} });

      // Can't go straight to done from pending
      const r1 = approvals.markDone(a.id, {});
      assert.equal(r1.ok, false);
      assert.match(r1.error, /pending.*expected approved/);

      // Can't approve twice
      approvals.approve(a.id);
      const r2 = approvals.approve(a.id);
      assert.equal(r2.ok, false);
    });

    it('returns error for unknown id', () => {
      const r = approvals.approve('ffffff');
      assert.equal(r.ok, false);
      assert.match(r.error, /no action/);
    });
  });

  describe('executors', () => {
    it('runApproved runs the registered executor', async () => {
      let called = false;
      approvals.registerExecutor('test.run', async (p) => {
        called = true;
        return { echoed: p.val };
      });

      const a = approvals.enqueue({ kind: 'test.run', summary: 's', payload: { val: 42 } });
      approvals.approve(a.id);

      const r = await approvals.runApproved(a.id);
      assert.equal(r.ok, true);
      assert.equal(called, true);
      assert.equal(r.result.echoed, 42);

      // Action should now be 'done'
      const after = approvals.get(a.id);
      assert.equal(after.status, 'done');
    });

    it('runApproved refuses non-approved actions', async () => {
      const a = approvals.enqueue({ kind: 'test.run', summary: 's', payload: {} });
      const r = await approvals.runApproved(a.id);
      assert.equal(r.ok, false);
      assert.match(r.error, /not approved/);
    });

    it('runApproved marks action as failed on executor error', async () => {
      approvals.registerExecutor('test.fail', async () => {
        throw new Error('kaboom');
      });

      const a = approvals.enqueue({ kind: 'test.fail', summary: 's', payload: {} });
      approvals.approve(a.id);

      const r = await approvals.runApproved(a.id);
      assert.equal(r.ok, false);
      assert.match(r.error, /kaboom/);

      const after = approvals.get(a.id);
      assert.equal(after.status, 'failed');
    });

    it('runApproved fails if no executor is registered for the kind', async () => {
      const a = approvals.enqueue({ kind: 'unregistered.kind', summary: 's', payload: {} });
      approvals.approve(a.id);

      const r = await approvals.runApproved(a.id);
      assert.equal(r.ok, false);
      assert.match(r.error, /no executor/);

      const after = approvals.get(a.id);
      assert.equal(after.status, 'failed');
    });
  });

  describe('persistence', () => {
    it('survives reimport (data is on disk)', async () => {
      const a = approvals.enqueue({ kind: 'test', summary: 'persist', payload: { x: 1 } });

      // Re-read from disk
      const found = approvals.get(a.id);
      assert.equal(found.summary, 'persist');
      assert.deepStrictEqual(found.payload, { x: 1 });
    });
  });
});
