---
name: project_json_script_xss
description: "JSON-in-<script> set:html XSS class — RESOLVED 2026-07-29 via lib/json-script.ts + a guard test; the audit found 11 raw sinks, several public"
metadata: 
  node_type: memory
  type: project
  originSessionId: e2466b3a-647d-4549-a82a-fe4cd0f75e12
  modified: 2026-07-29T08:30:58.145Z
---

`set:html={JSON.stringify(data)}` inside a `<script>` tag is an XSS sink when `data` holds user-controlled strings: `JSON.stringify` does NOT escape `</script>` (or `<`/`>`), so a value containing `</script><img onerror=...>` breaks out of the tag and executes. `type="application/json"` does NOT prevent tag-breakout.

**Resolved 2026-07-29 — one helper, every site, one guard.** `src/lib/json-script.ts#jsonForScript` is now the only way to embed data in a `<script>`; it escapes `<`, `>`, `&` and U+2028/2029 to `\uXXXX` (still valid JSON — `JSON.parse` and JSON-LD consumers decode it back). `tests/json-script.test.ts` fails on any bare `JSON.stringify` inside a `set:html`, and on hand-rolled partial escapes.

**What the audit found — the earlier version of this memory was wrong**, and that's the part worth remembering: it claimed the remaining instances were dashboard-only self-XSS. Of 15 sinks, 4 were hand-escaped and **11 were raw**, several of them public and cross-user:
- `Seo.astro` — the JSON-LD blob on EVERY public page (product name/description, store name)
- `[storeSlug]/index.astro` + `[productSlug].astro` — `header-search-products` (product names from every store) and the store category tree
- `BaseLayout.astro` — the dataLayer push, the one blob interpolated into **executable JS** rather than a JSON island (hence the U+2028/2029 escapes)
- `PerfProductSection.astro` — shared by the seller AND admin views, so cross-tenant in the admin case

**How to apply:** never re-derive the escape at a call site; call `jsonForScript`. And don't trust a prose claim that a class is "only self-XSS" — enumerate the sinks. Same lesson as [[project_attribute_escaping_xss]] and [[feedback_fix_security_dont_report]].
