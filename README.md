# columbia-mcp

A text-message channel to my Mac Mini for Columbia work.

Text a Telegram bot → the Mini runs a headless Claude Code session with a
Columbia MCP server attached → it reads CourseWorks, the course catalog, and
my Columbia mail, and answers. Anything that would leave the machine waits for
me to reply "yes".

```
 phone ──Telegram──▶ bridge ──spawn──▶ claude -p ──stdio──▶ columbia-mcp
                       │                                        │
                       │                              canvas / vergil / mail
                       └──── approvals.json ◀── write actions queue here
```

## Why this shape

**Telegram, not an MCP connector in the Claude app.** A connector would need
the Mini exposed on public HTTPS with OAuth behind a tunnel. Three things
break in that version: the Claude app can't *initiate* a message (so no "your
assignment just posted"), tool calls are request/response so a ten-minute
Vergil job doesn't fit, and it means a public endpoint that can read my email.
Telegram long-polling is outbound-only — nothing listens on a port.

**No API key.** The bridge shells out to `claude -p`, which uses the Claude
Code login already on the box. It rides the subscription.

**Context persists until I clear it.** Each chat maps to a Claude session id;
every message resumes it. `\clear` forgets the pointer and the next message
starts fresh.

**Approvals are a state machine, not an instruction.** Write actions get
enqueued in `approvals.json` as `pending`. The MCP server can enqueue and read
but has no tool that approves — only the bridge sets `approved`, and only in
response to my reply. A prompt-injected model can't talk its way into sending
mail, because there is nothing to talk to.

This matters more than it sounds, because OAuth can't help here: Google has no
draft-only or append-only scope. `gmail.compose` grants sending, `documents`
grants editing. The gate is the only control, so it's built to not depend on
the model behaving.

## What works, and what it cost to find out

| Surface | Access | Notes |
|---|---|---|
| CourseWorks (Canvas) | REST + Bearer token | Clean. `401 WWW-Authenticate: Bearer realm="canvas-lms"` unauthenticated. No bot challenge. |
| Course catalog (Directory of Classes) | Playwright, **no login** | Public at `doc.sis.columbia.edu`; search GETs `doc.search.columbia.edu/search?q=…&semes=20263`. Works before any CAS login. |
| Vergil (personal schedule) | Playwright + CAS/Duo | Moved to `vergil.columbia.edu/vergil`. Meeting days/times now live *only* here, not in the DOC. |
| Columbia mail | pluggable | LionMail is Google Workspace (`lionmail.columbia.edu` CNAMEs to `ghs.google.com`), so Gmail API is the right target. CUIT may still block third-party OAuth clients; `apple_mail` via Mail.app is the fallback nobody can revoke. |
| Drive / Docs / Sheets | same Google OAuth | One consent covers mail and files. Reads direct; edits gated. |
| Google Calendar | same Google OAuth | Reads direct; creating/deleting events gated. Added after the first consent, so `gmail-auth` must be re-run once to pick up the scope. |

## Setup

See [SETUP.md](SETUP.md) — it has to be run at the Mini, because CAS/Duo and
the OAuth consent screen both need a human at the machine.

```bash
npm install
cp .env.example .env      # fill in
npm run doctor            # tells you exactly what is still missing
npm run vergil-login      # once, in front of the machine
npm run bridge
```

## Telegram commands

```
\clear     forget context, start fresh next message
\status    session info + config health + running git version
\pending   actions waiting on me
\update    git pull + restart the bridge (remote deploy from the phone)
\help
yes        approve everything pending and run it
no         drop everything pending — it will not be asked again
yes <id>   pick one out of several (ids from \pending)
```

Only actions queued during the current turn are announced. Anything left
unanswered stays reachable through `\pending` for 24 hours but is not
re-listed after every message.

### Updating the Mini from anywhere

Push to `main`, then text `\update`. The bridge fetches, fast-forwards, runs
`npm install` if `package.json` or the lockfile moved, and restarts. Under
launchd it exits and `KeepAlive` brings it back; run by hand it re-execs
itself. The new process texts back "Back up on <sha>" so you know it landed.

It only ever fast-forwards. Local edits or a diverged branch on the Mini make
it stop and say so rather than merge from a phone. A failed `npm install`
rolls the checkout back to where it was.

This is a command, not a webhook or a poll, on purpose: a webhook needs the
Mini reachable on public HTTPS, which this whole design avoids, and a poll
would restart the bridge on its own schedule instead of yours. Messages are
handled one at a time, so `\update` can never land mid-conversation.

## Keeping credentials alive

Five credentials keep this thing working, and only one of them publishes an
expiry. Probed 2026-09-04:

| Credential | Real expiry? | What can be known |
|---|---|---|
| `cf_clearance` cookie | yes — `expires_utc` in the cookie DB | a true countdown |
| CAS / SSOL session | no | session cookies, no expiry field; server decides |
| Google refresh token | no | lifetime depends on OAuth publishing status |
| Canvas access token | no | `/users/self` returns 200 and no expiry metadata |
| Telegram bot token | n/a | does not expire |

So `auth-sweep` reports `ok` / `warn` / `fail` / **`unknown`**, and treats
`unknown` as a real answer rather than rounding it to "fine". It alerts on
`fail` and `warn` only — never on `unknown`, which means "could not
determine" and is not worth waking someone at 8am.

```
columbia-sweep                     # status, no browser, no alert unless there is a problem
columbia-sweep -- --always         # alert even when healthy
columbia-sweep -- --json           # machine-readable
columbia-sweep -- --probe-vergil   # real Vergil verdict; opens a browser window
columbia-auth                      # re-run every interactive auth, in one pass
```

A LaunchAgent runs the sweep at 08:00 and 20:00 and messages the **alert
bot** when something needs attention.

### Why a second bot

`ALERT_BOT_TOKEN` is deliberately not `TELEGRAM_BOT_TOKEN`. The main bot is
one of the things being watched, and a monitor that dies with the thing it
monitors is not a monitor. A separate token means an auth alert still arrives
if the bridge's own token is revoked.

### Why the Vergil probe is opt-in

Headless Chromium does not clear Columbia's Cloudflare managed challenge.
Measured 2026-09-04: both hosts sat on `Just a moment...` until timeout, and
`needsLogin` still read `false` — a headless sweep would report "Vergil
healthy" while fully blocked. The scheduled job therefore never launches a
browser; it reads cookie metadata from a copy of the DB instead. Ask for a
real verdict with `--probe-vergil`.

### The CAS session is more fragile than it looks

The cookies holding a CAS login (`PF`, `__Host-JSESSIONID`) are *session*
cookies, not persistent ones. Closing the browser context cleanly purges
them, so a tidy shutdown costs you the login and a fresh Duo tap. This is why
the sweep treats their **absence as definitive** (`fail`) but their presence
as merely `unknown` — the asymmetry is the whole point.

## Layout

```
src/config.js           env + state paths (state lives in ~/.columbia-mcp)
src/approvals.js        the check-off gate
src/sessions.js         telegram chat -> claude session id
src/tools/canvas.js     CourseWorks REST, paginated, read-only
src/tools/vergil.js     Playwright against the Cloudflare-challenged hosts
src/tools/gmail.js      apple_mail | gmail_api | none
src/tools/gdocs.js      Drive search, Docs/Sheets read, gated writes
src/tools/gcal.js       Calendar read, gated create/delete
src/executors.js        the "apply" half of every gated write, shared by both processes
src/updater.js          \update: fetch, ff-only, npm install, restart
src/authcheck.js        credential checks; `unknown` is a first-class result
src/mcp/server.js       34 tools over stdio
src/bridge/telegram.js  long-poll loop, spawns claude -p
scripts/doctor.js       preflight — run this first
scripts/auth-sweep.js   twice-daily credential sweep, alerts over the second bot
scripts/columbia-auth.sh  re-run every interactive auth in one pass
launchd/                keep the bridge alive; run the sweep on a schedule
```

## Status

Verified working end to end, on real data:

- MCP server boots, registers all 21 tools.
- `vergil_search` returns structured live results — "statistical inference",
  Fall 2026 → 29 hits, including `STAT GR5204-001` (call# 14611,
  Dolgoarshinnykh) and `-002` (14612, De La Peña). Playwright clears the
  Cloudflare challenge without trouble.
- Approvals gate: refuses to run while pending, refuses replay after done,
  refuses to approve a rejected action. One send out of seven attempts.
  Every write tool (`*_request_*`) confirmed to queue and do nothing else.

Not yet exercised: Canvas (needs a token), mail (needs a backend decision),
and Vergil's logged-in half (needs Duo at the machine). `npm run doctor`
is the scoreboard.

**Note:** all of `columbia.edu` sits behind a Cloudflare managed challenge —
`curl` gets a 403 "Just a moment…" even with a browser UA — so the browser
path is not optional, it's the only thing that works.
