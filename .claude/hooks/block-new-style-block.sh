#!/bin/bash
# PreToolUse (Edit) — enforces AI_INSTRUCTIONS.md hard rule:
# "Tailwind v4 only — no new CSS files or <style> blocks."
# Flags an Edit that introduces a brand-new <style> tag into a file that
# didn't have one in the text being replaced (existing <style> blocks may
# still be edited — this only blocks adding a new one).
json=$(cat)
f=$(echo "$json" | jq -r '.tool_input.file_path // ""')

if [[ "$f" == *.astro || "$f" == *.html ]]; then
  old=$(echo "$json" | jq -r '.tool_input.old_string // ""')
  new=$(echo "$json" | jq -r '.tool_input.new_string // ""')
  if [[ "$new" == *"<style"* && "$old" != *"<style"* ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by hard rule (AI_INSTRUCTIONS.md): Tailwind v4 only — no new <style> blocks. Use Tailwind utility classes in the markup instead."}}'
  fi
fi
