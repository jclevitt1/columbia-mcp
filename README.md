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

## What works, and what it cost to find out

| Surface | Access | Notes |
|---|---|---|
| CourseWorks (Canvas) | REST + Bearer token | Clean. `401 WWW-Authenticate: Bearer realm="canvas-lms"` unauthenticated. No bot challenge. |
| Course catalog (Directory of Classes) | Playwright, **no login** | Public at `doc.sis.columbia.edu`; search GETs `doc.search.columbia.edu/search?q=…&semes=20263`. Works before any CAS login. |
| Vergil (personal schedule) | Playwright + CAS/Duo | Moved to `vergil.columbia.edu/vergil`. Meeting days/times now live *only* here, not in the DOC. |
| Columbia mail | pluggable | Gmail API may be blocked by CUIT for third-party OAuth clients; `apple_mail` via Mail.app is the fallback nobody can revoke. Default is `none` until verified. |

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
\status    session info + config health
\pending   actions waiting on me
\help
yes <id>   approve a queued action   (bare "yes" works if only one is pending)
no <id>    drop it
```

## Layout

```
src/config.js           env + state paths (state lives in ~/.columbia-mcp)
src/approvals.js        the check-off gate
src/sessions.js         telegram chat -> claude session id
src/tools/canvas.js     CourseWorks REST, paginated, read-only
src/tools/vergil.js     Playwright against the Cloudflare-challenged hosts
src/tools/gmail.js      apple_mail | gmail_api | none
src/mcp/server.js       14 tools over stdio
src/bridge/telegram.js  long-poll loop, spawns claude -p
scripts/doctor.js       preflight — run this first
launchd/                keep the bridge alive across reboots
```

## Status

Verified working end to end, on real data:

- MCP server boots, registers all 14 tools.
- `vergil_search` returns structured live results — "statistical inference",
  Fall 2026 → 29 hits, including `STAT GR5204-001` (call# 14611,
  Dolgoarshinnykh) and `-002` (14612, De La Peña). Playwright clears the
  Cloudflare challenge without trouble.
- Approvals gate: refuses to run while pending, refuses replay after done,
  refuses to approve a rejected action. One send out of seven attempts.

Not yet exercised: Canvas (needs a token), mail (needs a backend decision),
and Vergil's logged-in half (needs Duo at the machine). `npm run doctor`
is the scoreboard.

**Note:** all of `columbia.edu` sits behind a Cloudflare managed challenge —
`curl` gets a 403 "Just a moment…" even with a browser UA — so the browser
path is not optional, it's the only thing that works.
