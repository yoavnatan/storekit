#!/usr/bin/env bash
# One-command setup for Claude Code memory on a new machine.
#
# What it does:
#   1. Clones (or updates) the PRIVATE memory repo into ./.claude-memory
#   2. Symlinks the harness memory path -> ./.claude-memory so every
#      Claude Code session reads the same memory that travels via git.
#   3. Enables the versioned git hooks (.githooks) so future `git push`
#      of this repo also auto-pushes memory.
#
# Prereqs: git + gh (or https access) authenticated to GitHub.
# Usage:   bash scripts/setup-claude-memory.sh
set -euo pipefail

MEMORY_REMOTE="https://github.com/yoavnatan/storekit-memory.git"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MEM="$REPO_ROOT/.claude-memory"

# 1. Clone or update the memory repo -------------------------------------
if [ -d "$MEM/.git" ]; then
  echo "==> Updating existing memory checkout"
  git -C "$MEM" pull --ff-only
else
  echo "==> Cloning memory repo into .claude-memory"
  rm -rf "$MEM"
  git clone "$MEMORY_REMOTE" "$MEM"
fi

# 2. Recreate the harness symlink ----------------------------------------
# Claude Code derives the project slug by replacing every non-alphanumeric
# character in the absolute project path with a dash.
SLUG="$(printf '%s' "$REPO_ROOT" | perl -CS -pe 's/[^A-Za-z0-9]/-/g')"
LINK_DIR="$HOME/.claude/projects/$SLUG"
LINK="$LINK_DIR/memory"
mkdir -p "$LINK_DIR"

if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  echo "==> Existing real memory dir found — backing up to ${LINK}.local-backup"
  mv "$LINK" "${LINK}.local-backup"
fi
rm -f "$LINK"
ln -s "$MEM" "$LINK"
echo "==> Linked $LINK -> $MEM"

# 3. Enable versioned hooks (auto-push memory on git push) ---------------
git -C "$REPO_ROOT" config core.hooksPath .githooks
chmod +x "$REPO_ROOT/.githooks/"* 2>/dev/null || true
echo "==> Enabled .githooks (core.hooksPath)"

echo "Done. Verify: $(head -1 "$LINK/MEMORY.md")"
