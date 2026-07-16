#!/bin/bash
# PreToolUse (Write) — enforces AI_INSTRUCTIONS.md hard rule:
# "Tailwind v4 only — no new CSS files or <style> blocks."
json=$(cat)
f=$(echo "$json" | jq -r '.tool_input.file_path // ""')

if [[ "$f" == *.css && ! -f "$f" ]]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by hard rule (AI_INSTRUCTIONS.md): Tailwind v4 only — no new CSS files. Use Tailwind utility classes, or edit an existing CSS file that this change already touches for a real feature."}}'
  exit 0
fi

if [[ "$f" == *.astro && ! -f "$f" ]]; then
  echo "$json" | jq -r '.tool_input.content // ""' > /tmp/.claude-hook-newfile-content.tmp
  if grep -q '<style' /tmp/.claude-hook-newfile-content.tmp 2>/dev/null; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by hard rule (AI_INSTRUCTIONS.md): Tailwind v4 only — no new <style> blocks. Use Tailwind utility classes in the markup instead."}}'
  fi
  rm -f /tmp/.claude-hook-newfile-content.tmp
fi
