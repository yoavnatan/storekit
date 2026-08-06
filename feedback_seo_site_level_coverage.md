---
name: feedback_seo_site_level_coverage
description: "SEO must be checked at SITE level (crawl/index coverage), not only per-page tags — verify built output, not code"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: feec283a-18a8-4e40-b95e-297983265835
  modified: 2026-07-20T09:51:07.756Z
---

SEO has two independent layers, and the per-page one masks the site-level one. Per-page tags (title/description/canonical/JSON-LD/noindex) were done thoroughly — which is exactly why nobody noticed that **every store + product page was missing from the sitemap** (they're `prerender=false` SSR, and `@astrojs/sitemap` only lists build-time routes). No error, valid sitemap, pages perfect — just invisible to Google. It surfaced by chance from an unrelated question.

**Why:** this bug class is silent. A clean per-page audit gives false confidence about the invisible question — "who is even IN the index / has a crawl path."

**How to apply:** treat site-level coverage as its own checklist item, separate from per-page tags. Whenever a route flips static↔SSR, or a new public route type is added, **look at the BUILT output, not just the code**: `grep '<loc>' dist/client/sitemap*.xml` and `curl /sitemap-content.xml`. Fixed via a runtime `/sitemap-content.xml` (enumerates SSR store/product pages) + guardrail `tests/sitemap-content.test.ts`. Codified in AI_INSTRUCTIONS → Hard rules → SEO. Domain-switch spots: [[project_domain_switch]]. Broader SEO priority: [[project_seo_priority]], anxiety context: [[project_seo_marketing_anxiety]].
