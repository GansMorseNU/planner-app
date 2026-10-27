# Phone ⇄ worker mailbox (Dropbox)

All in `/Planner/.chat/phone/` (Dropbox). Any worker (GitHub job now; the old MacBook Air
or a server later) follows the same rules, so the phone never needs to know which one answers.

| Path | Written by | Content |
|---|---|---|
| `requests/<id>.json` | phone, or the Siri Shortcut "Ask planner" | `{"id", "conversation", "text", "created", "local_time"?, "voice"?}` — one message; `"voice": true` asks for a short reply meant to be read aloud (Siri uses conversation `siri`) |
| `working/<id>.json` | worker | `{"id", "worker", "started", "progress": [..]}` — updated while running |
| `replies/<id>.json` | worker | `{"id", "conversation", "text", "error", "changed": [..], "conflicts": [..], "worker", "started", "finished"}` |
| `sessions/<conversation>.json` | worker | `{"session_id", "jsonl"}` — Claude Code session, so the next message continues the same conversation |
| `heartbeat-<worker>.json` | always-on workers | `{"worker", "time"}` — every few minutes (not used by the GitHub job) |

`<id>` = `YYYYMMDD-HHMMSS-xxxx` (sortable). A request is pending while it has no reply.

Rules
- The worker never deletes or overwrites a newer file: every upload is revision-checked; on
  a clash it saves its version as `<name> (from phone chat).<ext>` and reports it in `conflicts`.
- It never downloads `secrets/`, `snapshots/`, `logs/` or `.chat/snapshots/`.
- The To-Do List is never ticked without Jordan's okay (see notes/working-with-jordan.md).
- The GitHub job runs one request at a time (workflow concurrency group); the phone starts
  it with a `workflow_dispatch`. Always-on workers poll `requests/` instead.
