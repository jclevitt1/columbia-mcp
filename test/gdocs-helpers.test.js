import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * docText helper replicated from src/tools/gdocs.js for unit testing.
 */

function docText(body) {
  const out = [];
  const walk = (elements = []) => {
    for (const el of elements) {
      if (el.paragraph) {
        const line = (el.paragraph.elements || [])
          .map((e) => e.textRun?.content ?? '')
          .join('');
        out.push(line.replace(/\n$/, ''));
      } else if (el.table) {
        for (const row of el.table.tableRows || []) {
          const cells = (row.tableCells || []).map((c) => {
            const sub = [];
            for (const ce of c.content || []) {
              if (ce.paragraph) {
                sub.push((ce.paragraph.elements || []).map((e) => e.textRun?.content ?? '').join('').trim());
              }
            }
            return sub.join(' ');
          });
          out.push(cells.join('\t'));
        }
      } else if (el.tableOfContents) {
        walk(el.tableOfContents.content);
      }
    }
  };
  walk(body?.content);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

describe('gdocs docText', () => {
  it('extracts plain paragraphs', () => {
    const body = {
      content: [
        { paragraph: { elements: [{ textRun: { content: 'Hello world\n' } }] } },
        { paragraph: { elements: [{ textRun: { content: 'Second line\n' } }] } },
      ],
    };
    assert.equal(docText(body), 'Hello world\nSecond line');
  });

  it('joins multiple text runs in a paragraph', () => {
    const body = {
      content: [{
        paragraph: {
          elements: [
            { textRun: { content: 'Hello ' } },
            { textRun: { content: 'world' } },
          ],
        },
      }],
    };
    assert.equal(docText(body), 'Hello world');
  });

  it('flattens tables to tab-separated rows', () => {
    const body = {
      content: [{
        table: {
          tableRows: [
            {
              tableCells: [
                { content: [{ paragraph: { elements: [{ textRun: { content: 'Name\n' } }] } }] },
                { content: [{ paragraph: { elements: [{ textRun: { content: 'Grade\n' } }] } }] },
              ],
            },
            {
              tableCells: [
                { content: [{ paragraph: { elements: [{ textRun: { content: 'Alice\n' } }] } }] },
                { content: [{ paragraph: { elements: [{ textRun: { content: '95\n' } }] } }] },
              ],
            },
          ],
        },
      }],
    };
    assert.equal(docText(body), 'Name\tGrade\nAlice\t95');
  });

  it('handles table of contents by recursing', () => {
    const body = {
      content: [{
        tableOfContents: {
          content: [
            { paragraph: { elements: [{ textRun: { content: 'Chapter 1\n' } }] } },
            { paragraph: { elements: [{ textRun: { content: 'Chapter 2\n' } }] } },
          ],
        },
      }],
    };
    assert.equal(docText(body), 'Chapter 1\nChapter 2');
  });

  it('collapses excessive blank lines', () => {
    const body = {
      content: [
        { paragraph: { elements: [{ textRun: { content: 'Top\n' } }] } },
        { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
        { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
        { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
        { paragraph: { elements: [{ textRun: { content: 'Bottom\n' } }] } },
      ],
    };
    const result = docText(body);
    assert.ok(!result.includes('\n\n\n'), 'Should not have triple newlines');
    assert.ok(result.startsWith('Top'));
    assert.ok(result.endsWith('Bottom'));
  });

  it('returns empty string for null/undefined body', () => {
    assert.equal(docText(null), '');
    assert.equal(docText(undefined), '');
    assert.equal(docText({}), '');
  });

  it('handles elements with no textRun', () => {
    const body = {
      content: [
        { paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'img1' } }] } },
        { paragraph: { elements: [{ textRun: { content: 'After image\n' } }] } },
      ],
    };
    assert.equal(docText(body), 'After image');
  });
});
