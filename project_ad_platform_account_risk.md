---
name: project_ad_platform_account_risk
description: "One Merchant Center/Catalog for the whole platform — a policy failure is every seller's ads at once; the two rules and where they're guarded"
metadata: 
  node_type: memory
  type: project
  originSessionId: 84ba00c2-4e08-44ac-a09b-7b4143d4c410
  modified: 2026-08-06T16:27:00.605Z
---

The platform advertises every seller from ONE Merchant Center, ONE Catalog and ONE Pixel. That is
what lets a seller be advertised without registering anywhere — and it means a policy failure is
never one item's, it is **every seller's ads at once, account-level**.

Two rules follow, both fixed and guarded 2026-08-06 (`tests/external-contract.test.ts` §5 + §4b):

1. **Every URL published to an ad network is on the platform domain and neither redirects nor
   canonicals off it.** We can claim `dezabin.co.il`; verification is done from the ADVERTISER's
   account, so no seller domain is claimable at any scale. A custom-domain store gets
   `custom-domain.ts#adLandingUrl` — platform URL + `?ad=1` — and both store pages stand their 301
   down for that marker and `noindex` the landing. The seller's SEO is untouched: every other
   visitor still 301s to their domain.
2. **A link the site renders on every page must resolve.** `/terms` + `/contact` were footer links
   to 404s AND unreserved slugs (a seller could have registered `terms`). Both are now pages and
   reserved words. A dead site-wide link is the "misrepresentation" class that suspends the ACCOUNT.

**How the first one got broken is the lesson:** the 2026-08-04 commit correctly diagnosed "feed link
≠ page canonical" and fixed the wrong half — it moved the feed to the seller's domain, which made
both sides agree and put every custom-domain seller on an unclaimable domain. The constraint that
would have caught it was written in GO_LIVE §2.5 nine days earlier and nobody re-read it. **A
constraint that lives only in a doc does not participate in a code change** — that is why both rules
are now grep-guarded tests.

A domain switch in either direction is now inert for Google/Meta/Bing: the feed never names the
seller's domain, the catalog id is the product UUID ([[project_ad_item_id]]), and the sitemap
follows the store (platform copy excludes a custom-domain store; that store's own domain serves its
own sitemap, rooted there).

See also [[project_domain_switch]], [[project_custom_domain_recheck]], [[project_feed_silent_rejection_class]].
