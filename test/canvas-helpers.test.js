import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Canvas helpers are not exported, so we replicate them here exactly as they
 * appear in src/tools/canvas.js to validate the logic. If the source changes,
 * these tests should be updated to match.
 */

// --- parseNextLink (from canvas.js:72-79) ---

function parseNextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

// --- stripHtml (from canvas.js:247-261) ---

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- shaping helpers (from canvas.js:86-101) ---

const course = (c) => ({
  id: c.id,
  name: c.name,
  code: c.course_code,
  term: c.term?.name ?? null,
});

const assignment = (a) => ({
  id: a.id,
  courseId: a.course_id,
  name: a.name,
  dueAt: a.due_at,
  pointsPossible: a.points_possible,
  submitted: Boolean(a.has_submitted_submissions ?? a.submission?.submitted_at),
  url: a.html_url,
});

describe('canvas helpers', () => {
  describe('parseNextLink', () => {
    it('extracts the next URL from a Link header', () => {
      const header =
        '<https://courseworks2.columbia.edu/api/v1/courses?page=2>; rel="next", '
        + '<https://courseworks2.columbia.edu/api/v1/courses?page=5>; rel="last"';
      assert.equal(
        parseNextLink(header),
        'https://courseworks2.columbia.edu/api/v1/courses?page=2'
      );
    });

    it('returns null when there is no next link', () => {
      const header = '<https://example.com/api?page=1>; rel="current"';
      assert.equal(parseNextLink(header), null);
    });

    it('returns null for null/empty header', () => {
      assert.equal(parseNextLink(null), null);
      assert.equal(parseNextLink(''), null);
    });
  });

  describe('stripHtml', () => {
    it('strips tags and decodes entities', () => {
      const html = '<p>Hello &amp; <b>world</b></p><p>&lt;script&gt;</p>';
      const result = stripHtml(html);
      assert.equal(result, 'Hello & world\n\n<script>');
    });

    it('converts <br> to newlines', () => {
      assert.equal(stripHtml('line1<br>line2<br/>line3'), 'line1\nline2\nline3');
    });

    it('collapses excessive newlines', () => {
      assert.equal(stripHtml('<p>a</p><p></p><p></p><p>b</p>'), 'a\n\nb');
    });

    it('returns empty string for falsy input', () => {
      assert.equal(stripHtml(''), '');
      assert.equal(stripHtml(null), '');
      assert.equal(stripHtml(undefined), '');
    });

    it('decodes common entities', () => {
      assert.equal(stripHtml('&nbsp;&quot;hi&#39;&quot;'), '"hi\'"');
    });
  });

  describe('course shaper', () => {
    it('extracts the fields the model needs', () => {
      const raw = {
        id: 12345,
        name: 'Statistical Inference',
        course_code: 'STAT GR5203',
        term: { name: 'Fall 2026' },
        extra_field: 'ignored',
      };
      assert.deepStrictEqual(course(raw), {
        id: 12345,
        name: 'Statistical Inference',
        code: 'STAT GR5203',
        term: 'Fall 2026',
      });
    });

    it('handles missing term', () => {
      const raw = { id: 1, name: 'Test', course_code: 'T101' };
      assert.equal(course(raw).term, null);
    });
  });

  describe('assignment shaper', () => {
    it('extracts the fields the model needs', () => {
      const raw = {
        id: 999,
        course_id: 12345,
        name: 'HW 3',
        due_at: '2026-09-15T23:59:00Z',
        points_possible: 100,
        has_submitted_submissions: true,
        html_url: 'https://courseworks2.columbia.edu/courses/12345/assignments/999',
      };
      assert.deepStrictEqual(assignment(raw), {
        id: 999,
        courseId: 12345,
        name: 'HW 3',
        dueAt: '2026-09-15T23:59:00Z',
        pointsPossible: 100,
        submitted: true,
        url: 'https://courseworks2.columbia.edu/courses/12345/assignments/999',
      });
    });

    it('falls back to submission.submitted_at for submitted flag', () => {
      const raw = {
        id: 1, course_id: 2, name: 'HW', due_at: null,
        points_possible: 10, html_url: '',
        submission: { submitted_at: '2026-09-01T00:00:00Z' },
      };
      assert.equal(assignment(raw).submitted, true);
    });

    it('marks unsubmitted assignments correctly', () => {
      const raw = {
        id: 1, course_id: 2, name: 'HW', due_at: null,
        points_possible: 10, html_url: '',
        has_submitted_submissions: false,
      };
      assert.equal(assignment(raw).submitted, false);
    });
  });
});
