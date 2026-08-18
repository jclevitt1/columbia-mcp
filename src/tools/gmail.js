import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG } from '../config.js';

const exec = promisify(execFile);

/**
 * Columbia mail access, behind a swappable backend.
 *
 * The backend is deliberately unset ('none') until Jeremy confirms what CUIT
 * actually permits — see SETUP.md, step 3. The two candidates:
 *
 *   'gmail_api'  Google Workspace OAuth. Cleanest API by far, but Columbia
 *                may block unverified third-party OAuth clients for the
 *                scopes we need. Unknowable without logging in as him.
 *   'apple_mail' AppleScript against Mail.app on the Mini. Needs no admin
 *                blessing at all — Mail already holds the account — at the
 *                cost of being slower and macOS-only. This is the fallback
 *                that cannot be administratively taken away.
 *
 * Reads are direct. Anything that leaves the machine (sending) is enqueued
 * through ../approvals.js and never executed here.
 */

class MailError extends Error {}

function backend() {
  const b = CONFIG.gmailBackend;
  if (b === 'none') {
    throw new MailError(
      'No mail backend is configured yet. Set GMAIL_BACKEND=apple_mail (works '
      + 'today, no approvals needed) or GMAIL_BACKEND=gmail_api (needs OAuth '
      + 'credentials and may be blocked by CUIT). See SETUP.md step 3.'
    );
  }
  return b;
}

/* ---------- AppleScript backend ---------- */

async function osascript(script) {
  try {
    const { stdout } = await exec('osascript', ['-e', script], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60000,
    });
    return stdout.trim();
  } catch (err) {
    const msg = String(err.stderr || err.message);
    if (/not authorized|assistive access|1743/i.test(msg)) {
      throw new MailError(
        'macOS blocked the AppleScript. Grant the process that runs this '
        + '(Terminal, or launchd) Automation access to Mail under System '
        + 'Settings -> Privacy & Security -> Automation.'
      );
    }
    throw new MailError(`osascript failed: ${msg.slice(0, 400)}`);
  }
}

/**
 * AppleScript has no JSON, and mail subjects are full of quotes and newlines,
 * so we emit records on ASCII unit/record separators and split here. Fragile
 * to nothing except a message that literally contains \x1f.
 */
const FS = '\\x1f';
const RS = '\\x1e';

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

async function appleSearch({ query, limit, mailbox }) {
  const box = mailbox || 'INBOX';
  // `whose` filtering in AppleScript is slow but pushes the work into Mail
  // rather than serialising every message across the osascript boundary.
  const filter = query
    ? `whose (subject contains "${escapeAS(query)}" or sender contains "${escapeAS(query)}")`
    : '';
  const script = `
    set out to ""
    tell application "Mail"
      set acct to first account whose name contains "Columbia" or user name contains "columbia"
      set box to mailbox "${escapeAS(box)}" of acct
      set msgs to (messages of box ${filter})
      set n to count of msgs
      if n > ${limit} then set n to ${limit}
      repeat with i from 1 to n
        set m to item i of msgs
        set out to out & (id of m as string) & "${FS}" & (subject of m) & "${FS}" & (sender of m) & "${FS}" & ((date received of m) as string) & "${FS}" & (read status of m as string) & "${RS}"
      end repeat
    end tell
    return out
  `;
  const raw = await osascript(script);
  return parseRecords(raw, ['id', 'subject', 'from', 'date', 'read']);
}

async function appleRead(id) {
  const script = `
    tell application "Mail"
      set acct to first account whose name contains "Columbia" or user name contains "columbia"
      repeat with box in mailboxes of acct
        try
          set m to (first message of box whose id is ${Number(id)})
          return (subject of m) & "${FS}" & (sender of m) & "${FS}" & ((date received of m) as string) & "${FS}" & (content of m)
        end try
      end repeat
    end tell
    return ""
  `;
  const raw = await osascript(script);
  const [subject, from, date, ...rest] = raw.split('\x1f');
  if (!subject) throw new MailError(`no message with id ${id}`);
  return { id, subject, from, date, body: rest.join('\x1f').slice(0, 20000) };
}

async function appleCreateDraft({ to, subject, body }) {
  const script = `
    tell application "Mail"
      set acct to first account whose name contains "Columbia" or user name contains "columbia"
      set msg to make new outgoing message with properties {subject:"${escapeAS(subject)}", content:"${escapeAS(body)}", visible:false}
      tell msg
        set sender to (email addresses of acct)'s item 1
        make new to recipient at end of to recipients with properties {address:"${escapeAS(to)}"}
        save
      end tell
      return (id of msg) as string
    end tell
  `;
  const id = await osascript(script);
  return { draftId: id, to, subject };
}

async function appleSendDraft({ draftId }) {
  const script = `
    tell application "Mail"
      set msg to first outgoing message whose id is ${Number(draftId)}
      send msg
      return "sent"
    end tell
  `;
  await osascript(script);
  return { sent: true, draftId };
}

function escapeAS(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/* ---------- Gmail API backend (lazy) ---------- */

async function gmailClient() {
  let google;
  try {
    ({ google } = await import('googleapis'));
  } catch {
    throw new MailError('GMAIL_BACKEND=gmail_api requires `npm install googleapis`.');
  }
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new MailError(
      'Gmail OAuth is not set up. Run `npm run gmail-auth` on the Mini to mint '
      + 'a refresh token, or switch to GMAIL_BACKEND=apple_mail.'
    );
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, 'http://localhost:8788/oauth2callback');
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

async function apiSearch({ query, limit }) {
  const gmail = await gmailClient();
  const { data } = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: limit });
  const ids = (data.messages || []).map((m) => m.id);
  const out = [];
  for (const id of ids) {
    const { data: msg } = await gmail.users.messages.get({
      userId: 'me', id, format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    });
    const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name, x.value]));
    out.push({
      id,
      subject: h.Subject ?? '',
      from: h.From ?? '',
      date: h.Date ?? '',
      snippet: msg.snippet ?? '',
      read: !(msg.labelIds || []).includes('UNREAD'),
    });
  }
  return out;
}

async function apiRead(id) {
  const gmail = await gmailClient();
  const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const h = Object.fromEntries((data.payload?.headers || []).map((x) => [x.name, x.value]));
  return {
    id,
    subject: h.Subject ?? '',
    from: h.From ?? '',
    date: h.Date ?? '',
    body: extractBody(data.payload).slice(0, 20000),
  };
}

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

async function apiCreateDraft({ to, subject, body }) {
  const gmail = await gmailClient();
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`
  ).toString('base64url');
  const { data } = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  return { draftId: data.id, to, subject };
}

async function apiSendDraft({ draftId }) {
  const gmail = await gmailClient();
  await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
  return { sent: true, draftId };
}

/* ---------- dispatch ---------- */

export async function searchMessages({ query = '', limit = 15, mailbox = 'INBOX' } = {}) {
  return backend() === 'gmail_api'
    ? apiSearch({ query, limit })
    : appleSearch({ query, limit, mailbox });
}

export async function readMessage(id) {
  return backend() === 'gmail_api' ? apiRead(id) : appleRead(id);
}

/** Drafting is safe — nothing leaves the machine until sendDraft is approved. */
export async function createDraft({ to, subject, body }) {
  return backend() === 'gmail_api'
    ? apiCreateDraft({ to, subject, body })
    : appleCreateDraft({ to, subject, body });
}

/** Called ONLY by the approvals executor. Never wired to a tool directly. */
export async function sendDraft({ draftId }) {
  return backend() === 'gmail_api' ? apiSendDraft({ draftId }) : appleSendDraft({ draftId });
}
