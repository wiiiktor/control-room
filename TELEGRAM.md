# Telegram front-end

Same bridge, second face. [telegram_bot.py](telegram_bot.py) reads and writes the
same `chat.jsonl` as the web panel, so both can run at once and `reply.py` is
unchanged.

**No public URL, no tunnel, no open ports.** The bot long-polls Telegram's
servers from this machine, so it works with the laptop behind any firewall.

## Setup (about two minutes)

1. On your phone, open Telegram and message **@BotFather**.
2. Send `/newbot`, give it a name and a username ending in `bot`.
3. BotFather replies with a token like `8123456789:AAF...`. Save it:

   ```bash
   cd control-room
   printf '%s' 'PASTE_TOKEN_HERE' > .telegram-token
   chmod 600 .telegram-token
   ```

4. Start the bot:

   ```bash
   python3 telegram_bot.py
   ```

5. Message your new bot anything from your phone. The **first chat to write
   claims the bot**; every other chat is ignored from then on. To hand it to a
   different chat, delete `.telegram-owner` and message it again.

## How the markup maps

| CTRL markup | In Telegram |
|---|---|
| `::ask` | bold line |
| `::say` | plain paragraph |
| `::note` | italics |
| `::kv k = v` | indented `k` in monospace, value beside it |
| `::ok` `::warn` `::err` `::wait` | ✅ ⚠️ ⛔ ⏳ prefix, bold |
| `::pick label => cmd` | numbered inline-keyboard button, sends `cmd` |
| `::fill` | same as `::pick` (Telegram cannot pre-fill the composer) |

Tapping a button sends the command **and strips the keyboard from that message**,
so an old card cannot be answered twice — the same rule the web panel uses.

## Running both faces

```bash
python3 chat_server.py    # web panel on localhost:8000
python3 telegram_bot.py   # phone
```

Writes from both processes are serialised with an `flock` on the log, so ids
never collide. A message sent from the phone appears in the web panel and vice
versa.

The bot does **not** need `chat_server.py` running — it writes to the log
directly. Only the browser panel needs the HTTP server.

## Security notes

- `.telegram-token` is a password. Anyone holding it controls the bot.
- The owner lock means a stranger who finds the bot username gets silence.
- Nothing is exposed to the internet: outbound polling only.
