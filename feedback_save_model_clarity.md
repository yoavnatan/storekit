---
name: feedback_save_model_clarity
description: "Don't mix a manual \"save changes\" form with live-saving widgets under one ambiguous header — visually flag the auto-saving sections"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 80253ed2-4e8e-494a-8546-acd999ca7cef
  modified: 2026-07-26T15:20:23.964Z
---

When one view mixes a manual-submit form (explicit "save changes" button) with widgets that save live per-action (AJAX → own API), make the boundary visually obvious. The user hit this on the seller dashboard Settings tab — "how can I add a category without saving?!" — because the sticky "save changes" bar visually hovered over the Categories tree + Custom-domain sections, which actually save live.

**Why:** an ambiguous save button that appears to govern auto-saving sections erodes trust ("did my change persist?") and reads as a bug.

**How to apply:** keep the sticky save header's sticky scope bounded to its own `<form>` (so it releases at the form's end, not over sibling live-widgets), and badge each auto-saving section with `settingsAutoSaved` ("נשמר אוטומטית"). Chosen "separate visually" over splitting into tabs or making everything live. See [[feedback_ajax_forms]].
