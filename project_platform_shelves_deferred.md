---
name: project_platform_shelves_deferred
description: "Platform-level cross-store category shelves are DEFERRED — rejected once for unbounded URLs, re-proposed and re-deferred 2026-08-04; the real blocker is catalog depth, not architecture"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4f1f04d2-03e6-4b3b-a201-7550b6581636
  modified: 2026-08-04T06:16:06.969Z
---

**Platform-wide category shelf pages (a cross-store `/category/<x>` that could rank for "נעלי ריצה לגברים") do not exist and are deliberately deferred.** `/stores?category=X` is `noindex` whenever filtered ([stores.astro](src/pages/stores.astro) — `noindex={isFiltered}`), and product categories are per-store, so there is no cross-store product taxonomy.

**Why:** an earlier session rejected them over "infinite shelves". I re-proposed them 2026-08-04 without that context; the user corrected it. Both the rejection and the correction stand.

**The distinction worth keeping** (it is what made the re-proposal look reasonable):
- **Unbounded** = the *visitor* generates the URL — free-text `?q=`, `?sort=`, filter combinations. Same products reordered, behind an unlimited URL space. Correctly `noindex`, and already is on the store page.
- **Bounded** = a *closed vocabulary* generates it. Known N, different product set per URL.

That distinction alone does NOT license platform shelves, for two reasons:
1. **The vocabulary is not actually closed** — `proposeCategory()` in [store-taxonomy.ts](src/lib/store-taxonomy.ts) lets a seller add a new category, which is correct zero-touch behaviour. The only real bound is an inventory floor, and one already exists in [home-feed.ts](src/lib/home-feed.ts) (a shelf needs ≥2 stores).
2. **The actual blocker is catalog depth.** A platform shelf holding 3 products from 2 stores is exactly the thin page Google penalises. Architecture is not the problem; there is nothing to put on the shelf.

**Condition to revisit:** dozens of real (non-showcase) stores with overlapping categories. Not before. Anything built earlier is a thin-content liability on the shared domain — see [[project_store_readiness_gate]] for the same logic applied to empty stores.

Related: [[project_store_catalog_crawlable]] (the per-store version, which IS built and indexable), [[project_seo_priority]], [[project_all_data_is_demo]].
