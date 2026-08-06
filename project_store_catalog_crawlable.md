---
name: project_store_catalog_crawlable
description: "Store categories are real ?category=<slug> URLs and grid pages are ?page=N — before 2026-08-03 the page linked 24 products and chips were <button>, so 76% of a catalog had no in-site link"
metadata: 
  node_type: memory
  type: project
  originSessionId: dadb522e-d82a-453b-94a9-362fc35b8454
  modified: 2026-08-05T13:44:59.787Z
---

The store page used to link its **first 24 products and nothing else**. "Load more" is a fetch, not a link, and the category chips were `<button>`s — invisible to a crawler. Measured on the showcase set 2026-08-03: **76 of one store's 100 products had no in-site link pointing at them anywhere**. They were in `/sitemap-content.xml`, so Google could discover them, but nothing said which shelf they belonged to or that the shelf existed.

**What it is now** (`src/pages/[storeSlug]/index.astro`):
- **Categories are URLs** — `?category=נעליים`, keyword-bearing in Hebrew, self-canonical, with their own title/description + `CollectionPage` + `BreadcrumbList`. They were previously a UUID held in client state.
- **Chips and breadcrumb are `<a href>`.** A plain left click still `preventDefault`s and filters in place; modified clicks and crawlers get the real URL. Nothing changed for a person.
- **Grid pages are `?page=N`, and "טען עוד" IS that link** — an `<a href="?page=N+1">` drawn as a button, whose click handler cancels the navigation and appends in place (2026-08-05). Past-the-last-page 302s to page 1 rather than serving an empty shelf.
  - **Do not add a numbered pager beside it.** One was tried for two days and removed: two controls for one job that contradict each other (press "load more" four times and the row underneath still says page 1), and the owner's question settles it — *"מה המשמעות ליוזר שיש גם טען עוד וגם עמודים? לא ראיתי דבר כזה."* Restyling it quieter (also tried) does not make a second control not a second control. `rel=next/prev` is not the answer either: Google dropped it as an indexing signal in 2019.
  - **The href must be OMITTED on the last page**, server-side and client-side. Measured the first time this shipped: an href that outlives the last slice points at `?page=<totalPages+1>`, which redirects to page 1, whose button points forward again — an endless loop. `hidden` on the wrapper is no defence, because a crawler reads markup and not pixels.
  - Consequence to know before changing it: the crawl path is now a **chain** (page N is N clicks deep), not a fan. Fine at 24 a page with every product in the sitemap besides; a store with hundreds of pages would want a different shape.
- **`q` / `sort` views stay `noindex`** — same products in another order behind unbounded URLs.
- Sitemap lists every non-empty category. Verified by crawling: **100/100 products reachable, sitemap 878 → 1003 URLs.**

**Two traps this cost, both worth not re-paying:**
1. **`aria-pressed` is invalid ARIA on an `<a>`.** The selected chip's entire fill hung off `[aria-pressed="true"]` and vanished the moment the row became links — the CSS keys off `aria-current="page"` too now. Also: the SELECTED category leads its own row, because drilling into a leaf used to render an empty chip row.
2. **A category name can slug to the empty string.** `toSlug` keeps letters and digits, so `"★★★"`, `"👍"`, `"---"` → `""` — and `?category=` with nothing after it is a link to the whole catalog wearing a category's label, plus a sitemap entry handing Google a duplicate of the store page. **Always build the param with `categoryUrlParam(category)`** (slug, falling back to the id), never `categorySlug(name)` directly. `findCategoryByParam` accepts either form, and refuses to match on an empty slug so `?category=★` cannot silently pick the first unsluggable category.

Guard: `tests/store-catalog-crawlable.test.ts` — it asserts the markup decisions, not the behaviour, because "make this a button again" is the refactor that would quietly undo all of it.

Related: [[project_seo_priority]], [[feedback_seo_site_level_coverage]], [[project_hebrew_product_slugs]].
