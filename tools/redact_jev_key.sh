#!/usr/bin/env bash
# Remove the Jev key from every log on this machine that contains it.
# Run it yourself: Claude is not allowed to rewrite the room log or search for credentials.
set -eu
K=$(cat ~/.jev-key)                      # the key, read from the file rather than typed again
[ ${#K} -gt 20 ] || { echo "~/.jev-key looks wrong"; exit 1; }
FILES=$(grep -rl --binary-files=text -F "$K" \
          ~/.claude/projects/-home-wii-Projects-certain/ \
          ~/Projects/certain/control-room/chat.jsonl 2>/dev/null || true)
[ -n "$FILES" ] || { echo "not found in any log"; exit 0; }
echo "$FILES" | while read -r f; do cp -n "$f" "$f.bak-jev" 2>/dev/null || true; done
echo "$FILES" | xargs -r sed -i "s|$K|[JEV KEY REDACTED]|g"
echo "redacted in:"; echo "$FILES"
echo "backups written alongside as *.bak-jev -- delete them once you are happy"
