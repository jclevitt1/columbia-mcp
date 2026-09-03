import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ENV_FROM_FILE, PATHS, readJson, writeJson } from './config.js';

const exec = promisify(execFile);

/**
 * Self-update over git, driven by the `\update` Telegram command.
 *
 * Why pull-on-command rather than a GitHub webhook: a webhook needs the Mini
 * reachable on public HTTPS, and the whole bridge is built around never
 * listening on a port. A command from the phone is instant, deliberate, and
 * costs no infrastructure. Restart timing is also inherently safe — the
 * bridge handles messages one at a time, so `\update` can only run between
 * Claude turns, never in the middle of one.
 *
 * Only fast-forwards. If the Mini's checkout has diverged or has local edits
 * to tracked files, it says so and touches nothing; that is a fix-by-hand
 * situation, not one to paper over from a phone.
 */

const RESTART_MARKER = path.join(PATHS.home, 'restart-pending.json');

async function git(root, args, opts = {}) {
  const { stdout } = await exec('git', args, { cwd: root, timeout: 60_000, ...opts });
  return stdout.trim();
}

/** Short sha + subject, for status lines. */
export async function describeHead(root) {
  try {
    const [sha, subject, branch] = await Promise.all([
      git(root, ['rev-parse', '--short', 'HEAD']),
      git(root, ['log', '-1', '--format=%s']),
      git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);
    return { sha, subject, branch };
  } catch {
    return null;
  }
}

/**
 * Fetch and compare. Never modifies the working tree.
 * @returns {{upToDate:boolean, branch:string, local:string, remote:string, commits:string[], depsChanged:boolean, blocked?:string}}
 */
export async function checkForUpdate(root) {
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') return { blocked: 'Detached HEAD — check out a branch on the Mini first.' };

  const dirty = await git(root, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) return { blocked: `Local edits to tracked files block a pull:\n${dirty.slice(0, 600)}` };

  await git(root, ['fetch', '--quiet', 'origin', branch], { timeout: 120_000 });

  const local = await git(root, ['rev-parse', 'HEAD']);
  const remote = await git(root, ['rev-parse', `origin/${branch}`]);
  if (local === remote) return { upToDate: true, branch, local, remote, commits: [], depsChanged: false };

  try {
    await git(root, ['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`]);
  } catch {
    return { blocked: `Local ${branch} has diverged from origin/${branch}; cannot fast-forward. Fix by hand.` };
  }

  const log = await git(root, ['log', '--format=%h %s', `HEAD..origin/${branch}`]);
  const changed = await git(root, ['diff', '--name-only', 'HEAD', `origin/${branch}`]);
  const depsChanged = /^(package\.json|package-lock\.json)$/m.test(changed);

  return { upToDate: false, branch, local, remote, commits: log.split('\n').filter(Boolean), depsChanged };
}

/**
 * Fast-forward to origin and reinstall dependencies if the manifest moved.
 * Rolls the checkout back if npm fails, so a half-applied update cannot
 * leave the bridge unable to start.
 */
export async function applyUpdate(root, check) {
  if (check.blocked || check.upToDate) throw new Error('applyUpdate called without a pending update');

  await git(root, ['merge', '--ff-only', `origin/${check.branch}`]);

  if (check.depsChanged) {
    try {
      await exec('npm', ['install', '--silent', '--no-audit', '--no-fund'], {
        cwd: root, timeout: 5 * 60_000, env: process.env,
      });
    } catch (err) {
      await git(root, ['reset', '--hard', check.local]);
      throw new Error(`npm install failed; rolled back to ${check.local.slice(0, 7)}.\n${String(err.stderr || err.message).slice(0, 600)}`);
    }
  }
  return describeHead(root);
}

/* ---------------- restart plumbing ---------------- */

/** Remember who asked, so the new process can say "back up" to them. */
export function noteRestart({ chatId, from, to }) {
  writeJson(RESTART_MARKER, { chatId, from, to, at: Date.now() });
}

/** Called once at startup. Returns the marker (and clears it) or null. */
export function takeRestartMarker() {
  const m = readJson(RESTART_MARKER, null);
  if (m) { try { fs.unlinkSync(RESTART_MARKER); } catch { /* already gone */ } }
  return m;
}

/**
 * Hand off to a fresh process running the new code.
 *
 * Under launchd (BRIDGE_SUPERVISOR=launchd, set by the plist) we simply exit:
 * KeepAlive restarts us, and spawning our own replacement would leave TWO
 * pollers on one Telegram token, which silently splits messages between them.
 * Run by hand there is no supervisor, so re-exec ourselves detached and exit.
 */
export function restart() {
  if (process.env.BRIDGE_SUPERVISOR) {
    process.exit(0);
  }
  // Hand over the environment we were *started* with, not the one loadEnv()
  // filled in — otherwise the child would never see a changed .env.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !ENV_FROM_FILE.has(k))
  );
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: 'inherit',
    cwd: process.cwd(),
    env,
  });
  child.unref();
  process.exit(0);
}
