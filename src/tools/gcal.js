import { calendar } from './google-auth.js';

/**
 * Google Calendar, on the same OAuth consent as mail and Drive.
 *
 * Reads run directly. Creating or deleting an event is split into a "request"
 * half (an MCP tool that only queues) and an "apply" half registered as an
 * approvals executor — the same gate as mail, so nothing lands on the
 * calendar until Jeremy says yes from Telegram.
 */

export const TIMEZONE = () => process.env.CALENDAR_TIMEZONE || 'America/New_York';

/**
 * The calendar scope was added after the first consent, so an older refresh
 * token silently lacks it. Google reports that as a 403 with "insufficient"
 * in the message; translate it into the one action that fixes it.
 */
function explain(err) {
  const msg = String(err?.message || err);
  if (err?.code === 403 && /insufficient|scope/i.test(msg)) {
    return new Error(
      'Google token lacks the Calendar scope. Re-run `npm run gmail-auth` at the '
      + 'Mini to re-consent (it now includes Calendar), then retry.'
    );
  }
  if (err?.code === 403 && /not been used|is disabled|accessNotConfigured/i.test(msg)) {
    return new Error(
      'Google Calendar API is not enabled on the Cloud project. Enable it at '
      + 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com and retry.'
    );
  }
  return err;
}

const guard = (fn) => async (...args) => {
  try { return await fn(...args); } catch (err) { throw explain(err); }
};

/* ---------------- reads ---------------- */

export const listCalendars = guard(async () => {
  const { data } = await calendar().calendarList.list({ minAccessRole: 'reader' });
  return (data.items || []).map((c) => ({
    id: c.id,
    name: c.summaryOverride || c.summary,
    primary: Boolean(c.primary),
    access: c.accessRole,
    timeZone: c.timeZone,
  }));
});

function compact(ev) {
  const allDay = Boolean(ev.start?.date);
  return {
    id: ev.id,
    summary: ev.summary || '(no title)',
    start: ev.start?.dateTime || ev.start?.date,
    end: ev.end?.dateTime || ev.end?.date,
    allDay,
    location: ev.location || null,
    description: ev.description ? ev.description.slice(0, 500) : null,
    meet: ev.hangoutLink || null,
    status: ev.status,
    url: ev.htmlLink,
  };
}

/**
 * Events in a window. Defaults to the next 7 days on the primary calendar.
 * `singleEvents` expands recurring events so "what's on Tuesday" is answerable
 * without reasoning about RRULEs.
 */
export const listEvents = guard(async ({
  calendarId = 'primary', days = 7, timeMin = null, timeMax = null, query = null, limit = 50,
} = {}) => {
  const from = timeMin ? new Date(timeMin) : new Date();
  const to = timeMax ? new Date(timeMax) : new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  const { data } = await calendar().events.list({
    calendarId,
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: Math.min(limit, 250),
    q: query || undefined,
    timeZone: TIMEZONE(),
  });
  return {
    calendarId,
    from: from.toISOString(),
    to: to.toISOString(),
    timeZone: TIMEZONE(),
    count: (data.items || []).length,
    events: (data.items || []).map(compact),
  };
});

export const getEvent = guard(async ({ calendarId = 'primary', eventId }) => {
  const { data } = await calendar().events.get({ calendarId, eventId });
  return { ...compact(data), description: data.description || null, attendees: (data.attendees || []).map((a) => a.email) };
});

/* ---------------- writes: applied only after approval ---------------- */

/** Build the API body from the flat shape the model gives us. */
function eventBody({ summary, start, end, allDay = false, description, location }) {
  const tz = TIMEZONE();
  const when = allDay
    ? { start: { date: start.slice(0, 10) }, end: { date: (end || start).slice(0, 10) } }
    : { start: { dateTime: start, timeZone: tz }, end: { dateTime: end, timeZone: tz } };
  return { summary, description, location, ...when };
}

export const applyCreateEvent = guard(async ({ calendarId = 'primary', ...fields }) => {
  const { data } = await calendar().events.insert({ calendarId, requestBody: eventBody(fields) });
  return compact(data);
});

export const applyDeleteEvent = guard(async ({ calendarId = 'primary', eventId }) => {
  await calendar().events.delete({ calendarId, eventId });
  return { calendarId, eventId, deleted: true };
});
