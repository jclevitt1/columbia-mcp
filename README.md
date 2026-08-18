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
| Vergil / Directory of Classes | Playwright, persistent profile | **Every `columbia.edu` host is behind a Cloudflare managed challenge** (`cf-mitigated: challenge`). `curl` gets a 403 "Just a moment…" even with a browser UA. HTTP scraping is not an option. |
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

Scaffolding is complete and the MCP server boots and registers all 14 tools.
Nothing has been run against a live Columbia account yet — that needs the Mini.
`npm run doctor` is the honest scoreboard.
