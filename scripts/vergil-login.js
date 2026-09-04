#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, PATHS } from '../src/config.js';
import * as vergil from '../src/tools/vergil.js';

loadEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

/**
 * Run this once on the Mac Mini, at the physical machine.
 *
 * A Chromium window opens on columbia.edu. Sign in with your UNI and approve
 * the Duo push by hand. Both the CAS session and the Cloudflare clearance
 * cookie persist into the profile, so the bridge can browse unattended
 * afterwards. Re-run whenever CAS expires.
 */
console.log(`Opening a browser against the persistent profile at:\n  ${PATHS.browserProfile}\n`);
console.log('Sign in with your UNI + Duo. This script exits once you are through.');
console.log('It visits Vergil and then SSOL; the second should carry through on its own.\n');

const result = await vergil.login({});
for (const step of result.steps) {
  console.log(step.ok ? `ok    ${step.startUrl} -> ${step.url}` : `FAIL  ${step.startUrl}: ${step.error}`);
}
console.log(result.ok ? '\nLogged in.' : '\nSome hosts did not authenticate.');
await vergil.closeContext();
process.exit(result.ok ? 0 : 1);
