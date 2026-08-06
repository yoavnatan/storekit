---
name: project-ads-verification-plan
description: "How the Google/Meta ad connection gets verified before launch — 5 layers in GO_LIVE §2.5; first-party attribution capture BUILT 2026-08-04; feed-vs-event product id mismatch still open"
metadata:
  node_type: memory
  type: project
  originSessionId: 7d551a43-bf25-4a28-8ef3-9be1fe3a32c6
  modified: 2026-08-04T18:48:44.338Z
---

The Google/Meta advertising integration does not exist yet — no API calls anywhere. Every number in
the seller AND admin advertising tabs is a deterministic hash of the budget. Only the product feed
(`/api/feed/products.xml`), the pixel/GTM injection code, the browser conversion events and the
first-party attribution capture are real, and all sit idle until the domain is live and the IDs are
filled in.

**Decided 2026-07-30, written into `GO_LIVE_CHECKLIST.md` §2.5** — a verification plan, because the
dashboard fabricates its own figures and therefore looks *identical* whether the connection works or
is broken:

1. Feed — Merchant Center approval report + Meta Catalog separately (free, no ad budget)
2. Pixels — Tag Assistant / Pixel Helper; `Purchase` must fire exactly once at the right amount
3. Sandbox — Google Ads *test manager account* + Meta Marketing API *Sandbox mode* (free)
4. Cross-check — one real 100–200₪ campaign **on the owner's own money, on his own store**, our
   numbers vs Ads Manager for the same range. Sandbox data is fabricated too, so only this settles
   it. No seller pays for a boost before this passes.
5. Attribution — what counts as "a sale from this campaign" at all (added 2026-07-31)

**Order the user accepted:** DB → domain → feed → pixel → sandbox → real campaign. Ads are blocked
on the DB because the feed route reads every product on every fetch, and on the domain because
Merchant Center requires a verified one (localhost can't be used).

**Built 2026-08-04 — the capture half of layer 5** (`src/lib/attribution.ts`, migration 0010,
`orders.attribution`). Brought forward past its own written trigger ("when the real ad accounts
open"), and the reason generalises: **attribution can only be recorded at the moment it happens**, so
every month without the capture is a month of orders nothing can attribute in hindsight. Nothing
reads the column yet, on purpose — until real accounts exist no link carries the parameters, and a
true 0 beside mock thousands is worse than either number alone. `InitiateCheckout` shipped the same
day. What is still owed on connection day: the report that reads the column, per-network click
windows (Google 30d / Meta 7d, off the stored `landedAt`), and removing "(משוער)" from the label.

**Fixed 2026-08-04, same session:** the feed and the events had been naming products by two
different identifiers, so they joined to nothing — see [[project_ad_item_id]] for the class, which
is the more reusable part.

**Superseded:** this file used to say ads block *marketing* and not launch, and that the advertising
tab should be hidden or marked "בקרוב" until §2.4. Both were reversed by the owner on 2026-08-04 —
see [[project_ads_block_launch]]. §2 is launch-blocking, so there is no moment at which a real seller
and an unconnected tab coexist, and the hiding mechanism was dropped from the checklist.

Related: [[project_ads_block_launch]], [[reference_go_live_checklist]], [[project_boost_billing_model]], [[project_seo_priority]]
