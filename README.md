# Control Room

A big-button control panel for driving [Claude Code](https://claude.com/claude-code)
from a browser or from Telegram.

You type (or tap a button) in the panel. The message is appended to `chat.jsonl`.
Claude Code, running in a terminal, watches that file, does the work, and answers
with `reply.py` in a small line-based markup ([MARKUP.md](MARKUP.md)) that the panel
renders as headlines, stat tiles, status pills, cards and choice buttons.

```
browser / Telegram  ──►  chat.jsonl  ──►  Claude Code
        ▲                                     │
        └──────────  reply.py  ◄──────────────┘
```

Python 3 standard library only. No dependencies, no build step.

## Files

| File | What it does |
|---|---|
| `chat_server.py` | HTTP server on `localhost:8000`: serves the page, reads and appends to `chat.jsonl` |
| `chat.html` | The panel: renders the markup, sends messages, polls for replies |
| `reply.py` | Posts an assistant reply into the log |
| `watch.py` | Filter for `tail -F chat.jsonl`: one line per new user message |
| `telegram_bot.py` | Optional Telegram front-end on the same log ([TELEGRAM.md](TELEGRAM.md)) |

## Run it

```bash
python3 chat_server.py                  # then open http://localhost:8000
```

Then tell Claude Code, in the same folder, to watch the chat:

```bash
tail -n0 -F chat.jsonl | python3 -u watch.py      # each user message as one line
```

and to answer with:

```bash
python3 reply.py <<'EOF2'
::ask Which one?
::pick Option A
::pick Option B
EOF2
```

In Claude Code, running the watch command through the Monitor tool delivers each
message as a notification, so no polling loop is needed.

## Behaviour worth knowing

- **One screen, no scrollback.** Each reply replaces the left column; detail lives
  in cards that open on the right.
- **Live reload.** The server stamps the page with its file time, so an open tab
  reloads itself when `chat.html` changes.
- **Safe concurrent writers.** The server, `reply.py` and the Telegram bot all
  append under an `flock`, and ids come from a high-water mark in `.seq`, so they
  never repeat, even after `chat.jsonl` is truncated.
- **Local only.** The server binds to `127.0.0.1`. The Telegram bot uses outbound
  long-polling, so nothing is exposed to the internet.
