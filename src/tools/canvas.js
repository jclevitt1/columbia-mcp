import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, PATHS } from '../config.js';

/**
 * CourseWorks (Canvas LMS) read client.
 *
 * Canvas is the easy half of this project: plain REST, Bearer token, and —
 * unlike the rest of columbia.edu — no Cloudflare bot challenge in front of
 * it. Verified: GET /api/v1/users/self/profile returns
 * `401 WWW-Authenticate: Bearer realm="canvas-lms"` unauthenticated.
 *
 * Everything here is read-only by design. Submitting work is a write action
 * and belongs behind the approvals gate, not in this module.
 */

class CanvasError extends Error {}

function requireToken() {
  if (!CONFIG.canvasToken) {
    throw new CanvasError(
      'CANVAS_ACCESS_TOKEN is not set. Generate one at '
      + `${CONFIG.canvasBase}/profile/settings -> "+ New Access Token", `
      + 'then put it in .env. If that button is missing, Columbia has disabled '
      + 'self-service tokens and Canvas has to move to the Playwright path too.'
    );
  }
}

/**
 * GET a Canvas endpoint, following RFC 5988 `Link: rel="next"` pagination.
 * Canvas paginates almost everything at 10 items by default, which silently
 * truncates results if you ignore it.
 */
async function canvasGet(endpoint, { params = {}, maxPages = 10 } = {}) {
  requireToken();
  const url = new URL(endpoint.replace(/^\//, ''), `${CONFIG.canvasBase}/api/v1/`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(`${k}[]`, item));
    else url.searchParams.set(k, String(v));
  }
  if (!url.searchParams.has('per_page')) url.searchParams.set('per_page', '100');

  const out = [];
  let next = url.toString();
  let pages = 0;

  while (next && pages < maxPages) {
    const res = await fetch(next, {
      headers: {
        Authorization: `Bearer ${CONFIG.canvasToken}`,
        Accept: 'application/json',
      },
    });
    if (res.status === 401) {
      throw new CanvasError('Canvas rejected the token (401). It may be expired or revoked.');
    }
    if (!res.ok) {
      throw new CanvasError(`Canvas ${res.status} on ${next}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json();
    if (Array.isArray(body)) out.push(...body);
    else return body; // single object endpoint — no pagination to do

    next = parseNextLink(res.headers.get('link'));
    pages += 1;
  }
  return out;
}

function parseNextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/* ---------- shaping helpers ----------
 * Canvas objects are enormous. Trim to what is actually useful in a text
 * message, or the model burns its context on submission_types metadata.
 */

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

/* ---------- public surface ---------- */

export async function listCourses({ includeConcluded = false } = {}) {
  const raw = await canvasGet('courses', {
    params: {
      enrollment_state: includeConcluded ? undefined : 'active',
      include: ['term'],
    },
  });
  return raw.filter((c) => c && !c.access_restricted_by_date).map(course);
}

export async function listAssignments({ courseId, bucket }) {
  const raw = await canvasGet(`courses/${courseId}/assignments`, {
    params: { bucket, include: ['submission'], order_by: 'due_at' },
  });
  return raw.map(assignment);
}

/** Canvas's own "what's coming up" feed — cheaper than walking every course. */
export async function upcoming() {
  const events = await canvasGet('users/self/upcoming_events');
  return events.map((e) => ({
    title: e.title,
    type: e.type,
    startAt: e.start_at ?? e.assignment?.due_at ?? null,
    courseId: e.course_id ?? e.assignment?.course_id ?? null,
    url: e.html_url,
  }));
}

/** The to-do list Canvas shows on the dashboard: ungraded/unsubmitted work. */
export async function todo() {
  const items = await canvasGet('users/self/todo');
  return items.map((t) => ({
    type: t.type,
    courseId: t.course_id,
    name: t.assignment?.name ?? t.title ?? null,
    dueAt: t.assignment?.due_at ?? null,
    needsGrading: t.needs_grading_count ?? null,
    url: t.html_url,
  }));
}

export async function announcements({ courseIds, days = 14 }) {
  const start = new Date(Date.now() - days * 86400000).toISOString();
  const raw = await canvasGet('announcements', {
    params: {
      context_codes: courseIds.map((id) => `course_${id}`),
      start_date: start,
      active_only: true,
    },
  });
  return raw.map((a) => ({
    id: a.id,
    title: a.title,
    postedAt: a.posted_at,
    author: a.user_name ?? a.author?.display_name ?? null,
    contextCode: a.context_code,
    message: stripHtml(a.message).slice(0, 1500),
    url: a.html_url,
  }));
}

export async function grades() {
  const raw = await canvasGet('courses', {
    params: { enrollment_state: 'active', include: ['total_scores'] },
  });
  return raw
    .filter((c) => c && !c.access_restricted_by_date)
    .map((c) => {
      const e = (c.enrollments || []).find((x) => x.type === 'student') || {};
      return {
        course: c.name,
        courseId: c.id,
        currentScore: e.computed_current_score ?? null,
        currentGrade: e.computed_current_grade ?? null,
      };
    });
}

/**
 * The Syllabus page. Columbia instructors overwhelmingly use it as a stub
 * pointing at an uploaded PDF, so return the linked files as well as the
 * body text — otherwise the answer is usually "See attached file:".
 */
export async function syllabus({ courseId }) {
  const c = await canvasGet(`courses/${courseId}`, { params: { include: ['syllabus_body'] } });
  const html = c.syllabus_body || '';
  const attachments = [];
  const re = /data-api-endpoint="([^"]*\/files\/(\d+))"[^>]*/g;
  for (const m of html.matchAll(/<a[^>]+>/g)) {
    const tag = m[0];
    const id = tag.match(/\/files\/(\d+)/);
    const title = tag.match(/title="([^"]+)"/);
    if (id) attachments.push({ fileId: Number(id[1]), name: title ? title[1] : null });
  }
  return {
    courseId,
    course: c.name,
    text: stripHtml(html),
    attachments,
    url: `${CONFIG.canvasBase}/courses/${courseId}/assignments/syllabus`,
  };
}

/** Course files, optionally filtered by name. */
export async function listFiles({ courseId, query = null, limit = 100 }) {
  const raw = await canvasGet(`courses/${courseId}/files`, {
    params: { search_term: query || undefined, sort: 'created_at', order: 'desc' },
  });
  return raw.slice(0, limit).map((f) => ({
    fileId: f.id,
    name: f.display_name,
    contentType: f['content-type'],
    size: f.size,
    updated: f.updated_at,
  }));
}

/**
 * Download a course file to disk and return the path.
 *
 * Deliberately does not try to parse PDFs — the calling agent already has a
 * file reader that handles them properly, and reimplementing PDF extraction
 * here would be strictly worse.
 */
export async function downloadFile({ courseId, fileId, destDir }) {
  const meta = await canvasGet(`courses/${courseId}/files/${fileId}`);
  const res = await fetch(meta.url); // pre-signed; no auth header needed
  if (!res.ok) throw new CanvasError(`download failed: HTTP ${res.status}`);

  const dir = destDir || path.join(PATHS.home, 'downloads', String(courseId));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, meta.display_name.replace(/[/\\]/g, '_'));
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));

  return { path: dest, name: meta.display_name, contentType: meta['content-type'], size: meta.size };
}

export async function whoami() {
  return canvasGet('users/self/profile');
}

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
