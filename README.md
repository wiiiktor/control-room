# Control Room

![Control Room](docs/control-room.png)

A big-button control panel for driving [Claude Code](https://claude.com/claude-code)
from a browser.

You type (or tap a button) in the panel. The message is appended to `chat.jsonl`.
Claude Code, running in a terminal, watches that file, does the work, and answers
with `reply.py` in a small line-based markup ([MARKUP.md](MARKUP.md)) that the panel
renders as headlines, stat tiles, status pills, cards and choice buttons.

```
browser  ────────►  chat.jsonl  ──►  Claude Code
   ▲                                      │
   └──────────  reply.py  ◄───────────────┘
```

Python 3 standard library only. No dependencies, no build step.

## Files

| File | What it does |
|---|---|
| `chat_server.py` | HTTP server on `localhost:8000`: serves the page, reads and appends to `chat.jsonl` |
| `chat.html` | The panel: renders the markup, sends messages, polls for replies |
| `reply.py` | Posts an assistant reply into the log |
| `resume.py` | Answers messages addressed to ONE dormant session by resuming it (`claude --resume`) |
| `autoresume.py` | Starts a `resume.py` on demand for whichever session you write to from the panel |
| `control-room-autoresume.service` | systemd user unit for the waker |
| `sessions.py` | Lists this project's Claude Code sessions: id, time, size, opening message |
| `control-room.service` | systemd user unit: starts the panel at login and restarts it if it dies |
| `status.py` | Says what is happening WHILE working; shows under "Working on it…" and is cleared when the reply lands |
| `watch.py` | Filter for `tail -F chat.jsonl`: one line per new user message |

## What a reply looks like

![Every element the panel can draw](docs/control-room-example.png)

One reply, every directive: the headline, the lead, a note, four stat tiles, three
cards, a plain line, two choice buttons and a `::fill`. The card that is open on the
right holds a `::chart` and an `::html` table. The palette here is "peas with corn";
the yellow `C` in the corner switches it.

## In the editor instead of a browser

`extension/` is a VS Code extension that opens the same panel as an editor tab, with no
server and no port — the extension host reads and writes `chat.jsonl` itself.

```bash
code --install-extension extension/control-room-0.1.0.vsix
```

or **Extensions ▸ … ▸ Install from VSIX…**, then run **Control Room: Open panel** from
the command palette. The same file installs in Cursor, Windsurf and VSCodium
(`cursor --install-extension …`). Build it again with `extension/build.sh`.

## Run it

```bash
python3 chat_server.py                  # then open http://localhost:8111
                                        # (CONTROL_ROOM_PORT overrides the port)
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
  in cards that open on the right. The panel stamps each reply with its own `(HH:MM)`
  from `chat.jsonl`, with the date on hover, so a reply never carries a clock in its
  text and an archived one shows when it landed. A reply too tall for the column is shrunk to fit,
  down to a floor where the text is still readable, and only then does the column
  scroll. The "you said" breadcrumb is cut to one line and opens on hover or click.
- **Grouped by session.** Each reply records the Claude session that wrote it, so the
  timeline draws a divider per session — labelled with what that session opened with,
  since Claude Code does not name sessions — and the strip shows exactly ONE session at a
  time, chosen from a "session:" menu at its head (or by clicking the divider) — never
  two mixed together. It opens on the newest session.
- **The timeline is the scrollback.** The yellow `T` in the corner opens a strip of
  every past reply, each one re-rendered by the same builder rather than stored as an
  image. Hover a thumbnail to read that screen full size on the left; click to pin it
  so its cards can be opened; `T` again or `Esc` closes. Nothing is lost by the
  one-screen rule — `chat.jsonl` holds every message, and the strip is built from it.
- **Eight palettes.** The yellow `C` picks "peas with corn" (the default), dark,
  light, and five built on the colour wheel, each holding to one relationship:
  Copper & Cobalt (complementary), Plum & Citron (split-complementary), Terracotta
  Triad (triadic), Moss (analogous) and Porcelain & Ink (near-monochrome plus one
  accent). Surfaces sit in the base hue at low saturation, accents share a lightness,
  and the text on each fill is picked by contrast ratio, not by eye. Every colour is a
  token on `:root`, so a palette is one block of variables and nothing else in the
  stylesheet knows which is running; the choice is kept in `localStorage` and stamped
  on `<html>` before the first paint.
- **Live reload.** The server stamps the page with its file time, so an open tab
  reloads itself when `chat.html` changes.
- **Progress while you wait.** `python3 status.py "reading the training log"` adds a
  line under "Working on it…". The lines live in `.status`, never in `chat.jsonl`, and
  are cleared the moment a message lands — scaffolding, not conversation.
- **Safe concurrent writers.** The server and `reply.py` both
  append under an `flock`, and ids come from a high-water mark in `.seq`, so they
  never repeat, even after `chat.jsonl` is truncated.
- **A scrollable pane says so.** The detail pane and the timeline draw a visible
  scrollbar rather than the overlay one the OS fades in only after you scroll, which
  is too late to tell you there is more below.
- **Local only.** The server binds to `127.0.0.1` on port 8111, so nothing is exposed
  to the internet and nothing collides with the usual 8000.
- **Address a message to one session.** The timeline's session menu picks who you are
  writing to; `watch.py` ignores anything addressed elsewhere, so only that session is
  notified. Choose a session that is not running and `autoresume.py` wakes it with
  `claude --resume` so it can answer — one real Claude run per message.
- **It says when nobody is listening.** The page is connected to the server, but that
  is not the same as Claude reading the log. The watcher touches `.watch` every 30s and
  the page shows a "not watching" pill when that goes stale — a message sent then will
  simply wait. Clicking the pill explains what it can rule out (a stale page) and what
  only you can fix (the session that holds the watch).
