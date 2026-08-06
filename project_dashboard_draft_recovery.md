---
name: project_dashboard_draft_recovery
description: "Seller dashboard keeps a LOCAL draft of every guarded form while it is edited; a restore puts back only the fields he actually edited, never the whole form"
metadata: 
  node_type: memory
  type: project
  originSessionId: 67b3bfb6-66e5-44b8-98eb-ae6050dbf439
  modified: 2026-08-05T15:46:16.838Z
---

Built 2026-08-05 in `components/dashboard/FormFallbackGuard.astro` (inline script) after the owner
asked what the draft mechanism actually protects and whether a dead machine loses his typing.

**What it was:** a draft was written in exactly one case — the dashboard's module graph died, the
browser fell back to its own POST, the guard caught it. The rare accident. A closed tab, a crashed
browser or a power cut run no line of our code on the way out, so nothing was written.

**What it is now:** any `form[data-unsaved-guard]` is drafted to localStorage continuously while
edited (700ms debounce, flushed on `visibilitychange` → hidden), and the next load OFFERS it back.
**Local only — nothing reaches the server without the seller pressing save.** Drafts key by
store + form + record id; the CSRF token, password and file fields are never stored.

**The rule that is easy to get wrong, and the reason for it:** a dashboard form submits EVERY field
it owns, so a draft is a photograph of the whole form. A restore therefore puts back only fields
that differ from what the page had rendered when the draft was written (`edits()` and its `base`
snapshot) — restoring the photograph whole would write fields he never touched and silently revert
a second tab, which is the lost update [[project_multitab_concurrency]] / `lib/record-rev.ts` exists
to prevent, arriving through a door the per-field merge cannot see: a stale value that looks like
something the seller typed. Found by the review gate, not in production; two tests pin it.

**A rewrite of a form's fields now fires two events, and they mean different things.**
`dash:fieldsrewritten` = "repaint from the field", fired by BOTH discard and draft-restore — any
widget painting from a hidden input (image cropper, both category pickers) must listen to this one
or it shows one picture above a field holding another ([[project_hidden_input_silent_writes]]).
`dash:discarded` = "thrown away on purpose", fired only by discard, and it is what deletes the
stored draft — a restore must never fire it.

**Accepted imprecision, decided not overlooked:** choosing "leave" on the browser's unsaved-work
prompt still leaves the draft, and it is offered on the next load. Nothing on the way out can tell
that choice apart from a power cut, and an unwanted dismissible bar does not compare to an hour of
typing nobody can bring back.

Related: [[project_dashboard_form_guard]], [[feedback_save_model_clarity]].
