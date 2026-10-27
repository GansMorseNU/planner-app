# Planner — phone app

The iPhone side of Jordan's Planner (`~/Dropbox/Planner`). Two parts:

- **`app/`** — a Home Screen web app published at https://gansmorsenu.github.io/planner-app/.
  It reads and writes the Planner's own files directly in Dropbox (signed in with Dropbox on
  the phone); nothing is stored on any server. Tabs: **Today** (Google Calendar copy, school
  pickup, planned blocks with ticks, today's This Week lines), **This Week**, **Ask Claude**,
  **Settings**. Ticks follow the desktop rule: blocks ↔ This Week lines only; the To-Do List
  is never ticked from here. Every write is revision-checked, so a newer copy in Dropbox is
  never overwritten.
- **`worker/`** — answers the Ask Claude chat. The phone writes a request into
  `Dropbox/Planner/.chat/phone/` and starts the GitHub job `.github/workflows/ask-claude.yml`,
  which downloads the Planner files, runs Claude Code on Jordan's subscription
  (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`), uploads changed files and the reply.
  Protocol: `worker/PROTOCOL.md`. The same `worker/run.py --loop` can later run on a spare Mac
  or a small server instead of GitHub; the phone side stays the same.

## Setup (once)

1. Repository secrets (Settings → Secrets and variables → Actions):
   `CLAUDE_CODE_OAUTH_TOKEN`, `DROPBOX_APP_KEY` (`mw2vh3rfqkxtawf`), `DROPBOX_REFRESH_TOKEN`.
2. Settings → Pages → Source: **GitHub Actions** (the "Publish phone app" job does the rest).
3. Dropbox app console (app `mw2vh3rfqkxtawf`): add redirect URI
   `https://gansmorsenu.github.io/planner-app/`.
4. On the phone: open the page in Safari → Share → Add to Home Screen; sign in to Dropbox;
   in Settings paste a fine-grained GitHub token limited to this repository with
   **Actions: Read and write**.

## Tests

`node tests/phone.test.js` drives the app in a phone-sized browser against a mocked Dropbox
and GitHub (ticks, carried lines, list editing, conflict handling, chat round trip). It uses the
made-up files in `tests/fixture/` (never real data), so it doesn't break as the real lists change;
pass a folder path to run it against another copy.
The worker has its own mock-based test (not in the repo yet).
