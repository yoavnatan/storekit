#!/usr/bin/env bash
# One-command setup for Claude Code memory on a new machine.
#
# THE WHOLE NEW-MACHINE PROCEDURE, since this script is step 2 of four and the other three are easy
# to forget at the moment they matter:
#
#   git clone https://github.com/yoavnatan/storekit.git && cd storekit
#   bash scripts/setup-claude-memory.sh     # this file
#   cp <from wherever you kept it> .env     # the only manual step — see step 4 below
#   npm ci
#
# What this script does:
#   1. Clones (or updates) the PRIVATE memory repo into ./.claude-memory
#   2. Symlinks the harness memory path -> ./.claude-memory so every
#      Claude Code session reads the same memory that travels via git.
#   3. Enables the versioned git hooks (.githooks) so future `git push`
#      of this repo also auto-pushes memory.
#   4. Restores .claude/settings.local.json (this machine's permission grants) from the memory repo.
#
# What NOTHING restores, and is therefore the real single point of failure: `.env`. It is gitignored
# in both repos deliberately — the code repo is meant to be publishable — so the values have to come
# from a password manager, or be reissued from the Neon / Google Cloud / Cloudinary consoles.
# `.env.example` lists which keys are needed. The script says so on its way out if the file is
# absent, and `tests/handoff-backup.test.ts` pins that it does.
#
# Chat transcripts are NOT part of this and are not meant to be: `MEMORY.md`, `AI_INSTRUCTIONS.md`
# and `CURRENT_TASK.md` are the deliberate substitute for them, which is the reason anything worth
# carrying between sessions gets written down there in the session that learned it.
#
# Prereqs: git + gh (or https access) authenticated to GitHub.
# Usage:   bash scripts/setup-claude-memory.sh
set -euo pipefail

# Overridable so `tests/handoff-backup.test.ts` can point it at a local bare repo and exercise this
# file itself rather than a copy of it. Nothing else sets it.
MEMORY_REMOTE="${MEMORY_REMOTE:-https://github.com/yoavnatan/storekit-memory.git}"

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

# 4. Restore this machine's Claude permission grants ---------------------
# The other half of the backup added to `.githooks/pre-push` on 2026-08-09. Without it, a new
# machine starts with no `.claude/settings.local.json` and re-asks for every permission the old one
# had already granted.
#
# Never overwrites an existing file. On a machine that has been used for a while, the local file is
# the current truth and the backup is a snapshot from the last push — restoring over it would throw
# away grants made since. This step is for a fresh checkout, and only for a fresh checkout.
BAK="$MEM/settings.local.json.bak"
LOCAL_SETTINGS="$REPO_ROOT/.claude/settings.local.json"
if [ ! -f "$BAK" ]; then
  echo "==> No settings.local.json.bak in the memory repo — nothing to restore"
elif [ -f "$LOCAL_SETTINGS" ]; then
  echo "==> Kept existing .claude/settings.local.json (backup left untouched)"
else
  mkdir -p "$(dirname "$LOCAL_SETTINGS")"
  cp "$BAK" "$LOCAL_SETTINGS"
  echo "==> Restored .claude/settings.local.json from the memory repo"
fi

# 5. The one thing nothing restores, and what to do about it -------------
#
# `.env` is in neither repo on purpose. Backing it up alongside memory was considered on 2026-08-09
# and turned down by the owner for the better reason: every value in it can be reissued, so storing
# the secrets in a second place would buy convenience at the cost of a second place they can leak
# from. Nothing here is unrecoverable — that is a property worth keeping true, and a check to make
# before adding any new variable.
#
#   DATABASE_URL          Neon console → the POOLED connection string. The data lives in Neon, so
#                         a lost URL costs the URL and nothing else.
#   GOOGLE_CLIENT_*       Google Cloud → APIs & Services → Credentials → issue a new client secret.
#   PUBLIC_CLOUDINARY_*   Cloudinary dashboard. Not secrets at all — they ship in the browser bundle.
#   ADMIN_SECRET          Pick a new long random string.
#   AUTH_SECRET           Pick a new one too, and know what it does: it signs seller session
#                         cookies, so changing it signs every seller out. Annoying after launch,
#                         free before it.
#
# So this prints where to go rather than only that something is missing — the gap between those two
# is the whole distance between a five-minute recovery and an afternoon of guessing.
if [ ! -f "$REPO_ROOT/.env" ]; then
  cat <<'ENVHELP'

────────────────────────────────────────────────────────────────────────
  ONE THING LEFT: .env

  It is in no repo, on purpose. Nothing in it is lost for good — every
  value can be reissued. Do this:

    1.  cp .env.example .env

    2.  Open .env and fill in five values:

        DATABASE_URL              Neon console → Connection string.
                                  Pick the POOLED one (host has "-pooler").

        GOOGLE_CLIENT_ID          Google Cloud console → APIs & Services
        GOOGLE_CLIENT_SECRET      → Credentials → your OAuth client.
                                  Issue a new secret if you cannot see it.

        PUBLIC_CLOUDINARY_CLOUD_NAME      Cloudinary dashboard.
        PUBLIC_CLOUDINARY_UPLOAD_PRESET   Not secrets — safe to copy.

    3.  npm ci && npm run dev

  Everything else in .env.example is optional and can stay empty; the
  file explains each one where it sits.
────────────────────────────────────────────────────────────────────────
ENVHELP
fi

echo "Done. Verify: $(head -1 "$LINK/MEMORY.md")"
