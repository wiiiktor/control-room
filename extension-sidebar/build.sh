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
# ⛔ ONE PAGE, NOT TWO. chat.html was a copy here, and it silently fell four releases behind:
# every change went into ../extension/chat.html while this one kept serving the old splash, so
# a reader looking at the sidebar saw "zero difference" from four consecutive releases. The page
# talks only to /api/*, and both extensions serve exactly the same routes, so it is host-
# agnostic and there is no reason for a second copy to exist. Copied at package time; editing
# the file in this folder is pointless because the next build overwrites it.
cp ../extension/chat.html chat.html
vsce package --allow-missing-repository
ls -la *.vsix
