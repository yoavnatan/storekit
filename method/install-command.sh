#!/bin/bash
# Run this ONCE per machine:
#
#     bash method/install-command.sh
#
# After it, `newproject <folder>` works in any terminal, from anywhere, forever. It copies the method
# to a canonical place (~/.claude/method) so future projects do not depend on this repository still
# existing at this path, and adds one alias line to the shell profile.
#
# Re-running it updates the canonical copy — which is the point: fix a rule once, and every project
# started afterwards has the fix.
set -euo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
CANON="$HOME/.claude/method"

mkdir -p "$HOME/.claude"
rm -rf "$CANON"
cp -R "$SOURCE" "$CANON"
rm -f "$CANON/.verify-cache.json"
chmod +x "$CANON/new-project.sh"

ALIAS_LINE="alias newproject='bash \"\$HOME/.claude/method/new-project.sh\"'"

# Written to whichever profile the machine's shell actually reads. Both, when both exist — a person
# who switches shells should not discover the command has vanished.
added=""
for profile in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [ -f "$profile" ] || continue
  if grep -q "alias newproject=" "$profile" 2>/dev/null; then
    added="$added\n  $profile — already there"
  else
    printf '\n# Start a project with the working method already in it.\n%s\n' "$ALIAS_LINE" >> "$profile"
    added="$added\n  $profile — added"
  fi
done

if [ -z "$added" ]; then
  printf '\n%s\n' "$ALIAS_LINE" >> "$HOME/.zshrc"
  added="\n  $HOME/.zshrc — created"
fi

cat <<EOF

  Installed.
$(printf "$added")

  Open a NEW terminal window (the alias only exists in windows opened after now), then:

      newproject ~/Desktop/my-idea

  That is the whole thing. It makes the folder, puts the method in it, and tells you
  to open Claude there and say what you want.

EOF
