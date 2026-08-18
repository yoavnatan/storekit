#!/bin/bash
# PreToolUse(Bash) — the four git commands that have actually destroyed another session's work here.
#
# Why a hook and not a rule. All four are written down in memory `feedback_parallel_sessions` and
# `project_prepush_hook_wiped_worktree`, and being written down is exactly what failed: each one was
# typed by a session that had read the note, in the minute it was in a hurry, and none of them
# announced what it had done. Their common shape is that git reports SUCCESS — the work is gone from
# the tree, the commit looks ordinary, and the only symptom arrives hours later when somebody asks
# where a module went. A guard that fires at the moment of the command is the only kind that helps.
#
# Every block below names the safe way to get the same thing, because a block with no exit just
# teaches the next session to work around it.
#
#   1. `git update-ref refs/heads/main <branch>` — ASSIGNMENT, not a fast-forward. Used once because
#      `git push . HEAD:main` had timed out, and it silently dropped another session's merge (2026-08-06;
#      recovered only because every commit was still reachable). `git merge --ff-only` refuses instead
#      of discarding, which is the whole difference.
#   2. `git push .` — pushing into the repo you are standing in. Deleted 867 files
#      (`project_prepush_hook_wiped_worktree`). Nothing needs it: main is advanced with `merge --ff-only`
#      from the main checkout.
#   3. `git checkout <ref> -- .` — meant as "let me look at the base", it overwrote the whole working
#      tree including files from another session that did not exist on that ref (2026-08-05). Reading a
#      ref never needs the working tree: `git show <ref>:<path>`, `git diff <ref>`, `git log <ref>`.
#      The path-by-path form (`git checkout <sha> -- src/foo.ts`) is NOT blocked — that is how the
#      2026-08-06 incident was repaired, and it touches only what it names.
#   4. `git commit -a` / `git add -A` from a tree that is missing tracked files. This is the one that
#      cost the most and looked the most normal: a session committed a docs change from a checkout whose
#      HEAD had moved under it, so the commit's TREE carried the old state of 24 files — four test
#      suites and a whole module came back OUT, on main, under a message about a document. The
#      signature is that files HEAD contains are absent from disk. A deliberate deletion looks the same
#      to git, so this blocks the SWEEPING forms only and tells you to name what you are deleting.
#
# Deliberately NOT blocked: `git reset --hard` (already permission-gated here), `git checkout -- .`
# with no ref (discards only uncommitted work, which is the session's own), and `git push origin main`
# (the pre-push hook runs verify and is the real gate).
set -uo pipefail

payload="$(cat 2>/dev/null || true)"

# cwd FIRST because it is always one line; the command follows and may be many (a heredoc is a
# normal thing to pass to Bash, and slicing it by line 1 would hide everything after the first).
parsed="$(printf '%s' "$payload" | python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: d = {}
print(str(d.get("cwd") or "").splitlines()[0] if d.get("cwd") else "")
print((d.get("tool_input") or {}).get("command", "") or "")' 2>/dev/null || printf '\n\n')"

hook_cwd="$(printf '%s' "$parsed" | sed -n '1p')"
[ -d "$hook_cwd" ] || hook_cwd="$PWD"

cmd="$(printf '%s' "$parsed" | sed '1d')"
[ -n "$cmd" ] || exit 0

# Only ever interested in git.
printf '%s' "$cmd" | grep -q '\bgit\b' || exit 0

# First non-flag argument of `git <sub>`, or '' if the subcommand is not there. Done in python and
# not in sed: BSD sed (which is what macOS ships) has no `\b`, so the obvious one-liner silently
# matched nothing and every rule below reported the subcommand name as its own argument.
first_arg_of() {
  printf '%s' "$cmd" | python3 -c 'import shlex, sys
sub = sys.argv[1]
for line in sys.stdin.read().splitlines():
    try: toks = shlex.split(line, comments=False)
    except ValueError: toks = line.split()
    if sub not in toks: continue
    for t in toks[toks.index(sub) + 1:]:
        if t in (";", "&&", "||", "|"): break
        if t.startswith("-"): continue
        print(t); sys.exit(0)
sys.exit(0)' "$1" 2>/dev/null || echo ""
}

deny() {
  python3 - "$1" <<'PY'
import json, sys
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": sys.argv[1],
    }
}))
PY
  exit 0
}

# ── 1. update-ref onto a branch ────────────────────────────────────────────────
# Blocks `refs/heads/<x>` and a bare branch name (which resolves to one). `refs/rescue/<name>` is
# the ANCHOR memory tells a session to save before any ref surgery — it creates a ref, never moves
# a branch, so it stays allowed.
if printf '%s' "$cmd" | grep -Eq '\bgit\b[^;&|]*\bupdate-ref\b'; then
  target="$(first_arg_of update-ref)"
  case "$target" in
    refs/rescue/*|refs/tags/*|'') ;;
    refs/heads/*|refs/remotes/*)
      deny "\`git update-ref $target\` is an ASSIGNMENT, not a fast-forward — it moves the branch wherever you point it and silently discards whatever it gained meanwhile. That is how another session's merge was lost on 2026-08-06. To advance main: \`git merge --ff-only <branch>\` from the main checkout, which REFUSES rather than discards. If you must do ref surgery, save \`git update-ref refs/rescue/<name> <sha>\` anchors first (still allowed) and check \`git merge-base --is-ancestor main <branch>\`."
      ;;
    *)
      deny "\`git update-ref $target\` names a bare ref, which resolves to a branch — an assignment that discards whatever that branch gained meanwhile (lost a merge on 2026-08-06). Use \`git merge --ff-only <branch>\`, which refuses instead. \`refs/rescue/<name>\` anchors are still allowed."
      ;;
  esac
fi

# ── 2. pushing into a local path (including the repo you are in) ───────────────
if printf '%s' "$cmd" | grep -Eq '\bgit\b[^;&|]*\bpush\b'; then
  remote="$(first_arg_of push)"
  case "$remote" in
    .|..|/*|./*|../*|~*)
      deny "\`git push $remote\` pushes into a local checkout — this deleted 867 files here (memory \`project_prepush_hook_wiped_worktree\`), because a push into a repository with a working tree does not update that tree. Nothing needs it: advance main with \`git merge --ff-only <branch>\` from the main checkout, and push to the REMOTE with \`git push origin main\`."
      ;;
  esac
fi

# ── 3. reading a ref by overwriting the working tree ───────────────────────────
# `git checkout <ref> -- .` / `git restore --source=<ref> .` — the whole-tree forms. A named path is
# the repair tool and stays allowed.
if printf '%s' "$cmd" | grep -Eq '\bgit\b[^;&|]*\bcheckout\b[^;&|]+ -- +\.( |$|[;&|])'; then
  if ! printf '%s' "$cmd" | grep -Eq '\bcheckout +-- +\.'; then
    deny "\`git checkout <ref> -- .\` overwrites the ENTIRE working tree with that ref, including files another session is holding that do not exist on it — that is what happened on 2026-08-05, and the worktree isolation could not help because the command undid it. To READ a ref, nothing has to touch the tree: \`git show <ref>:<path>\`, \`git diff <ref>\`, \`git log <ref>\`. To REPAIR from a ref, name the paths — \`git checkout <sha> -- src/foo.ts\` is not blocked."
  fi
fi
if printf '%s' "$cmd" | grep -Eq '\bgit\b[^;&|]*\brestore\b[^;&|]*--source[= ][^ ]+[^;&|]* \.( |$|[;&|])'; then
  deny "\`git restore --source=<ref> .\` overwrites the entire working tree from that ref — the same operation that wiped another session's files on 2026-08-05. Read a ref with \`git show <ref>:<path>\` / \`git diff <ref>\`; restore by naming the paths."
fi

# ── 4. a sweeping commit from a tree that is missing tracked files ─────────────
# Gated behind the command pattern so the git call below runs on a commit, not on every Bash tool
# use in the session.
if printf '%s' "$cmd" | grep -Eq '\bgit\b[^;&|]*(\bcommit\b[^;&|]*(-[a-zA-Z]*a|--all)|\badd\b[^;&|]*(-A|--all|-u|--update| +\.( |$)))'; then
  # `-C` is not enough: git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE into every hook it runs,
  # and those BEAT the directory you hand a child (tests/helpers/git-env.ts — it cost an evening in
  # this repo on 2026-08-17). A guard that reads the wrong repository would block the innocent case
  # and miss the real one, so strip them here rather than trusting whoever invoked us.
  missing="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \
    -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_PREFIX -u GIT_COMMON_DIR -u GIT_NAMESPACE \
    git -C "$hook_cwd" diff HEAD --name-only --diff-filter=D 2>/dev/null | head -40)"
  count="$(printf '%s' "$missing" | grep -c . || true)"
  if [ "${count:-0}" -ge 3 ]; then
    names="$(printf '%s' "$missing" | head -8 | sed 's/^/  /')"
    more=""
    [ "$count" -gt 8 ] && more="
  …and $((count - 8)) more"
    deny "$count files that HEAD contains are MISSING from this working tree, and you are about to sweep everything on disk into a commit. If you did not delete them, this checkout is STALE — HEAD moved under it (another session merged) and the tree still holds the old state, so the commit's TREE will revert every one of them on main. That is exactly what happened on 2026-08-06: 24 files, four test suites and a whole module taken back out under a commit message about a document, with nothing warning about it.
$names$more

Check \`git status\` and \`git log\` first. If they really should go, delete them by name (\`git rm <paths>\`) or stage the paths you mean individually — the sweeping forms (\`-a\`, \`-A\`, \`-u\`, \`add .\`) are the only ones blocked here."
  fi
fi

exit 0
