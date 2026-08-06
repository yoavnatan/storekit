---
name: project-header-stability
description: "the header blinking out between store and home was three ordinary bugs, not a missing transition — root visibility curtain, two pages missing storeMode, seven nested #main-content; all fixed 2026-08-05 + tests/header-stability.test.ts"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4f672c25-c78c-4bfc-94fd-0b09a425dce5
  modified: 2026-08-05T12:47:30.787Z
---

The owner's recurring complaint — *"שההדר תמיד נשאר יציב ולא נעלם פתאום בין אתר חנות לראשי או
ההפך, וגם שהתוכן שלו יישאר יציב"* — had been read by more than one session as "we need view
transitions". It was not. It was three defects, each silent, all found and fixed 2026-08-05.

1. **A page hid `document.documentElement` and took the fixed header with it.** The store page's
   anti-flash curtain hid the ROOT for up to 500ms while it caught up on lazy-loaded pages and
   restored scroll. So every return to a store you had scrolled — the everyday home → store path —
   blanked the entire chrome, and the header appeared to vanish and come back. It hides
   `#main-content` now. **The class:** nothing in fixed chrome scrolls, so it has nothing to
   restore and never belongs behind a content curtain. `visibility`, not `display`, so the box
   survives and the footer does not jump.

2. **`storeMode` is not "this is a store".** It is the flag `Header.astro` reads to pick its ONE
   row mechanism; without it the row falls back to the legacy `container between flex` branch and
   the header loses `.site-header--store`, i.e. its 2px bottom rule. `buyer/dashboard.astro` and
   `checkout/success.astro` were the only two pages not passing it, so the bar's bottom edge and
   spacing changed the moment a buyer arrived there. Header.astro's frontmatter had asserted
   "every page passes storeMode" since 2026-07-31 and had quietly stopped being true — the exact
   rot `tests/instructions-integrity.test.ts` warns about (a correct path beside a false claim).

3. **Seven pages nested a second `<main id="main-content">`** inside the one `BaseLayout` already
   renders. Duplicate id, `<main>` inside `<main>`, and the skip link resolving to whichever came
   first. Nothing in CSS or JS depended on those inner elements (`main { flex: 1 }` in tokens.css
   is the only `main` selector in the tree), so they became plain `<div>`s.

4. **The store-colour bar is GONE (2026-08-05) and must not come back.** A 2px line in the
   store's own colour under the header. Reasoned about four times in two days: it leaked onto 13
   non-store pages, then — once narrowed — showed the real fault, which is that the colour is
   sampled from the uploaded logo ON THE CLIENT and so cannot be right at first paint. It painted
   grey and changed to the store's colour a third of a second later, every store load. A
   sessionStorage pre-paint seed fixed only repeat visits; a `data-glow-pending` attribute traded a
   colour change for a line appearing. The owner removed the cause instead: *"אם זה מסבך את
   העניינים אולי שווה לוותר על הפס הצבעוני הזה."* The header now wears the site's shared 1px
   hairline everywhere. `tests/header-store-line.test.ts` guards the absence and carries the full
   history. **Any future header colour needs a value the SERVER has at render time** — anything
   client-sampled reproduces this exactly. The store's colour still lives on its card's halo.

5. **A flicker report may be dev-only.** The dev server injects CSS via JS after first paint (0
   render-blocking stylesheets vs 1 on a build), so an unstyled first frame is a race that fires
   sometimes. Check where the user is looking first — [[feedback_dev_server]].

**How to apply:** `tests/header-stability.test.ts` scans the tree for all three of the first items, so a new page is
covered the day it exists — fix the page, never the test. Before believing a header claim, measure
it: a Playwright pass over home → store → home → store sampled the header 647 times across the
return navigation (hidden in 0) and confirmed one height (54.39px) and one bottom rule on every
page. Do NOT reach for a transition mechanism — see [[project_view_transitions_font_blocker]] for
why that door is closed. Related: [[project_header_layout]], [[project_brand_logo]].
