#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import { loadEnv } from '../src/config.js';
import { SCOPES, REDIRECT_PORT, REDIRECT_URI } from '../src/tools/google-auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(ROOT);

/**
 * Mints the Google refresh token used by every Google surface: mail, Drive,
 * Docs and Sheets. One consent covers all of them — see SCOPES in
 * src/tools/google-auth.js, which is the single source of truth.
 */
const PORT = REDIRECT_PORT;
const REDIRECT = REDIRECT_URI;

const { GMAIL_CLIENT_ID: id, GMAIL_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) {
  console.error(
    'Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first.\n\n'
    + '  1. https://console.cloud.google.com -> new project\n'
    + '  2. Enable: Gmail API, Google Docs API, Google Sheets API, Google Drive API\n'
    + '  3. OAuth consent screen -> External -> add your @columbia.edu as a test user\n'
    + '  4. Credentials -> Create OAuth client ID -> **Desktop app**\n'
    + `     (Desktop clients accept any http://localhost redirect, so there is\n`
    + `      nothing to register. If you pick "Web application" instead, add\n`
    + `      ${REDIRECT} as an authorised redirect URI.)\n`
  );
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(id, secret, REDIRECT);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',        // force a refresh_token even on re-auth
  scope: SCOPES,
});

console.log('Opening the consent screen. Sign in with your @columbia.edu account.\n');
console.log(`If nothing opens, visit:\n${authUrl}\n`);
console.log('Watch for "Access blocked" or an admin-policy error — that is CUIT');
console.log('refusing third-party OAuth, and the answer is GMAIL_BACKEND=apple_mail.\n');

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) { res.writeHead(404).end(); return; }
  const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const error = params.get('error');
  const code = params.get('code');

  const reply = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="font:16px system-ui;padding:3rem">${msg}</body></html>`);
  };

  if (error) {
    reply(`<h2>Denied</h2><p>${error}</p><p>Back to the terminal.</p>`);
    console.error(`\nDenied: ${error}`);
    console.error('If this is an admin/policy block, switch to GMAIL_BACKEND=apple_mail.');
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const { data } = await gmail.users.getProfile({ userId: 'me' });

    reply('<h2>Done</h2><p>Token captured. Back to the terminal.</p>');
    console.log(`\nAuthenticated as: ${data.emailAddress}`);
    console.log(`Messages in mailbox: ${data.messagesTotal}`);

    if (!tokens.refresh_token) {
      console.error('\nNo refresh_token returned. Revoke the app at '
        + 'https://myaccount.google.com/permissions and re-run.');
      server.close();
      process.exit(1);
    }

    writeEnv(tokens.refresh_token);
    console.log('\nWrote GMAIL_REFRESH_TOKEN and set GMAIL_BACKEND=gmail_api in .env.');
    console.log('Verify with: npm run doctor');
    server.close();
    process.exit(0);
  } catch (err) {
    reply(`<h2>Token exchange failed</h2><pre>${err.message}</pre>`);
    console.error(`\nToken exchange failed: ${err.message}`);
    server.close();
    process.exit(1);
  }
});

/** Patch .env in place rather than making him copy-paste a secret. */
function writeEnv(refreshToken) {
  const file = path.join(ROOT, '.env');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const set = (key, val) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${key}=${val}`) : `${text.trimEnd()}\n${key}=${val}\n`;
  };
  set('GMAIL_REFRESH_TOKEN', refreshToken);
  set('GMAIL_BACKEND', 'gmail_api');
  fs.writeFileSync(file, text, { mode: 0o600 });
}

server.listen(PORT, () => {
  execFile('open', [authUrl], () => {});
});
