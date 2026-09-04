import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Gmail helper functions replicated from src/tools/gmail.js for unit testing.
 */

// --- parseRecords (from gmail.js:69-79) ---

function parseRecords(raw, fields) {
  if (!raw) return [];
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((row) => {
      const parts = row.split('\x1f');
      return Object.fromEntries(fields.map((f, i) => [f, (parts[i] ?? '').trim()]));
    });
}

// --- escapeAS (from gmail.js:155-157) ---

function escapeAS(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// --- extractBody (from gmail.js:202-212) ---

function extractBody(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  for (const p of part.parts || []) {
    const found = extractBody(p);
    if (found) return found;
  }
  return '';
}

describe('gmail helpers', () => {
  describe('parseRecords', () => {
    it('splits records by RS and fields by FS', () => {
      const raw = `id1\x1fSubject One\x1fsender@cu.edu\x1e` +
                  `id2\x1fSubject Two\x1fother@cu.edu`;
      const result = parseRecords(raw, ['id', 'subject', 'from']);
      assert.equal(result.length, 2);
      assert.deepStrictEqual(result[0], { id: 'id1', subject: 'Subject One', from: 'sender@cu.edu' });
      assert.deepStrictEqual(result[1], { id: 'id2', subject: 'Subject Two', from: 'other@cu.edu' });
    });

    it('returns empty array for empty/falsy input', () => {
      assert.deepStrictEqual(parseRecords('', ['a']), []);
      assert.deepStrictEqual(parseRecords(null, ['a']), []);
      assert.deepStrictEqual(parseRecords(undefined, ['a']), []);
    });

    it('handles missing fields gracefully', () => {
      const raw = `id1\x1fSubject\x1e`;
      const result = parseRecords(raw, ['id', 'subject', 'from', 'date']);
      assert.equal(result[0].from, '');
      assert.equal(result[0].date, '');
    });

    it('trims whitespace from field values', () => {
      const raw = `  id1  \x1f  Hello World  `;
      const result = parseRecords(raw, ['id', 'subject']);
      assert.equal(result[0].id, 'id1');
      assert.equal(result[0].subject, 'Hello World');
    });
  });

  describe('escapeAS', () => {
    it('escapes backslashes and double quotes', () => {
      assert.equal(escapeAS('say "hello"'), 'say \\"hello\\"');
      assert.equal(escapeAS('path\\to\\file'), 'path\\\\to\\\\file');
    });

    it('handles null/undefined', () => {
      assert.equal(escapeAS(null), '');
      assert.equal(escapeAS(undefined), '');
    });

    it('leaves clean strings unchanged', () => {
      assert.equal(escapeAS('plain text'), 'plain text');
    });

    it('handles combined escaping', () => {
      assert.equal(escapeAS('a "b\\" c'), 'a \\"b\\\\\\" c');
    });
  });

  describe('extractBody', () => {
    it('extracts text/plain body from base64url', () => {
      const encoded = Buffer.from('Hello, world!').toString('base64url');
      const part = { mimeType: 'text/plain', body: { data: encoded } };
      assert.equal(extractBody(part), 'Hello, world!');
    });

    it('recurses into multipart', () => {
      const encoded = Buffer.from('nested body').toString('base64url');
      const part = {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/html', body: { data: Buffer.from('<b>html</b>').toString('base64url') } },
          { mimeType: 'text/plain', body: { data: encoded } },
        ],
      };
      // Should find text/plain first (it checks in order, text/html doesn't match)
      assert.equal(extractBody(part), 'nested body');
    });

    it('returns empty string for null part', () => {
      assert.equal(extractBody(null), '');
      assert.equal(extractBody(undefined), '');
    });

    it('returns empty string when no text/plain found', () => {
      const part = {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/html', body: { data: Buffer.from('html').toString('base64url') } },
        ],
      };
      assert.equal(extractBody(part), '');
    });

    it('handles deeply nested multipart', () => {
      const encoded = Buffer.from('deep body').toString('base64url');
      const part = {
        mimeType: 'multipart/mixed',
        parts: [{
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/plain', body: { data: encoded } }],
        }],
      };
      assert.equal(extractBody(part), 'deep body');
    });
  });
});
