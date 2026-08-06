---
name: feedback-ajax-forms
description: All dashboard form mutations must use fetch/AJAX — no full page reloads on save
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3e88778b-62ce-48f1-865a-a5e449729863
---

All seller dashboard forms (add product, edit product, store settings, and any future mutations) must submit via `fetch` to a dedicated API route (`/src/pages/api/`) that returns JSON, and update the DOM in place.

**Why:** Full page reloads discard unsaved changes in other fields on the same page. The user explicitly requested this as the standard approach going forward.

**How to apply:**
- New mutation → create or extend `/src/pages/api/*.ts` returning `{ ok: true, ... }` or `{ ok: false, error: string }`
- Intercept form `submit` in `<script>`, POST via `fetch`, update DOM manually on success
- Show inline status flash (`.dash-success` / `.dash-error`) that auto-hides after ~3s
- Never redirect from mutation API routes — redirects are only for page-level navigation (create store, delete product, login/logout)
