# Control Room

![Control Room](docs/control-room.png)

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
  in cards that open on the right. A reply too tall for the column is shrunk to fit,
  down to a floor where the text is still readable, and only then does the column
  scroll. The "you said" breadcrumb is cut to one line and opens on hover or click.
- **The timeline is the scrollback.** The yellow `T` in the corner opens a strip of
  every past reply, each one re-rendered by the same builder rather than stored as an
  image. Hover a thumbnail to read that screen full size on the left; click to pin it
  so its cards can be opened; `T` again or `Esc` closes. Nothing is lost by the
  one-screen rule — `chat.jsonl` holds every message, and the strip is built from it.
- **Three palettes.** The yellow `C` picks dark (the default), light, or "peas with
  corn" — the original — plus five built on the colour wheel, each holding to one
  relationship: Copper & Cobalt (complementary), Plum & Citron (split-complementary),
  Terracotta Triad (triadic), Moss (analogous) and Porcelain & Ink (near-monochrome
  plus one accent). Surfaces sit in the base hue at low saturation, accents share a
  lightness, and the text on each fill is picked by contrast ratio, not by eye. Dark and light take their surfaces, borders and accents from
  the editor's own default themes: `#1f1f1f` / `#ffffff` page, `#181818` / `#f8f8f8`
  panel, the `#2b2b2b` / `#e5e5e5` border, the primary-button blue and the chart
  green, yellow and red. The heavy ink outlines stay — no editor theme draws those.
  Every colour is a token on `:root`, so a palette is one block of variables and
  nothing else in the stylesheet knows which is running; the choice is kept in
  `localStorage` and stamped on `<html>` before the first paint.
- **Live reload.** The server stamps the page with its file time, so an open tab
  reloads itself when `chat.html` changes.
- **Safe concurrent writers.** The server, `reply.py` and the Telegram bot all
  append under an `flock`, and ids come from a high-water mark in `.seq`, so they
  never repeat, even after `chat.jsonl` is truncated.
- **A scrollable pane says so.** The detail pane and the timeline draw a visible
  scrollbar rather than the overlay one the OS fades in only after you scroll, which
  is too late to tell you there is more below.
- **Local only.** The server binds to `127.0.0.1`. The Telegram bot uses outbound
  long-polling, so nothing is exposed to the internet.
