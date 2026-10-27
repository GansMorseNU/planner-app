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

## Siri Shortcuts (hands-free, e.g. in the car)

Two Shortcuts, built once in the iPhone **Shortcuts** app. Their names are what you say:
"Hey Siri, **add to planner**" and "Hey Siri, **ask planner**". Both talk straight to Dropbox and
GitHub with this phone's keys, so the Planner app itself never has to open.

**Before you start:** in the Planner app, Settings → **Copy Siri setup**. It copies one block of
text with the Dropbox and GitHub keys. Keep it private (anyone with it can read your Planner).

### Part A — the opening steps (the same in both Shortcuts)

In Shortcuts: **+** (new shortcut). Add these actions, in order (search for each by name):

1. **Text** — paste the block you copied.
2. **Get Dictionary from Input** — input: *Text*.
3. **Get Contents of URL**
   - URL: `https://api.dropboxapi.com/oauth2/token`
   - Method: **POST** · Request Body: **Form**, three fields:
     - `grant_type` = `refresh_token`
     - `refresh_token` = *Dictionary* → tap it → Get Value for Key `dropbox_refresh`
     - `client_id` = *Dictionary* → Get Value for Key `app_key`
4. **Get Dictionary Value** — Get **Value** for key `access_token` in *Contents of URL*.
   Long-press the result, Rename it **Token**.

(Wherever a step below says *Token*, *Dictated Text* etc., insert that variable by tapping the
field and choosing it from the bar above the keyboard.)

### Part B — "Add to planner"

After Part A:

5. **Dictate Text** — Stop Listening: *After Pause*.
6. **Format Date** — Date: *Current Date* · Format: Custom `yyyyMMdd-HHmmss`.
7. **Get Contents of URL**
   - URL: `https://content.dropboxapi.com/2/files/upload` · Method **POST**
   - Headers:
     - `Authorization` = `Bearer ` then *Token*
     - `Content-Type` = `application/octet-stream`
     - `Dropbox-API-Arg` = `{"path":"/Planner/inbox/` *Formatted Date* `.txt","mode":"add","autorename":true}`
   - Request Body: **File** → *Dictated Text*
8. **Speak Text** — `Added.`

Name the shortcut **Add to planner**. The item lands in `Planner/inbox/`; the desktop Planner files it
into the To-Do List under **INBOX (voice)** within ~15 seconds (or when it next opens).

### Part C — "Ask planner"

Duplicate "Add to planner" (long-press → Duplicate), rename it **Ask planner**, delete its steps
after Part A, then add:

5. **Dictate Text** — Stop Listening: *After Pause*.
6. **Format Date** — *Current Date*, Custom `yyyyMMdd-HHmmss`. Then **Text**: *Formatted Date* `-siri`;
   rename the result **ID**.
7. **Format Date** — *Current Date*, Custom `EEE, MMM d 'at' h:mm a`; rename **Local**.
8. **Dictionary** — keys: `id` = *ID* · `conversation` = `siri` · `text` = *Dictated Text* ·
   `local_time` = *Local* · `voice` = Boolean **true**.
9. **Get Contents of URL** — same as Part B step 7, but `Dropbox-API-Arg` =
   `{"path":"/Planner/.chat/phone/requests/` *ID* `.json","mode":"add"}` and Request Body
   **File** → *Dictionary*.
10. **Get Contents of URL**
    - URL: `https://api.github.com/repos/GansMorseNU/planner-app/actions/workflows/ask-claude.yml/dispatches`
    - Method **POST** · Headers: `Authorization` = `Bearer ` then *Dictionary from step 2* →
      Get Value for Key `github_token`; `Accept` = `application/vnd.github+json`
    - Request Body: **JSON** — `ref` (Text) = `main`; `inputs` (Dictionary) with `request` (Text) = *ID*
11. **Speak Text** — `Asking. About a minute.`
12. **Repeat** 30 times, containing:
    - **Wait** 5 seconds
    - **Get Contents of URL** — URL `https://content.dropboxapi.com/2/files/download`, Method
      **POST**, Headers `Authorization` = `Bearer ` *Token*; `Dropbox-API-Arg` =
      `{"path":"/Planner/.chat/phone/replies/` *ID* `.json"}`
    - **Get Dictionary Value** — Value for key `text` in *Contents of URL*
    - **If** *Dictionary Value* **has any value**: **Speak Text** *Dictionary Value*, then
      **Stop This Shortcut**. **End If**
13. After the Repeat: **Speak Text** — `No answer yet. It will be in the Planner app.`

Questions go to a separate chat conversation ("siri"), with the same files and rules as the phone
chat; Claude keeps spoken answers to a few sentences. Anything you ask it to add goes under
INBOX (voice) in the To-Do List.

If Siri runs the wrong thing, open Shortcuts and check the name; Siri matches the spoken name.

## Tests

`node tests/phone.test.js` drives the app in a phone-sized browser against a mocked Dropbox
and GitHub (ticks, carried lines, list editing, conflict handling, chat round trip). It uses the
made-up files in `tests/fixture/` (never real data), so it doesn't break as the real lists change;
pass a folder path to run it against another copy.
The worker has its own mock-based test (not in the repo yet).
