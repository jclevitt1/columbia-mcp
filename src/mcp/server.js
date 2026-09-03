#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { ensureHome, loadEnv } from '../config.js';
import * as approvals from '../approvals.js';
import * as canvas from '../tools/canvas.js';
import * as vergil from '../tools/vergil.js';
import * as mail from '../tools/gmail.js';
import * as gdocs from '../tools/gdocs.js';
import * as gcal from '../tools/gcal.js';
import { registerAll as registerExecutors } from '../executors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv(ROOT);
ensureHome();

/* Anything that leaves the machine runs only after the bridge has flipped the
 * action to 'approved' in response to Jeremy's reply. The executors live in
 * one module shared with the bridge — see src/executors.js for why. */
registerExecutors();

const server = new McpServer(
  { name: 'columbia-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

/** Tool handlers all return text; wrap results and surface errors legibly. */
function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      const result = await handler(args ?? {});
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${name} failed: ${err.message}` }],
      };
    }
  });
}

/**
 * Every write-class tool funnels through here: enqueue, report back, execute
 * nothing. The uniform return shape means the model always learns the same
 * thing — that it has asked, not acted.
 */
function queue({ kind, summary, detail, payload }) {
  const action = approvals.enqueue({ kind, summary, detail, payload });
  return {
    queued: true,
    approvalId: action.id,
    message: `Pending approval ${action.id}. Jeremy must confirm over Telegram; nothing has happened yet.`,
  };
}

/* ---------------- CourseWorks (Canvas) — read only ---------------- */

tool('canvas_courses', {
  title: 'List CourseWorks courses',
  description: 'List Jeremy\'s Canvas/CourseWorks courses. Start here to get course IDs for the other canvas_* tools.',
  inputSchema: { includeConcluded: z.boolean().optional().describe('Include finished terms') },
}, ({ includeConcluded }) => canvas.listCourses({ includeConcluded }));

tool('canvas_assignments', {
  title: 'List assignments for a course',
  description: 'Assignments for one course, optionally filtered by bucket (upcoming, overdue, unsubmitted, past).',
  inputSchema: {
    courseId: z.union([z.string(), z.number()]).describe('Canvas course id from canvas_courses'),
    bucket: z.enum(['past', 'overdue', 'undated', 'ungraded', 'unsubmitted', 'upcoming', 'future']).optional(),
  },
}, ({ courseId, bucket }) => canvas.listAssignments({ courseId, bucket }));

tool('canvas_upcoming', {
  title: 'Upcoming calendar events',
  description: 'Canvas\'s own upcoming-events feed across all courses. Cheapest way to answer "what is due soon".',
  inputSchema: {},
}, () => canvas.upcoming());

tool('canvas_todo', {
  title: 'CourseWorks to-do list',
  description: 'The dashboard to-do feed: unsubmitted assignments and items needing attention.',
  inputSchema: {},
}, () => canvas.todo());

tool('canvas_announcements', {
  title: 'Recent course announcements',
  description: 'Recent announcements across the given courses, with HTML stripped.',
  inputSchema: {
    courseIds: z.array(z.union([z.string(), z.number()])).describe('Course ids from canvas_courses'),
    days: z.number().optional().describe('How far back to look (default 14)'),
  },
}, ({ courseIds, days }) => canvas.announcements({ courseIds, days }));

tool('canvas_grades', {
  title: 'Current grades',
  description: 'Current computed score and grade per active course.',
  inputSchema: {},
}, () => canvas.grades());

tool('canvas_syllabus', {
  title: 'Course syllabus',
  description: 'The Syllabus page for a course, plus any files it links to. Columbia instructors usually attach a PDF rather than typing the syllabus in, so check `attachments` and follow up with canvas_file_download.',
  inputSchema: { courseId: z.union([z.string(), z.number()]) },
}, ({ courseId }) => canvas.syllabus({ courseId }));

tool('canvas_files', {
  title: 'List course files',
  description: 'Files uploaded to a course, newest first. Optionally filter by name.',
  inputSchema: {
    courseId: z.union([z.string(), z.number()]),
    query: z.string().optional().describe('Filter by filename, e.g. "syllabus"'),
    limit: z.number().optional(),
  },
}, ({ courseId, query, limit }) => canvas.listFiles({ courseId, query, limit }));

tool('canvas_file_download', {
  title: 'Download a course file',
  description: 'Download a course file to local disk and return its path, so it can be opened with a file reader. Handles PDFs, slides and problem sets.',
  inputSchema: {
    courseId: z.union([z.string(), z.number()]),
    fileId: z.union([z.string(), z.number()]),
    destDir: z.string().optional(),
  },
}, ({ courseId, fileId, destDir }) => canvas.downloadFile({ courseId, fileId, destDir }));

/* ---------------- Vergil / Directory of Classes ---------------- */

tool('vergil_search', {
  title: 'Search the course catalog',
  description: 'Search Vergil for courses. Runs through the persistent logged-in browser profile because columbia.edu sits behind a Cloudflare challenge that plain HTTP cannot pass.',
  inputSchema: {
    query: z.string().describe('e.g. "STAT GR5203" or "statistical inference"'),
    term: z.string().optional().describe('e.g. "Fall 2026"'),
  },
}, ({ query, term }) => vergil.searchCourses({ query, term }));

tool('vergil_browse', {
  title: 'Open a Columbia page in the logged-in browser',
  description: 'Navigate to any columbia.edu URL using the authenticated browser profile and return the page text and links. Use for pages vergil_search does not cover (SSOL, bulletin, department sites).',
  inputSchema: {
    url: z.string().describe('Full https:// URL under columbia.edu'),
    waitFor: z.string().optional().describe('Optional CSS selector to wait for'),
  },
}, async ({ url, waitFor }) => {
  if (!/^https:\/\/[a-z0-9.-]*columbia\.edu(\/|$)/i.test(url)) {
    throw new Error('vergil_browse only opens columbia.edu URLs.');
  }
  return vergil.browse(url, { waitFor });
});

tool('vergil_session_status', {
  title: 'Check browser login state',
  description: 'Whether the persistent browser profile exists yet. If false, Jeremy must run `npm run vergil-login` on the Mini once to sign in through CAS/Duo by hand.',
  inputSchema: {},
}, () => ({
  profileExists: vergil.profileExists(),
  note: vergil.profileExists()
    ? 'Profile present. CAS may still have expired; a browse returning needsLogin means re-run npm run vergil-login.'
    : 'No profile yet. Run `npm run vergil-login` on the Mac Mini.',
}));

/* ---------------- Mail ---------------- */

tool('mail_search', {
  title: 'Search Columbia mail',
  description: 'Search recent Columbia mail. Read-only.',
  inputSchema: {
    query: z.string().optional().describe('Sender or subject substring (apple_mail) or Gmail query syntax (gmail_api)'),
    limit: z.number().optional().describe('Max messages (default 15)'),
  },
}, ({ query, limit }) => mail.searchMessages({ query, limit }));

tool('mail_read', {
  title: 'Read one message',
  description: 'Full body of a single message by id from mail_search.',
  inputSchema: { id: z.union([z.string(), z.number()]) },
}, ({ id }) => mail.readMessage(id));

tool('mail_draft', {
  title: 'Save a draft (does not send)',
  description: 'Write a draft into the mail client. Nothing is sent. Safe to call freely — use mail_request_send afterwards to ask Jeremy to approve sending it.',
  inputSchema: {
    to: z.string().describe('Recipient email address'),
    subject: z.string(),
    body: z.string(),
  },
}, ({ to, subject, body }) => mail.createDraft({ to, subject, body }));

tool('mail_request_send', {
  title: 'Ask Jeremy to approve sending a draft',
  description: 'Queues a send for Jeremy to approve over Telegram. This tool CANNOT send mail — it only creates a pending request. Jeremy must reply with the confirm word before anything leaves the machine.',
  inputSchema: {
    draftId: z.union([z.string(), z.number()]),
    to: z.string(),
    subject: z.string(),
    preview: z.string().optional().describe('First few lines of the body, so Jeremy can approve from his phone'),
  },
}, ({ draftId, to, subject, preview }) => queue({
  kind: 'gmail.send',
  summary: `Send mail to ${to} — "${subject}"`,
  detail: preview || '',
  payload: { draftId },
}));


/* ---------------- Drive / Docs / Sheets ---------------- */

tool('drive_search', {
  title: 'Find files in Drive',
  description: 'Search Drive by name or full text. Filter to docs or sheets to avoid drowning in PDFs. Returns ids for docs_read / sheets_read.',
  inputSchema: {
    query: z.string().describe('Name or content to search for'),
    type: z.enum(['doc', 'sheet', 'folder']).optional().describe('Narrow by file type'),
    limit: z.number().optional(),
  },
}, ({ query, type, limit }) => gdocs.searchFiles({ query, type, limit }));

tool('docs_read', {
  title: 'Read a Google Doc',
  description: 'Full text of a Google Doc, with tables flattened to tab-separated lines.',
  inputSchema: { documentId: z.string().describe('Doc id from drive_search or the /d/<id>/ in its URL') },
}, ({ documentId }) => gdocs.readDoc({ documentId }));

tool('sheets_read', {
  title: 'Read a Google Sheet',
  description: 'Without a range, lists the tabs and their sizes. With a range like "Sheet1!A1:F50", returns the values.',
  inputSchema: {
    spreadsheetId: z.string(),
    range: z.string().optional().describe('A1 notation, e.g. "Sheet1!A1:F50"'),
  },
}, ({ spreadsheetId, range }) => gdocs.readSheet({ spreadsheetId, range }));

/* Writes below only ever queue. Same gate as mail — see approvals.js. */

tool('docs_request_append', {
  title: 'Ask Jeremy to approve appending to a Doc',
  description: 'Queues an append for approval. This tool CANNOT edit the document — it only creates a pending request Jeremy confirms over Telegram.',
  inputSchema: {
    documentId: z.string(),
    text: z.string().describe('Text to append at the end of the document'),
    title: z.string().optional().describe('Doc title, for the approval message'),
  },
}, ({ documentId, text, title }) => queue({
  kind: 'docs.append',
  summary: `Append ${text.length} chars to doc ${title || documentId}`,
  detail: text.slice(0, 500),
  payload: { documentId, text },
}));

tool('docs_request_create', {
  title: 'Ask Jeremy to approve creating a Doc',
  description: 'Queues creation of a new Google Doc for approval. Nothing is created until he confirms.',
  inputSchema: { title: z.string(), text: z.string().optional() },
}, ({ title, text }) => queue({
  kind: 'docs.create',
  summary: `Create doc "${title}"`,
  detail: (text || '').slice(0, 500),
  payload: { title, text },
}));

tool('sheets_request_append', {
  title: 'Ask Jeremy to approve appending rows',
  description: 'Queues an append of rows to a sheet. Nothing is written until he confirms.',
  inputSchema: {
    spreadsheetId: z.string(),
    range: z.string().describe('Target range, e.g. "Sheet1!A:D"'),
    values: z.array(z.array(z.union([z.string(), z.number()]))).describe('Rows to append'),
  },
}, ({ spreadsheetId, range, values }) => queue({
  kind: 'sheets.append',
  summary: `Append ${values.length} row(s) to ${range} in sheet ${spreadsheetId}`,
  detail: values.slice(0, 5).map((r) => r.join(' | ')).join('\n'),
  payload: { spreadsheetId, range, values },
}));

tool('sheets_request_update', {
  title: 'Ask Jeremy to approve overwriting a range',
  description: 'Queues an overwrite of a sheet range. Destructive, so it always waits for confirmation.',
  inputSchema: {
    spreadsheetId: z.string(),
    range: z.string(),
    values: z.array(z.array(z.union([z.string(), z.number()]))),
  },
}, ({ spreadsheetId, range, values }) => queue({
  kind: 'sheets.update',
  summary: `OVERWRITE ${range} in sheet ${spreadsheetId} with ${values.length} row(s)`,
  detail: values.slice(0, 5).map((r) => r.join(' | ')).join('\n'),
  payload: { spreadsheetId, range, values },
}));

/* ---------------- Calendar ---------------- */

tool('calendar_list', {
  title: 'List calendars',
  description: 'The calendars on Jeremy\'s Google account, with ids for calendar_events. "primary" always works as an id without calling this.',
  inputSchema: {},
}, () => gcal.listCalendars());

tool('calendar_events', {
  title: 'Events in a date range',
  description: 'Events on a calendar, defaulting to the next 7 days on the primary calendar. Recurring events are expanded. Times are in CALENDAR_TIMEZONE (America/New_York unless overridden).',
  inputSchema: {
    calendarId: z.string().optional().describe('Calendar id from calendar_list (default "primary")'),
    days: z.number().optional().describe('Window length from timeMin/now (default 7)'),
    timeMin: z.string().optional().describe('ISO 8601 start, e.g. "2026-09-08T00:00:00-04:00" (default now)'),
    timeMax: z.string().optional().describe('ISO 8601 end (default timeMin + days)'),
    query: z.string().optional().describe('Free-text filter on title/description/location'),
    limit: z.number().optional(),
  },
}, (args) => gcal.listEvents(args));

tool('calendar_event', {
  title: 'Read one event',
  description: 'Full detail for a single event, including attendees.',
  inputSchema: {
    eventId: z.string(),
    calendarId: z.string().optional(),
  },
}, ({ eventId, calendarId }) => gcal.getEvent({ eventId, calendarId }));

/* Writes below only ever queue. Same gate as mail — see approvals.js. */

tool('calendar_request_create', {
  title: 'Ask Jeremy to approve adding an event',
  description: 'Queues a new calendar event for approval. This tool CANNOT create the event — Jeremy confirms over Telegram first. Give start/end as ISO 8601 with offset, or set allDay with YYYY-MM-DD dates.',
  inputSchema: {
    summary: z.string().describe('Event title'),
    start: z.string().describe('ISO 8601 datetime, or YYYY-MM-DD when allDay'),
    end: z.string().optional().describe('ISO 8601 datetime; for allDay the exclusive end date (defaults to start)'),
    allDay: z.boolean().optional(),
    location: z.string().optional(),
    description: z.string().optional(),
    calendarId: z.string().optional().describe('Default "primary"'),
  },
}, ({ summary, start, end, allDay, location, description, calendarId }) => queue({
  kind: 'calendar.create',
  summary: `Add "${summary}" ${allDay ? `on ${start}` : `at ${start}`}${location ? ` @ ${location}` : ''}`,
  detail: [end && !allDay ? `until ${end}` : '', description || ''].filter(Boolean).join('\n').slice(0, 500),
  payload: { summary, start, end: end || (allDay ? start : undefined), allDay: Boolean(allDay), location, description, calendarId: calendarId || 'primary' },
}));

tool('calendar_request_delete', {
  title: 'Ask Jeremy to approve deleting an event',
  description: 'Queues deletion of an event for approval. Nothing is removed until he confirms. Pass the event title so the approval message is readable on a phone.',
  inputSchema: {
    eventId: z.string(),
    summary: z.string().describe('Event title, from calendar_events'),
    calendarId: z.string().optional(),
  },
}, ({ eventId, summary, calendarId }) => queue({
  kind: 'calendar.delete',
  summary: `DELETE event "${summary}"`,
  detail: eventId,
  payload: { eventId, calendarId: calendarId || 'primary' },
}));

/* ---------------- Approvals (read-only from the model's side) ---------------- */

tool('approvals_list', {
  title: 'List pending approvals',
  description: 'Show actions awaiting Jeremy\'s check-off. Read-only: there is deliberately no tool that approves an action — only Jeremy can, from Telegram.',
  inputSchema: { status: z.enum(['pending', 'approved', 'done', 'rejected', 'failed']).optional() },
}, ({ status }) => approvals.list(status).map((a) => ({
  id: a.id,
  kind: a.kind,
  summary: a.summary,
  status: a.status,
  createdAt: new Date(a.createdAt).toISOString(),
})));

const transport = new StdioServerTransport();
await server.connect(transport);
