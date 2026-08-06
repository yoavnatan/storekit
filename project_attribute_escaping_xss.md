---
name: project_attribute_escaping_xss
description: "Recurring XSS class in this repo — escapers that skip the quote char while being used inside attr=\"…\"; fixed at the helpers 2026-07-29"
metadata: 
  node_type: memory
  type: project
  originSessionId: e2466b3a-647d-4549-a82a-fe4cd0f75e12
  modified: 2026-07-29T08:09:06.337Z
---

This codebase keeps re-growing the same stored-XSS shape: a hand-written escaper that covers `&`, `<`, `>` but NOT `"`, used to interpolate a seller-controlled value into `attr="…"` in an `innerHTML` template string. The quote closes the attribute and an event handler follows.

**Why it recurs:** each client script defines its own local `esc`, and the escaper looks complete until you notice the call site is an attribute, not a text node. `escapeHtml()` in `src/lib/html-escape.ts` was the worst case — it escapes via DOM serialization (`textContent` → `innerHTML`), which by spec never escapes quotes, and had 11 attribute call sites.

**Resolved 2026-07-29 — structurally, not per-site:**
- There is now exactly ONE escaper: `escapeHtml` in `src/lib/html-escape.ts` (isomorphic pure string, escapes `&<>"'`). All 20 local copies were folded into it; each call site kept its historic name (`esc`/`escH`/`escB`/`escEom`/`escMsg`/`pqvEsc`/`escHtml`) via an import alias, so the diff stayed mechanical. `tests/html-escape.test.ts` fails on any new `replace(/&/g` copy outside the two XML escapers (`product-feed.ts`/`sitemap.ts`, which want `&apos;`).
- The consolidation surfaced two MORE live instances the name-based search had missed: `escMsg` (seller messages) used inside `href="…"`/`data-filter-value="…"`, and `toolbar-portal.ts`'s two inline chains. That is the argument for consolidating rather than patching: you can't grep your way to every copy.
- Second layer, at the entry point: `src/lib/image-url.ts` validates every image URL arriving in a request (https or site-relative only) and stores the URL parser's re-serialization, so quotes come back percent-encoded. Wired into `parseImages`, `/api/store.ts` and `brand-campaigns.ts` — whose own `startsWith('https://')` prefix check passed `https://x" onerror=…`.
- Still true and worth knowing: wrapping a URL in `cdnSrc`/`cdnThumb` does NOT sanitize it — a non-http value passes through untouched. Delivery ≠ validation ([[feedback_image_optimization]]).
- Found via the security-review gate at session close, on lines an image-optimization sweep had just touched. Related: [[feedback_security_priority]].
