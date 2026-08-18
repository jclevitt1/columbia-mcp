import { drive, docs, sheets } from './google-auth.js';

/**
 * Google Drive / Docs / Sheets.
 *
 * Reads run directly. Writes are split into a "plan" half that runs here and
 * an "apply" half registered as an approvals executor — same shape as mail,
 * so nothing edits a document until Jeremy says yes.
 */

const MIME = {
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  folder: 'application/vnd.google-apps.folder',
};

/* ---------------- Drive ---------------- */

/**
 * Find files by name or full-text. `type` narrows to docs/sheets, which is
 * almost always what you want — an unfiltered Drive search returns every PDF
 * and image too.
 */
export async function searchFiles({ query, type = null, limit = 20 }) {
  const clauses = ['trashed = false'];
  if (query) {
    const q = query.replace(/'/g, "\\'");
    clauses.push(`(name contains '${q}' or fullText contains '${q}')`);
  }
  if (type && MIME[type]) clauses.push(`mimeType = '${MIME[type]}'`);

  const { data } = await drive().files.list({
    q: clauses.join(' and '),
    pageSize: Math.min(limit, 100),
    orderBy: 'modifiedTime desc',
    fields: 'files(id, name, mimeType, modifiedTime, owners(displayName), webViewLink)',
  });

  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    kind: Object.keys(MIME).find((k) => MIME[k] === f.mimeType) || f.mimeType,
    modified: f.modifiedTime,
    owner: f.owners?.[0]?.displayName ?? null,
    url: f.webViewLink,
  }));
}

/* ---------------- Docs ---------------- */

/** Flatten the Docs AST to plain text. Tables and lists collapse to lines. */
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

export async function readDoc({ documentId }) {
  const { data } = await docs().documents.get({ documentId });
  const text = docText(data.body);
  return {
    documentId,
    title: data.title,
    chars: text.length,
    text: text.slice(0, 40000),
    truncated: text.length > 40000,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

/** Applied only after approval. Appends to the very end of the document. */
export async function applyDocAppend({ documentId, text }) {
  const client = docs();
  const { data: doc } = await client.documents.get({ documentId });
  // endIndex of the body's last element is one past the final newline; the
  // insertion point has to be one before it or the API rejects the range.
  const content = doc.body?.content || [];
  const endIndex = content[content.length - 1]?.endIndex ?? 1;
  await client.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{
        insertText: { location: { index: Math.max(1, endIndex - 1) }, text },
      }],
    },
  });
  return { documentId, appended: text.length, title: doc.title };
}

/** Applied only after approval. */
export async function applyCreateDoc({ title, text = '' }) {
  const { data } = await docs().documents.create({ requestBody: { title } });
  if (text) await applyDocAppend({ documentId: data.documentId, text });
  return {
    documentId: data.documentId,
    title,
    url: `https://docs.google.com/document/d/${data.documentId}/edit`,
  };
}

/* ---------------- Sheets ---------------- */

export async function readSheet({ spreadsheetId, range = null }) {
  const client = sheets();
  if (!range) {
    const { data: meta } = await client.spreadsheets.get({ spreadsheetId });
    return {
      spreadsheetId,
      title: meta.properties?.title,
      tabs: (meta.sheets || []).map((s) => ({
        title: s.properties.title,
        rows: s.properties.gridProperties?.rowCount,
        cols: s.properties.gridProperties?.columnCount,
      })),
      note: 'Pass a range like "Sheet1!A1:F50" to read values.',
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    };
  }
  const { data } = await client.spreadsheets.values.get({ spreadsheetId, range });
  return {
    spreadsheetId,
    range: data.range,
    rowCount: (data.values || []).length,
    values: data.values || [],
  };
}

/** Applied only after approval. */
export async function applySheetAppend({ spreadsheetId, range, values }) {
  const { data } = await sheets().spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  return {
    spreadsheetId,
    updatedRange: data.updates?.updatedRange,
    updatedRows: data.updates?.updatedRows,
  };
}

/** Applied only after approval. Overwrites the given range. */
export async function applySheetUpdate({ spreadsheetId, range, values }) {
  const { data } = await sheets().spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
  return {
    spreadsheetId,
    updatedRange: data.updatedRange,
    updatedCells: data.updatedCells,
  };
}
