---
name: project_hidden_input_silent_writes
description: "Assigning .value fires no event, so any UI built on edit events lies about widget-written hidden fields — route every programmatic write through announceValueChange"
metadata: 
  node_type: memory
  type: project
  originSessionId: bbab661f-8f8c-43e8-be67-9a4aeee14a87
  modified: 2026-08-05T14:25:07.285Z
---

`input.value = x` fires **nothing** — no `input`, no `change`, and no attribute mutation a
MutationObserver could see (the attribute is the DEFAULT value, not the current one). So every widget
that writes a hidden field is invisible to anything listening for edits.

**Where it bit (2026-08-05):** the seller dashboard grew an unsaved-changes notice driven by
`scripts/dashboard/unsaved-guard.ts`. It worked for typing and went silent for the store-image
cropper, the category pickers, the product multi-picker and the gallery's slot URLs — a notice that
shows for one widget and not the next is worse than none.

**How to apply:** any programmatic write to a form field goes through
`announceValueChange(input)` in `unsaved-guard.ts`, which dispatches the platform's own bubbling
`input` event. Not a private event name — anything already listening for edits is then served for
free. `tests/unsaved-notice.test.ts` fails if a script hand-rolls `dispatchEvent(new Event('input'…))`
again (category-picker had grown two copies).

Switching dashboard tabs loses nothing (panels are hidden, not destroyed), so the notice ANSWERS
"did I save that" rather than preventing loss; `beforeunload` stays the last resort and cannot be
styled. See [[feedback_save_model_clarity]], [[feedback_noop_interactions_invisible]].

**The notice is a SENTENCE, and a tab marker was rejected — don't rebuild one.** A `--color-warning`
dot on the tab was built first; the owner read it as "something waiting to be dealt with", because the
messages tab already owns that exact 7px corner dot for unread messages. He then closed the whole
design space: *"תחשוב על מוכר שאין לו מושג במוסכמות של עורכים... וכל סימן כזה או אחר יכול רק לבלבל
אותו"* — so no glyph, no colour code, in that corner. `UnsavedChangesBar.astro` names the section in
words, taking the name from the tab's own label at runtime so the two cannot drift. Its button goes to
the save button and focuses it; it never submits a form the seller cannot see.
