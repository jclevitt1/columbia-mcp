import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
process.env.COLUMBIA_MCP_HOME = tmp;

const { readJson, writeJson, loadEnv, ensureHome, PATHS } = await import('../src/config.js');

describe('config', () => {
  describe('readJson / writeJson', () => {
    it('round-trips JSON to disk', () => {
      const file = path.join(tmp, 'test.json');
      writeJson(file, { hello: 'world', n: 42 });
      const result = readJson(file, null);
      assert.deepStrictEqual(result, { hello: 'world', n: 42 });
    });

    it('returns fallback for missing file', () => {
      const result = readJson(path.join(tmp, 'nope.json'), { default: true });
      assert.deepStrictEqual(result, { default: true });
    });

    it('returns fallback for corrupt JSON', () => {
      const file = path.join(tmp, 'bad.json');
      fs.writeFileSync(file, 'not json {{{');
      const result = readJson(file, { fallback: true });
      assert.deepStrictEqual(result, { fallback: true });
    });

    it('writes atomically via .tmp rename', () => {
      const file = path.join(tmp, 'atomic.json');
      writeJson(file, { a: 1 });
      // .tmp should not linger
      assert.equal(fs.existsSync(`${file}.tmp`), false);
      assert.equal(fs.existsSync(file), true);
    });
  });

  describe('loadEnv', () => {
    it('loads key=value pairs from .env file', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
      fs.writeFileSync(path.join(dir, '.env'), [
        '# comment',
        'TEST_KEY_A=hello',
        'TEST_KEY_B="quoted value"',
        "TEST_KEY_C='single quoted'",
        '',
        'TEST_KEY_D=has=equals',
      ].join('\n'));

      // Clear any pre-existing values
      delete process.env.TEST_KEY_A;
      delete process.env.TEST_KEY_B;
      delete process.env.TEST_KEY_C;
      delete process.env.TEST_KEY_D;

      loadEnv(dir);

      assert.equal(process.env.TEST_KEY_A, 'hello');
      assert.equal(process.env.TEST_KEY_B, 'quoted value');
      assert.equal(process.env.TEST_KEY_C, 'single quoted');
      assert.equal(process.env.TEST_KEY_D, 'has=equals');

      // Clean up
      delete process.env.TEST_KEY_A;
      delete process.env.TEST_KEY_B;
      delete process.env.TEST_KEY_C;
      delete process.env.TEST_KEY_D;
      fs.rmSync(dir, { recursive: true });
    });

    it('does not override existing env vars', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
      process.env.TEST_EXISTING = 'original';
      fs.writeFileSync(path.join(dir, '.env'), 'TEST_EXISTING=overwritten\n');

      loadEnv(dir);
      assert.equal(process.env.TEST_EXISTING, 'original');

      delete process.env.TEST_EXISTING;
      fs.rmSync(dir, { recursive: true });
    });

    it('silently does nothing if .env is missing', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
      // No .env file — should not throw
      loadEnv(dir);
      fs.rmSync(dir, { recursive: true });
    });
  });

  describe('ensureHome', () => {
    it('creates home and logs directories', () => {
      // COLUMBIA_MCP_HOME already points at tmp
      ensureHome();
      assert.equal(fs.existsSync(tmp), true);
      assert.equal(fs.existsSync(path.join(tmp, 'logs')), true);
    });
  });
});
