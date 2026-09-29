#!/usr/bin/env bash
# Generate the Windows build from extension/ and package it. Never writes to extension/.
# Runs in Git Bash on Windows: there is no `python3` there and vsce is rarely installed globally.
set -e
cd "$(dirname "$0")"
PY=$(command -v python3 >/dev/null 2>&1 && python3 -c 'pass' 2>/dev/null && echo python3 || echo python)
PYTHONIOENCODING=utf-8 "$PY" make.py
cd build
npx --yes @vscode/vsce package --allow-missing-repository
ls -la *.vsix
