#!/usr/bin/env bash
# Package the extension. chat.html is copied in, so the .vsix works in any workspace
# and cannot drift from the browser version by accident.
set -e
cd "$(dirname "$0")"
cp ../chat.html ./chat.html
vsce package --allow-missing-repository
ls -la *.vsix
