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

1. <https://console.cloud.google.com> → new project → enable four APIs:
   **Gmail**, **Google Docs**, **Google Sheets**, **Google Drive**.
2. OAuth consent screen → **External** → add your Columbia address as a test user.
3. Credentials → OAuth client ID → **Desktop app** → copy id + secret.
4. Put the id and secret in `.env`, then `npm run gmail-auth`.
5. Sign in with your `@columbia.edu` account when consenting.

One consent covers mail, Drive, Docs and Sheets — the scope list lives in
`src/tools/google-auth.js`. Adding a scope later means re-running
`gmail-auth`, so it's cheaper to decide up front.

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

---

## Sanity checks after it's live

- Text `\status` → session, backend, token, pending count.
- Ask it to draft an email. It should draft, queue, and tell you it's waiting —
  never send. If it ever sends without your `yes`, that's a bug, and a serious
  one. Nothing should reach `approved` except through the bridge.
- Text `\clear`, then ask a follow-up — it should have forgotten.
