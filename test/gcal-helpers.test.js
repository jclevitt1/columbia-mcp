import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * eventBody helper replicated from src/tools/gcal.js for unit testing.
 */

const TIMEZONE = () => process.env.CALENDAR_TIMEZONE || 'America/New_York';

function eventBody({ summary, start, end, allDay = false, description, location, recurrence }) {
  const tz = TIMEZONE();
  const when = allDay
    ? { start: { date: start.slice(0, 10) }, end: { date: (end || start).slice(0, 10) } }
    : { start: { dateTime: start, timeZone: tz }, end: { dateTime: end, timeZone: tz } };
  const repeat = recurrence?.length ? { recurrence } : {};
  return { summary, description, location, ...when, ...repeat };
}

describe('eventBody', () => {
  it('sends a timed event with the configured zone', () => {
    const body = eventBody({
      summary: 'Advisor meeting',
      start: '2026-09-11T16:00:00-04:00',
      end: '2026-09-11T17:00:00-04:00',
    });
    assert.equal(body.start.dateTime, '2026-09-11T16:00:00-04:00');
    assert.equal(body.start.timeZone, 'America/New_York');
    assert.equal(body.end.timeZone, 'America/New_York');
  });

  it('reduces an all-day event to bare dates', () => {
    const body = eventBody({ summary: 'Reading day', start: '2026-12-15', allDay: true });
    assert.deepEqual(body.start, { date: '2026-12-15' });
    assert.deepEqual(body.end, { date: '2026-12-15' });
    assert.ok(!('dateTime' in body.start));
  });

  it('omits recurrence entirely when there is none', () => {
    const body = eventBody({ summary: 'One-off', start: '2026-09-11T16:00:00-04:00', end: '2026-09-11T17:00:00-04:00' });
    assert.ok(!('recurrence' in body), 'an absent RRULE must not become recurrence: []');
  });

  it('omits recurrence when given an empty array', () => {
    const body = eventBody({
      summary: 'One-off',
      start: '2026-09-11T16:00:00-04:00',
      end: '2026-09-11T17:00:00-04:00',
      recurrence: [],
    });
    assert.ok(!('recurrence' in body));
  });

  it('passes RRULE and EXDATE lines through verbatim', () => {
    const recurrence = [
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261214T235959Z',
      'EXDATE;TZID=America/New_York:20261125T131000',
    ];
    const body = eventBody({
      summary: 'STAT GR5264 Stochastic Processes',
      start: '2026-09-09T13:10:00-04:00',
      end: '2026-09-09T14:25:00-04:00',
      location: '402 Chandler',
      recurrence,
    });
    assert.deepEqual(body.recurrence, recurrence);
    // The whole semester stays one event, and therefore one approval.
    assert.equal(body.start.dateTime, '2026-09-09T13:10:00-04:00');
  });
});
