#!/bin/bash
# PostToolUse (Edit|Write) — every time a legacy CSS file (or a page that owns a <style is:global>
# block) is touched, re-inject the "convert on contact" rule so it isn't relying on the session having
# read AI_INSTRUCTIONS.md carefully. Non-blocking: informational only.
#
# This hook also OWNS the worked examples behind the rule (moved here 2026-07-31): they are only ever
# needed at this exact moment, and in the always-read file they were costing every session — including
# the ones that never touch CSS — a read it had no use for.
json=$(cat)
f=$(echo "$json" | jq -r '.tool_input.file_path // .tool_response.filePath // ""')

read -r -d '' RULE <<'TXT'
Reminder — AI_INSTRUCTIONS.md hard rule: this file is on the legacy-CSS list. Tailwind v4 only;
convert the classes you are already touching, and nothing else (no dedicated conversion session, no
touching unrelated classes just to convert them).

The rule was sharpened 2026-07-28 because it read as universal, so it got silently skipped whenever
it did not apply — and then skipped when it did. CONVERT a rule you touched when it is a plain style
on an element the component actually renders: spacing, colour, radius, border, a simple flex/grid box.

LEAVE AS CSS — this is not a failure to convert:
 (a) A descendant selector whose target the component does not own. `.home-shelf .store-card` moved
     onto StoreCard would apply everywhere that component is used, not just in the shelf.
 (b) tokens.css, and any @theme / custom-property declaration.
 (c) @keyframes, and ::before/::after carrying real geometry.
 (d) A value needing a multi-part calc()/clamp() over custom properties — escaped into bracket
     syntax it becomes unreadable, and unreadable beats un-migrated.
 (e) Anything a :has() / [dir=rtl] / .is-stuck state selector drives.
 (f) A value another UNLAYERED legacy class on the SAME element also sets: the utility loses and
     needs `!`, which is worse than leaving it. Hit 2026-07-28 — `.store-controls`'s
     margin-bottom:1rem beat an `mb-6` utility on the same element, and the conversion was reverted.

Before converting a per-page <style> block, read AI_INSTRUCTIONS.md -> Hard rules -> "main.css is
global": such a block already gets its own per-route chunk, so converting it moves weight into the
one shared Tailwind output loaded everywhere and can INCREASE the global bundle.

Keep a class's name in the markup as an empty marker (no CSS) if any JS does querySelector/closest
on it — strip only the CSS, never the classname. And when you skip a conversion for one of the
reasons above, say so in the session summary; that is what stops this rule from rotting again.

WHAT IS STILL LEGACY, and it is only these four files:
 • pages/dashboard.css — four sections left: the gallery/preview box; the products-table core
   including its sticky headers; the mobile card layout; and `.dash-tabs` / `.dash-panel` /
   `.dash-head` / `.card`, which admin.css depends on DIRECTLY. Never touch that last group
   without checking the admin panel components first.
 • pages/store.css — 103 classes, not yet scanned.
 • seller/dashboard.astro's <style is:global> — blocked until the admin class-sharing above is
   resolved.
 • buyer/dashboard.astro's <style>.
(The old "stray hex in StoreAvatar.astro / index.astro" item is done — both verified at 0 hexes
on 2026-07-28.)
TXT

case "$f" in
  *src/styles/pages/dashboard.css|*src/styles/pages/store.css|*seller/dashboard.astro|*buyer/dashboard.astro)
    jq -n --arg ctx "$RULE" \
      '{hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:$ctx}}'
    ;;
esac
