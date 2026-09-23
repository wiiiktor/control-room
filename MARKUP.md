# CTRL markup

Every assistant reply is written in this line-oriented markup. [chat.html](chat.html)
renders it as large UI elements, and [telegram_bot.py](telegram_bot.py) renders it
as formatted messages with buttons. One directive per line.

The web console has two columns. The **left** holds the current reply and always
fits one screen: each new reply replaces it, and the previous command survives only
as a small "you said" breadcrumb. The **right** is a detail pane that shows whatever
card you open, and it may scroll.

| Directive | Renders as |
|---|---|
| `::ask <text>` | headline question — the one thing to decide |
| `::say <text>` | lead statement — the summary in one sentence |
| `::note <text>` | small grey detail line |
| `::kv <key> = <value>` | stat box; consecutive ones tile into a grid |
| `::ok <text>` | green status pill |
| `::warn <text>` | amber status pill |
| `::err <text>` | red status pill |
| `::wait <text>` | neutral pending pill |
| `::pick <label>` | big choice button — clicking sends `<label>` as a user message |
| `::pick <label> => <cmd>` | choice button showing `<label>`, sending `<cmd>` |
| `::fill <text>` | button that pre-fills the composer instead of sending |
| `::chart <title> = v1,v2,…` | line chart of the numbers, scaled to its own min/max; the last point is marked and min/last/max are printed under it |
| `::html <fragment>` | that one line injected as real HTML — the escape hatch for a table, an image or a shape the directives do not cover |
| `::html` … `::endhtml` | the same, for a fragment spanning several lines (the opening `::html` must carry no text) |
| `::card <title>` … `::endcard` | tile; clicking it shows everything between in the right pane |

Bare (non-`::`) lines render as plain text, so nothing is lost if a directive is
malformed.

## Rules

- Consecutive `::card`, `::kv` and `::pick` lines each group into a grid.
- A card body is ordinary markup rendered by the same renderer, so it can hold
  statements, stats, badges and its own choices, and cards may nest.
- Consecutive `::pick` lines get number badges; pressing `1`–`9` activates them
  while the composer is empty. While a card is open, the numbers drive **its**
  choices. `Esc` closes the card.
- Clicking a choice is identical to typing it: same `POST /api/send`, same entry
  in `chat.jsonl`.

## Example

```
::ok Tests pass — 41/41
::ask Ship it?
::kv Changed = 3 files, +82 −14
::card Auth middleware
::say Rewritten to verify the token before the session lookup.
::note The old order let an expired session touch the database.
::pick Show the diff => diff auth
::endcard
::pick Ship to staging => deploy staging
::pick Run the full suite first
```
