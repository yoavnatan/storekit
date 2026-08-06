---
name: project-seo-priority
description: SEO is the
metadata: 
  node_type: memory
  type: project
  originSessionId: fdbdcbfb-9e15-4b4c-ad98-9284e70ce278
---

The most important thing in this project is high Google SEO ranking. Every decision must support discoverability.

**Why:** User stated explicitly: "הדבר הכי הכי חשוב בפרוייקט הוא הSEO הגבוה בגוגל! הכי גבוה."

**How to apply:** SEO considerations override convenience in any tradeoff. Static pages where possible, structured data (JSON-LD) on every content page, semantic HTML, fast load times, unique titles/descriptions, no orphan pages, sitemaps, proper canonical URLs. Both platform-level and per-store SEO must be strong independently.

Any UX pattern that affects URL/indexability (modals, drawers, client-side navigation) must proactively include `history.pushState` + canonical URL — never wait for the user to notice the SEO gap. Flag it and implement it as part of the feature, not as a follow-up.

Related: [[feedback_read_instructions]] (AI_INSTRUCTIONS.md also lists SEO as priority #1).
