#!/usr/bin/env bash
# Generate the Windows build from extension/, give it the next Windows version, package it, and
# leave exactly ONE .vsix in extension-win/ -- the one get.sh installs. Never writes to extension/.
# Runs in Git Bash on Windows: there is no `python3` there and vsce is rarely installed globally.
set -e
cd "$(dirname "$0")"
PY=$(command -v python3 >/dev/null 2>&1 && python3 -c 'pass' 2>/dev/null && echo python3 || echo python)
PYTHONIOENCODING=utf-8 "$PY" make.py --bump
cd build
npx --yes @vscode/vsce package --allow-missing-repository
VSIX=$(ls -t control-room-win-*.vsix | head -1)
cd ..
rm -f control-room-win-*.vsix
cp "build/$VSIX" .
ls -la control-room-win-*.vsix
echo "commit extension-win/version.json and extension-win/$VSIX together"
