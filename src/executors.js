import * as approvals from './approvals.js';
import * as mail from './tools/gmail.js';
import * as gdocs from './tools/gdocs.js';
import * as gcal from './tools/gcal.js';

/**
 * The "apply" half of every gated write, keyed by the action kind the MCP
 * server enqueues. Imported by BOTH the MCP server and the Telegram bridge.
 *
 * That "both" is the point. The bridge is the process that calls
 * approvals.runApproved() when Jeremy replies "yes", so it is the one that
 * actually needs these — and before this file existed it only registered
 * gmail.send, which meant approving a Docs or Sheets write from Telegram
 * failed with "no executor registered". Registering from one module keeps
 * the two processes from drifting apart again.
 */
export function registerAll() {
  approvals.registerExecutor('gmail.send', (p) => mail.sendDraft(p));
  approvals.registerExecutor('docs.append', (p) => gdocs.applyDocAppend(p));
  approvals.registerExecutor('docs.create', (p) => gdocs.applyCreateDoc(p));
  approvals.registerExecutor('sheets.append', (p) => gdocs.applySheetAppend(p));
  approvals.registerExecutor('sheets.update', (p) => gdocs.applySheetUpdate(p));
  approvals.registerExecutor('calendar.create', (p) => gcal.applyCreateEvent(p));
  approvals.registerExecutor('calendar.delete', (p) => gcal.applyDeleteEvent(p));
}
