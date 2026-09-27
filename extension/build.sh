#!/usr/bin/env bash
# Package the extension. The room's Python side is copied in: the .vsix has to carry it,
# because a machine that installs the extension may have no clone of this repository.
set -e
cd "$(dirname "$0")"
mkdir -p runtime
cp ../chatlog.py ../reply.py ../status.py ../watch.py ../request.py runtime/
vsce package --allow-missing-repository
ls -la *.vsix
