#!/usr/bin/env bash
# Package the extension. chat.html lives here, beside the code that serves it.
set -e
cd "$(dirname "$0")"
vsce package --allow-missing-repository
ls -la *.vsix
