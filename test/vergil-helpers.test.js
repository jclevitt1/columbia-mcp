import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// vergil.js imports playwright lazily inside getContext(), so importing the
// module here does not require a browser.
const { decodeEntities, termCode } = await import('../src/tools/vergil.js');

describe('vergil helpers', () => {
  describe('decodeEntities', () => {
    // The case that put "&amp;" on a real calendar for a whole semester.
    it('fixes the course title that leaked into a calendar event', () => {
      assert.equal(
        decodeEntities('ECBM4040 Neural Networks &amp; Deep Learning'),
        'ECBM4040 Neural Networks & Deep Learning',
      );
    });

    it('decodes the common named entities', () => {
      assert.equal(decodeEntities('a &lt; b &gt; c'), 'a < b > c');
      assert.equal(decodeEntities('&quot;quoted&quot;'), '"quoted"');
      assert.equal(decodeEntities('it&#39;s'), "it's");
      assert.equal(decodeEntities('it&apos;s'), "it's");
    });

    it('turns &nbsp; into a plain space', () => {
      assert.equal(decodeEntities('402&nbsp;Chandler'), '402 Chandler');
    });

    it('decodes numeric entities, decimal and hex', () => {
      assert.equal(decodeEntities('&#65;&#66;'), 'AB');
      assert.equal(decodeEntities('&#x41;&#x42;'), 'AB');
      assert.equal(decodeEntities('caf&#233;'), 'café');
    });

    // Decoding twice would be a different bug: the source is double-encoded by
    // exactly one layer, so we peel exactly one.
    it('peels only one layer', () => {
      assert.equal(decodeEntities('&amp;lt;'), '&lt;');
      assert.equal(decodeEntities('&amp;amp;'), '&amp;');
    });

    it('leaves ordinary text alone', () => {
      assert.equal(decodeEntities('Probability'), 'Probability');
      assert.equal(decodeEntities('R&D'), 'R&D');
      assert.equal(decodeEntities('100% & rising'), '100% & rising');
    });

    it('passes through non-strings untouched', () => {
      assert.equal(decodeEntities(null), null);
      assert.equal(decodeEntities(undefined), undefined);
      assert.equal(decodeEntities(42), 42);
    });

    it('ignores things that only look like entities', () => {
      assert.equal(decodeEntities('AT&T; call'), 'AT&T; call');
      assert.equal(decodeEntities('&notreal;'), '&notreal;');
    });
  });

  describe('termCode', () => {
    it('still maps a term name to its code', () => {
      assert.equal(typeof termCode('Fall 2026'), 'string');
    });
  });
});
