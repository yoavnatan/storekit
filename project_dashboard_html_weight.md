---
name: project_dashboard_html_weight
description: seller dashboard ships 865KB of HTML (products 441KB + orders 194KB invisible); decided 2026-07-31 to make inactive panels lazy — not started
metadata: 
  node_type: memory
  type: project
  originSessionId: 27ebef2c-270b-4fae-85f3-57c84f84d406
  modified: 2026-07-31T12:15:40.258Z
---

Measured 2026-07-31 on a production build, `/seller/dashboard?panel=performance`:
total HTML **865KB** — products panel 441KB, orders 194KB, settings 58KB, performance 56KB,
advertising 15KB, messages 28KB, promotions 7KB, overview 4KB. 73% of the page is panels the
seller is not looking at. Inside the products panel, 505 inline `<svg>` icons = 137KB.

Consequence the owner actually reported: scroll down → refresh → the page starts at the top and
snaps down. The browser cannot restore a scroll position in a document that has not been parsed
to that height yet. Measured under CPU throttle: 1× restores at 112ms (before first paint at
136ms — invisible); 4× paints at 204ms and restores at 378ms; 8× paints at 348ms and restores at
946ms, with the document height climbing 900→1260→1689→1820px in visible steps.

**Decision (owner, 2026-07-31): make the inactive panels lazy.** Not started — deliberately not
begun at the tail of a long session, because the products panel is the riskiest surface in the
app.

**How to apply.** The pattern already exists twice in the repo: `perfIsInitial` / `advIsInitial`
in dashboard.astro skip the server-side computation, and the admin's `swapPanel()`
(lib/admin-nav.ts) already does "fetch the whole page, extract one panel, re-init" — reuse it
rather than inventing a partial endpoint. The real work is not the fetch, it is **re-init
idempotency**: orders is one call (`initOrdersTab`, but it builds a floating portal, so calling
it twice duplicates listeners) while products is ~25 init calls, several of which query the whole
document (`.gallery-widget`, `.category-picker`). Do orders first to prove the mechanism, then
products. Note that orders alone will NOT fix the scroll jump — products is the 441KB.

Related: [[feedback_scalability]], [[project_seo_priority]].
