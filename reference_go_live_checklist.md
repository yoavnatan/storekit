---
name: go-live-checklist
description: GO_LIVE_CHECKLIST.md (repo root) — the registry of every demo/placeholder/mock to swap for real data before launch
metadata: 
  node_type: memory
  type: reference
  originSessionId: 23b7a4ac-35fb-40ed-bad6-67b77af07fa9
  modified: 2026-07-20T14:09:00.539Z
---

`GO_LIVE_CHECKLIST.md` at repo root is the single, user-facing (Hebrew) registry of every place in the app still using a demo domain / empty id / mock number / dev-only JSON, and exactly what to swap when connecting real data — organized by area: domain+SEO, ads/tracking, payments, email, shipping, DB.

Created 2026-07-20 when the user worried "there are so many places that need updating when I connect real things (ads, SEO…) — how will I/you remember?".

**How to apply:** consult it before any "go live" work; and the moment new code takes a real-data dependency, add a row to it (same rule is pointed to from [[read-instructions]]'s `AI_INSTRUCTIONS.md`). Related: [[project-domain-switch]] (robots.txt manual edit is one of its rows).
