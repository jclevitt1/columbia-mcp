import { google } from 'googleapis';

/**
 * Shared Google OAuth client for every Google surface (mail, Drive, Docs,
 * Sheets). One client, one consent, one refresh token.
 *
 * Scope note, stated plainly: Google has no draft-only or append-only scope.
 * `gmail.compose` grants sending; `documents` and `spreadsheets` grant
 * editing. So OAuth is NOT what stops an unapproved write — the approvals
 * gate in ../approvals.js is. One control, and it lives in our code.
 */
export const SCOPES = [
  // Mail
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  // Find and read existing files
  'https://www.googleapis.com/auth/drive.readonly',
  // Create new files (and manage only the ones we created)
  'https://www.googleapis.com/auth/drive.file',
  // Read + write Docs and Sheets
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
];

export const REDIRECT_PORT = 8788;
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

export class GoogleAuthError extends Error {}

/** Bare client, no credentials — for the auth script. */
export function bareClient() {
  const { GMAIL_CLIENT_ID: id, GMAIL_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) {
    throw new GoogleAuthError(
      'GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET are not set in .env.'
    );
  }
  return new google.auth.OAuth2(id, secret, REDIRECT_URI);
}

/** Authorised client, ready to use. */
export function authedClient() {
  const client = bareClient();
  const refresh = process.env.GMAIL_REFRESH_TOKEN;
  if (!refresh) {
    throw new GoogleAuthError(
      'No GMAIL_REFRESH_TOKEN. Run `npm run gmail-auth` to mint one.'
    );
  }
  client.setCredentials({ refresh_token: refresh });
  return client;
}

export const drive = () => google.drive({ version: 'v3', auth: authedClient() });
export const docs = () => google.docs({ version: 'v1', auth: authedClient() });
export const sheets = () => google.sheets({ version: 'v4', auth: authedClient() });
export const gmail = () => google.gmail({ version: 'v1', auth: authedClient() });
