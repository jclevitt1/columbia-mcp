import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COLUMBIA_MCP_HOME = '/tmp/authcheck-test-home';

const auth = await import('../src/authcheck.js');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);

/** Chromium microseconds-since-1601 for a given unix ms. */
const chromeTime = (ms) => (ms / 1000 + auth.CHROME_EPOCH_OFFSET_SEC) * 1_000_000;

describe('authcheck', () => {
  describe('chromeTimeToMs', () => {
    it('round-trips a known instant', () => {
      assert.equal(Math.round(auth.chromeTimeToMs(chromeTime(NOW))), NOW);
    });
    it('returns null for absent or zero timestamps', () => {
      assert.equal(auth.chromeTimeToMs(0), null);
      assert.equal(auth.chromeTimeToMs(undefined), null);
    });
  });

  describe('humanDuration', () => {
    it('picks the unit that reads best', () => {
      assert.equal(auth.humanDuration(3 * DAY), '3.0 days');
      assert.equal(auth.humanDuration(5 * 3_600_000), '5.0 hours');
      assert.equal(auth.humanDuration(12 * 60_000), '12 minutes');
    });
  });

  describe('classifyGoogle', () => {
    it('reports a fresh token as ok with lifetime unobserved', () => {
      const v = auth.classifyGoogle({ firstOkAt: NOW - DAY }, { ok: true }, NOW);
      assert.equal(v.status, 'ok');
      assert.match(v.detail, /not yet observed/);
    });

    it('warns as the 7-day Testing cliff approaches', () => {
      const v = auth.classifyGoogle({ firstOkAt: NOW - 5.5 * DAY }, { ok: true }, NOW);
      assert.equal(v.status, 'warn');
      assert.match(v.detail, /still in Testing/);
    });

    // The whole point of the empirical approach: surviving the cliff is proof.
    it('concludes production once a token outlives the cliff', () => {
      const v = auth.classifyGoogle({ firstOkAt: NOW - 9 * DAY }, { ok: true }, NOW);
      assert.equal(v.status, 'ok');
      assert.equal(v.mode, 'production');
      assert.match(v.detail, /published/);
    });

    it('does not re-warn a token already known to be published', () => {
      const v = auth.classifyGoogle(
        { firstOkAt: NOW - 6 * DAY, publishingMode: 'production' }, { ok: true }, NOW,
      );
      assert.equal(v.status, 'ok');
    });

    it('fails on invalid_grant and reports the age reached', () => {
      const v = auth.classifyGoogle({ firstOkAt: NOW - 7 * DAY }, { ok: false, invalidGrant: true }, NOW);
      assert.equal(v.status, 'fail');
      assert.match(v.detail, /7\.0 days/);
      assert.match(v.detail, /gmail-auth/);
    });

    // A network blip must not masquerade as an expired credential.
    it('stays unknown when Google is unreachable', () => {
      const v = auth.classifyGoogle({ firstOkAt: NOW - DAY }, { ok: false, invalidGrant: false }, NOW);
      assert.equal(v.status, 'unknown');
    });
  });

  describe('classifyClearance', () => {
    const cf = (ms) => [{ name: 'cf_clearance', host_key: '.columbia.edu', has_expires: 1, expires_utc: chromeTime(ms) }];

    it('is ok when far from expiry', () => {
      assert.equal(auth.classifyClearance(cf(NOW + 300 * DAY), NOW).status, 'ok');
    });
    it('warns inside the warning window', () => {
      assert.equal(auth.classifyClearance(cf(NOW + 5 * DAY), NOW).status, 'warn');
    });
    it('fails once expired', () => {
      assert.equal(auth.classifyClearance(cf(NOW - DAY), NOW).status, 'fail');
    });
    it('fails when the cookie is absent entirely', () => {
      const v = auth.classifyClearance([], NOW);
      assert.equal(v.status, 'fail');
      assert.match(v.detail, /vergil-login/);
    });
    it('is unknown when the database could not be read', () => {
      assert.equal(auth.classifyClearance(null, NOW).status, 'unknown');
    });
  });

  describe('classifyCasSession', () => {
    const session = [{ name: 'PF', host_key: 'oauth.cc.columbia.edu', has_expires: 0, creation_utc: chromeTime(NOW - 3 * 3_600_000) }];

    // Absence is definitive; presence never is. This asymmetry is the point.
    it('fails when no session cookies exist', () => {
      const v = auth.classifyCasSession([], NOW);
      assert.equal(v.status, 'fail');
      assert.match(v.detail, /nobody has logged in/);
    });

    it('refuses to claim ok even when cookies are present', () => {
      const v = auth.classifyCasSession(session, NOW);
      assert.equal(v.status, 'unknown');
      assert.match(v.detail, /unverified/);
      assert.match(v.detail, /3\.0 hours ago/);
    });
  });

  describe('rollup', () => {
    const c = (status) => ({ name: 'x', status, detail: '' });

    it('takes the worst status', () => {
      assert.equal(auth.worst([c('ok'), c('warn'), c('fail')]), 'fail');
      assert.equal(auth.worst([c('ok'), c('unknown')]), 'unknown');
      assert.equal(auth.worst([c('ok'), c('ok')]), 'ok');
    });

    // `unknown` means "could not determine", which is not worth waking someone.
    it('alerts on fail and warn but never on unknown', () => {
      const p = auth.problems([c('ok'), c('unknown'), c('warn'), c('fail')]);
      assert.deepEqual(p.map((x) => x.status), ['warn', 'fail']);
    });
  });

  describe('fingerprint', () => {
    it('is stable and does not leak the secret', () => {
      const fp = auth.fingerprint('super-secret-token');
      assert.equal(fp, auth.fingerprint('super-secret-token'));
      assert.equal(fp.length, 16);
      assert.ok(!fp.includes('secret'));
    });
    it('differs across tokens, so rotation is detectable', () => {
      assert.notEqual(auth.fingerprint('a'), auth.fingerprint('b'));
    });
    it('returns null when there is no token', () => {
      assert.equal(auth.fingerprint(undefined), null);
    });
  });
});
