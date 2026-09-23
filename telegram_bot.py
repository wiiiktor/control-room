#!/usr/bin/env python3
"""Telegram front-end for the same chat.jsonl bridge the web panel uses.

Long-polls Telegram from this machine, so it needs no public URL, no tunnel and
no open ports. CTRL markup becomes native inline-keyboard buttons.

    export TELEGRAM_BOT_TOKEN=123456:ABC...      (or put it in .telegram-token)
    python3 telegram_bot.py

The first person to message the bot claims it; everyone else is ignored.
"""
import json
import html
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from chat_server import ROOT, append_message, read_messages

TOKEN = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
if not TOKEN:
    tf = ROOT / ".telegram-token"
    TOKEN = tf.read_text().strip() if tf.exists() else ""
if not TOKEN:
    sys.exit("No token. Put it in .telegram-token or export TELEGRAM_BOT_TOKEN.")

API = f"https://api.telegram.org/bot{TOKEN}/"
OWNER_FILE = ROOT / ".telegram-owner"
BADGE = {"ok": "✅", "warn": "⚠️", "err": "⛔", "wait": "⏳"}

cards = {}      # card id -> [command per button]
next_card = 1
lock = threading.Lock()


def call(method, **params):
    """One Telegram API call. Returns the result, or None if the call failed."""
    data = urllib.parse.urlencode(
        {k: (json.dumps(v) if isinstance(v, (dict, list)) else v)
         for k, v in params.items() if v is not None}
    ).encode()
    try:
        with urllib.request.urlopen(API + method, data, timeout=60) as res:
            payload = json.load(res)
        return payload.get("result") if payload.get("ok") else None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None


def owner():
    return OWNER_FILE.read_text().strip() if OWNER_FILE.exists() else ""


def render(text):
    """CTRL markup -> (HTML message, inline keyboard)."""
    global next_card
    lines, buttons, stats = [], [], []

    def flush_stats():
        if stats:
            lines.append("\n".join(stats))
            stats.clear()

    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            continue
        if not line.startswith("::"):
            flush_stats()
            lines.append(html.escape(line))
            continue
        kind, _, body = line[2:].partition(" ")
        kind, body = kind.lower(), body.strip()
        esc = html.escape(body)

        if kind in ("pick", "fill"):
            label, _, cmd = body.partition("=>")
            buttons.append((label.strip(), (cmd.strip() or label.strip())))
            continue
        if kind == "kv":
            key, _, val = body.partition("=")
            stats.append(f"  <code>{html.escape(key.strip())}</code>  {html.escape(val.strip())}")
            continue
        flush_stats()
        if kind == "ask":
            lines.append(f"<b>{esc}</b>")
        elif kind == "say":
            lines.append(esc)
        elif kind == "note":
            lines.append(f"<i>{esc}</i>")
        elif kind in BADGE:
            lines.append(f"{BADGE[kind]} <b>{esc}</b>")
        else:
            lines.append(esc)
    flush_stats()

    keyboard = None
    if buttons:
        with lock:
            card = next_card
            next_card += 1
            cards[card] = [cmd for _, cmd in buttons]
        keyboard = {"inline_keyboard": [
            [{"text": f"{i + 1}. {label}", "callback_data": f"k:{card}:{i}"}]
            for i, (label, _) in enumerate(buttons)
        ]}
    return "\n\n".join(lines) or "…", keyboard


def outgoing():
    """Push every new assistant reply to the owner's chat."""
    seen = max((m["id"] for m in read_messages()), default=0)
    while True:
        time.sleep(0.6)
        chat = owner()
        if not chat:
            continue
        for msg in read_messages(seen):
            seen = max(seen, msg["id"])
            if msg["role"] != "assistant":
                continue
            body, keyboard = render(msg["text"])
            call("sendMessage", chat_id=chat, text=body,
                 parse_mode="HTML", reply_markup=keyboard)


def incoming():
    """Long-poll Telegram; every message or button press becomes a command."""
    offset = None
    while True:
        updates = call("getUpdates", offset=offset, timeout=25)
        if updates is None:
            time.sleep(2)
            continue
        for update in updates:
            offset = update["update_id"] + 1

            if "callback_query" in update:
                q = update["callback_query"]
                call("answerCallbackQuery", callback_query_id=q["id"])
                chat = str(q["message"]["chat"]["id"])
                if chat != owner():
                    continue
                try:
                    _, card, idx = q["data"].split(":")
                    command = cards.get(int(card), [])[int(idx)]
                except (ValueError, IndexError, KeyError):
                    continue
                # retire the keyboard so an old card cannot be answered twice
                call("editMessageReplyMarkup", chat_id=chat,
                     message_id=q["message"]["message_id"], reply_markup={"inline_keyboard": []})
                append_message("user", command)
                continue

            msg = update.get("message") or {}
            text = (msg.get("text") or "").strip()
            if not text:
                continue
            chat = str(msg["chat"]["id"])
            if not owner():
                OWNER_FILE.write_text(chat)
                call("sendMessage", chat_id=chat,
                     text="✅ <b>Connected</b>\n\nThis chat now controls the panel. "
                          "Type a command, or tap the buttons when they appear.",
                     parse_mode="HTML")
                if text == "/start":
                    continue
            if chat != owner():
                continue
            if text == "/start":
                call("sendMessage", chat_id=chat, text="Already connected. Send a command.")
                continue
            append_message("user", text)


if __name__ == "__main__":
    me = call("getMe")
    if not me:
        sys.exit("Telegram rejected the token, or there is no network.")
    print(f"bot @{me['username']} running — message it from your phone to claim it")
    if owner():
        print(f"owner chat already set: {owner()}  (delete .telegram-owner to reclaim)")
    threading.Thread(target=outgoing, daemon=True).start()
    incoming()
