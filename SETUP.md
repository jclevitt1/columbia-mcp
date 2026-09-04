# Setup — run this at the Mac Mini

## Moving an already-working install to another machine

```bash
git clone https://github.com/jclevitt1/columbia-mcp.git
cd columbia-mcp
scp <old-machine>:~/workspace/Columbia/columbia-mcp/.env .   # secrets do NOT come from git
./scripts/install-mini.sh --load
```

`.env` is gitignored, so the clone brings no credentials — copying it across
is the one manual step, and the script stops with instructions if it's absent.
The Canvas token and the Google refresh token are both portable; the Playwright
profile is not, so `npm run vergil-login` still has to be re-run here.

**Stop the bridge on the old machine first.** Telegram delivers each update to
exactly one poller, so two bridges sharing a token steal each other's messages
at random — which reads as flaky delivery, not a misconfiguration.

Skip to step 5 once the script finishes. The rest of this document is for a
first-time setup.

---


Ordered so the cheap, certain steps come first and the one genuinely unknown
step (mail) comes last. `npm run doctor` after each step tells you where you
are.

---

## 0. Install

```bash
cd ~/workspace/Columbia/columbia-mcp
npm install
npx playwright install chromium
cp .env.example .env
```

---

## 1. Telegram — 5 minutes, no unknowns

1. Message **@BotFather** → `/newbot` → name it → copy the token.
2. Message **@userinfobot** → it replies with your numeric chat id.
3. Put both in `.env`:
   ```
   TELEGRAM_BOT_TOKEN=8123...
   TELEGRAM_OWNER_CHAT_ID=123456789
   ```

The owner id is a hard gate — the bridge refuses to start without it, and
ignores any message from another chat. Telegram bot usernames are guessable,
so treat this as the thing standing between a stranger and your inbox.

---

## 2. CourseWorks token — 2 minutes, one thing to check

1. Go to <https://courseworks2.columbia.edu/profile/settings>
2. **Approved Integrations → + New Access Token**. Purpose: `columbia-mcp`.
   Leave expiry blank.
3. Copy it into `CANVAS_ACCESS_TOKEN` in `.env`.

```bash
npm run doctor    # should print: ok  Canvas token  authenticated as Jeremy Levitt
```

**If the "+ New Access Token" button isn't there**, Columbia has disabled
self-service tokens institution-wide. Say so and Canvas moves to the Playwright
path like Vergil — the tools stay the same, only `src/tools/canvas.js` changes.

---

## 3. Mail — the one real unknown

Do this in order and stop at the first that works.

### 3a. Try the Gmail API first (best if allowed)

Columbia mail is Google Workspace. The blocker is whether CUIT permits
third-party OAuth clients for `gmail.readonly` / `gmail.compose`. Check:

1. <https://console.cloud.google.com> → new project → enable five APIs:
   **Gmail**, **Google Docs**, **Google Sheets**, **Google Drive**, **Google Calendar**.
2. OAuth consent screen → **External** → add your Columbia address as a test user.
3. Credentials → OAuth client ID → **Desktop app** → copy id + secret.
4. Put the id and secret in `.env`, then `npm run gmail-auth`.
5. Sign in with your `@columbia.edu` account when consenting.

One consent covers mail, Drive, Docs, Sheets and Calendar — the scope list
lives in `src/tools/google-auth.js`. Adding a scope later means re-running
`gmail-auth`, so it's cheaper to decide up front.

### 3a-bis. Already authorised before Calendar was added?

The stored refresh token predates the Calendar scope. `npm run doctor` shows
`FAIL Google scopes  missing calendar.readonly, calendar.events`. Fix, at the
Mini (the consent screen needs a browser there):

1. Enable the **Google Calendar API** on the same Cloud project:
   <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>
2. `npm run gmail-auth` — same consent flow, now with Calendar in the list.
3. `npm run doctor` → `ok  Google scopes`.
4. Restart the bridge (text `\update`, or `launchctl kickstart -k gui/$(id -u)/dev.jclevitt.columbia-bridge`)
   so the running process reads the new token from `.env`.

**If you hit "Access blocked: this app is blocked" or an admin-policy error,
that's your answer — CUIT blocks it. Go to 3b.** Don't fight it; the fallback
is genuinely fine.

`gmail-auth` writes `GMAIL_REFRESH_TOKEN` and flips `GMAIL_BACKEND=gmail_api`
into `.env` itself on success.

Note: `apple_mail` is a *mail* fallback only. Drive/Docs/Sheets have no
non-Google path, so if OAuth is blocked those tools are simply unavailable.

### 3b. Fall back to Mail.app (always available)

Mail.app already holds your Columbia account, so there is nothing to approve.

1. Make sure the Columbia account is added in Mail and named so that
   "Columbia" appears in the account name — `src/tools/gmail.js` matches on that.
2. Set `GMAIL_BACKEND=apple_mail`.
3. First run will prompt for Automation permission. If it doesn't, grant it
   manually: **System Settings → Privacy & Security → Automation** → allow
   Terminal (and later `launchd`) to control **Mail**.

Slower and macOS-only, but it can't be administratively taken away.

---

## 4. Vergil login — once, in front of the machine

**Course *catalog* search already works without this.** The Directory of
Classes is public, so `vergil_search` is live the moment Playwright is
installed. You only need the login below for your *personal* Vergil data —
schedule, book lists, faculty evaluations — and for meeting days/times, which
Columbia moved out of the DOC and into Vergil only.


```bash
npm run vergil-login
```

A Chromium window opens. Sign in with your UNI, approve the Duo push. The
script exits once you're through.

This is a real browser because it has to be: every `columbia.edu` host sits
behind a Cloudflare managed challenge that returns 403 to `curl` regardless of
User-Agent. Playwright clears it fine. The persistent profile keeps both the
CAS session and the Cloudflare clearance cookie, so later browsing runs
unattended.

Vergil now lives at `vergil.columbia.edu/vergil` (the old
`vergil.registrar.columbia.edu` redirects there).

Re-run whenever CAS expires — `vergil_session_status` reporting `needsLogin`
is the tell.

---

## 5. Run it

```bash
npm run doctor    # everything should be ok
npm run bridge
```

Text the bot `\help`. Then something real: *"what's due in the next week?"*

### Keep it alive across reboots

```bash
cp launchd/dev.jclevitt.columbia-bridge.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/dev.jclevitt.columbia-bridge.plist
tail -f ~/.columbia-mcp/logs/bridge.err.log
```

A LaunchAgent, not a LaunchDaemon — it needs your GUI session for Playwright
windows and Mail automation. So the Mini has to be logged in, not just powered
on. Check **Settings → Users & Groups → automatic login** and
**Energy Saver → prevent sleep**.

The plist sets `BRIDGE_SUPERVISOR=launchd`, which is what lets `\update`
simply exit after pulling and trust `KeepAlive` to restart it. If you already
had an older plist installed, re-run `./scripts/install-mini.sh --load` to
regenerate it with that variable; otherwise `\update` will re-exec itself
*and* launchd will start another copy, and two pollers on one bot token
split messages at random.

### Updating remotely

Push to `main` from anywhere, then text the bot `\update`. Text `\status`
afterwards to confirm the sha. See the README for what it refuses to do.

---

## Sanity checks after it's live

- Text `\status` → session, backend, token, pending count.
- Ask it to draft an email. It should draft, queue, and tell you it's waiting —
  never send. If it ever sends without your `yes`, that's a bug, and a serious
  one. Nothing should reach `approved` except through the bridge.
- Text `\clear`, then ask a follow-up — it should have forgotten.

## 6. Credential sweep — optional, 5 minutes

The bridge depends on five credentials and only one of them publishes an
expiry, so the sweep is a liveness monitor rather than a countdown. It runs
headless and never opens a browser.

### 6a. Create the alert bot

A **second** bot, separate from the bridge's. The bridge's own token is one of
the things being watched, and a monitor that dies with the thing it monitors
is not a monitor.

1. Message `@BotFather`, send `/newbot`, name it something like
   `columbia alerts`.
2. Copy the token into `ALERT_BOT_TOKEN` in `.env`.
3. Message your new bot once — Telegram will not let it write to you first.
4. Put your chat id (the same one as `TELEGRAM_OWNER_CHAT_ID`) in
   `ALERT_CHAT_ID`.

Confirm it can reach you:

```bash
npm run auth-sweep -- --always
```

That sends a digest even when everything is healthy. Leave the two variables
blank and the sweep still runs and prints — it just never sends.

### 6b. Schedule it

```bash
cp launchd/dev.jclevitt.columbia-auth-sweep.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.jclevitt.columbia-auth-sweep.plist
```

08:00 and 20:00 daily, alerting only on `fail` and `warn`. Silence means
healthy. Run it on demand with `launchctl kickstart` or just `columbia-sweep`.

### 6c. Shell aliases

```bash
alias columbia-auth='bash "$HOME/columbia-mcp/scripts/columbia-auth.sh"'
alias columbia-sweep='npm --prefix "$HOME/columbia-mcp" run --silent auth-sweep --'
```

`columbia-auth` re-runs every interactive authentication in one pass — Google
OAuth, then CAS for Vergil and SSOL. Both open browser windows and Duo needs a
tap, so it only works at the machine itself.

### What the sweep cannot tell you

Vergil and SSOL. Headless Chromium does not clear Columbia's Cloudflare
managed challenge — measured 2026-09-04, both hosts sat on `Just a moment...`
until timeout while `needsLogin` still read `false`. Rather than report a
verdict it cannot support, the sweep reads cookie metadata and marks the CAS
session `unknown`. For a real answer:

```bash
columbia-sweep -- --probe-vergil     # opens a browser window
```

One asymmetry worth understanding: the sweep treats **missing** CAS cookies as
a definite failure, but their presence as merely unverified. `PF` and
`__Host-JSESSIONID` are session cookies — closing a browser context cleanly
deletes them, and their absence reliably means there is no login to use.
