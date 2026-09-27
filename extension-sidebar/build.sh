#!/usr/bin/env bash
# Package the SIDEBAR extension. The room's Python side is copied in: the .vsix has to carry
# it, because a machine that installs the extension may have no clone of this repository.
#
# ⛔ This is not ../extension/build.sh with a different cd. The two are separate codebases
# and each packages only its own folder; running one from the other's directory produces a
# vsix with the wrong manifest in it.
set -e
cd "$(dirname "$0")"
mkdir -p runtime
cp ../chatlog.py ../reply.py ../status.py ../watch.py runtime/
vsce package --allow-missing-repository
ls -la *.vsix
