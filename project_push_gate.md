---
name: project_push_gate
description: pre-push hook BLOCKS on red verify since 2026-08-02; branch protection needs GitHub Pro
metadata: 
  node_type: memory
  type: project
  originSessionId: 9773ed7c-0d99-4226-a65a-dee8a1335d3c
  modified: 2026-08-02T09:40:32.509Z
---

`.githooks/pre-push` runs `npm run verify` and **refuses a red push** (changed 2026-08-02; it
previously printed a notice and pushed anyway).

**Why:** CI runs ON the pushed commit, so it can only ever report that `main` is already broken —
there is no ordering in which CI is green *before* a push. The window between push and fix is the
failure everyone means when they say "don't push before CI is green".

**How to apply:** never push a red tree. `--no-verify` exists and is named in the hook's own error
text, but using it turns `main` red on purpose.

The unbypassable version — branch protection (or a ruleset) requiring the `verify` check — returns
403 "Upgrade to GitHub Pro or make this repository public" on this private free-plan repo.
**Decided 2026-08-02: not upgrading, and this is settled — do not re-pitch it.** The reasoning was
that at a solo-developer stage the local gate already converts an unverified push from a slip into
a deliberate act, which is the whole value; revisit only if the team grows or something needs hard
server-side permissions, at which point Pro is a one-minute change. See [[feedback_session_close]]
and [[project_review_gate]] for the other gates.
