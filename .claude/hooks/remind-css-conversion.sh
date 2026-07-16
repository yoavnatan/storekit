#!/bin/bash
# PostToolUse (Edit|Write) — every time a legacy CSS file (or a page that
# owns a <style is:global> block) is touched, re-inject the "convert on
# contact" rule so it isn't relying on the session having read
# AI_INSTRUCTIONS.md carefully. Non-blocking: informational only.
json=$(cat)
f=$(echo "$json" | jq -r '.tool_input.file_path // .tool_response.filePath // ""')

case "$f" in
  *src/styles/pages/dashboard.css|*src/styles/pages/store.css|*seller/dashboard.astro|*buyer/dashboard.astro)
    echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Reminder — AI_INSTRUCTIONS.md hard rule: this file is on the legacy-CSS list. Tailwind v4 only; convert the classes you are already touching to Tailwind utilities on contact (no dedicated conversion session, no touching unrelated classes just to convert them). Check AI_INSTRUCTIONS.md → Hard rules → Tailwind v4 only for this file'\''s specific gotchas before proceeding."}}'
    ;;
esac
