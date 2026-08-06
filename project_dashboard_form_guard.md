---
name: project_dashboard_form_guard
description: Seller dashboard blocks native form submits + restores blocked drafts; any new form needing a real browser POST MUST carry data-native-submit
metadata: 
  node_type: memory
  type: project
  originSessionId: c15bc261-391c-47d3-815b-ed0066633037
  modified: 2026-07-31T13:34:33.977Z
---

`src/components/dashboard/FormFallbackGuard.astro` (built 2026-07-29) is an `is:inline` script on the seller dashboard. It blocks the browser's native submit for every form on the page, saves the blocked form to localStorage, and offers it back on the next load.

**Why:** the whole dashboard is ONE module graph — one failed import kills all seven AJAX submit handlers at once, and the forms still carry `method="POST" action="/api/…"`, so the browser would navigate to raw JSON and wipe everything typed. It detects "no handler ran" via `e.defaultPrevented === false` at document level (all handlers call `preventDefault()` first thing). Must stay `is:inline` — it cannot live inside the graph it protects.

**How to apply:** any NEW form on the dashboard that genuinely needs a real browser POST (server-rendered redirect flows) must carry `data-native-submit`, or it will silently stop working. **The trap is scope:** the guard listens on `document`, so it also judges forms the GLOBAL chrome (Header/Footer/BaseLayout) renders on top of the dashboard — Footer's language toggle was blocked this way (2026-07-31: pressing "English" showed "השמירה לא זמינה כרגע"). `tests/global-chrome-forms.test.ts` now fails any POST form in those three files without the opt-out. Currently marked: Header's logout form, CreateStoreCard's create-store form, Footer's `/api/lang` toggle. Everything else is AJAX by house rule — see [[feedback_ajax_forms]]. Tests: `tests/form-fallback-guard.test.ts` runs the shipped script pulled out of the .astro file; install it ONCE per jsdom file or a second listener eats the draft.
