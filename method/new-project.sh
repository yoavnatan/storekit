#!/bin/bash
# One command to start a project. Nothing has to be installed, remembered, or copied by hand.
#
#     newproject ~/Desktop/my-idea
#
# It makes the folder, puts the working method inside it, wires the two guarantees (replies are
# checked before they reach you; Claude cannot say something works when it does not), starts a git
# repository so there is a history from the first minute, and then tells you the one thing left to
# do — open Claude there and say what you want.
#
# It copies the method from wherever THIS script lives, so there is one canonical copy and updating
# it updates every future project. The `newproject` alias is written by `install-command.sh`.
set -euo pipefail

METHOD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TARGET="${1:-}"

if [ -z "$TARGET" ]; then
  echo "Say where it should go:"
  echo "    newproject ~/Desktop/my-idea"
  exit 1
fi

# Expand ~ the way a person expects, whether or not the shell already did.
TARGET="${TARGET/#\~/$HOME}"

if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "That folder already has things in it: $TARGET"
  echo "Pick an empty folder, or a name that does not exist yet — this is for starting from nothing."
  exit 1
fi

mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "This needs Node installed, and it is not on this machine."
  echo "Install it from https://nodejs.org and run this again."
  exit 1
fi

if command -v git >/dev/null 2>&1; then
  git -C "$TARGET" init -q
fi

node "$METHOD_DIR/install.mjs" "$TARGET" >/dev/null

cat <<EOF

  Ready: $TARGET

  One thing left. Open Claude in that folder:

      cd "$TARGET"
      claude

  and say what you want to build. It will ask you four questions — in plain words,
  nothing technical — and then build it.

  While it works, two things are true and you do not have to ask for either:
  it answers the way you asked it to, and it cannot tell you something is
  finished while it is broken.

EOF
