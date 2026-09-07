#!/usr/bin/env bash
# Which branch is this session standing on, and does a push from here reach the live demonstration?
#
# `main` is what Render deploys, and the deployment is a link on the owner's CV, so "which branch am
# I on" is not a curiosity here — it is the difference between work in progress and a change to
# something people can open. The answer belongs somewhere always visible rather than in a `git
# status` somebody has to remember to run.
#
# Reads Claude Code's status JSON on stdin; prints one line.
set -uo pipefail

input=$(cat)
dir=$(printf '%s' "$input" | sed -n 's/.*"current_dir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$dir" ] || dir=$PWD

branch=$(git -C "$dir" branch --show-current 2>/dev/null)
[ -n "$branch" ] || branch=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null) || branch='no repo'

dirty=''
[ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ] && dirty=' ●'

if [ "$branch" = 'main' ]; then
  # Red, and it says what a push DOES rather than what the branch is called: "main" is only
  # alarming to somebody who already remembers what main is wired to.
  printf '\033[31m⚠ main — a push deploys the live demo\033[0m%s' "$dirty"
else
  printf '\033[32m%s\033[0m — safe, Render only builds main%s' "$branch" "$dirty"
fi
