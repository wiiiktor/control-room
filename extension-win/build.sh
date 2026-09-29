#!/usr/bin/env bash
# Generate the Windows build from extension/ and package it. Never writes to extension/.
set -e
cd "$(dirname "$0")"
python3 make.py
cd build
vsce package --allow-missing-repository
ls -la *.vsix
