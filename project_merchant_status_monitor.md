---
name: project_merchant_status_monitor
description: "The merchant-status job (built 2026-08-06) — watches Google/Meta feed approvals on a timer; its one rule is that an unrecognised answer is loud, never a clean bill of health"
metadata: 
  node_type: memory
  type: project
  originSessionId: bb2acdb1-3007-45d5-8d0a-69ccd293715e
  modified: 2026-08-06T18:40:48.556Z
---

`merchant-status` in `src/lib/jobs/registry.ts`, every 4h, inert until credentials exist. Asks
Merchant Center (Content API) and Meta Catalog (Graph API) what they did with our feed, because both
reject rows **silently** — the product keeps looking fine on the storefront and no ad runs behind it
([[project_feed_silent_rejection_class]]). Replaced GO_LIVE §2.5's "read the approval report by hand
on connection day", which was one look at a state that changes on every product edit.

**The rule the whole thing rests on: a provider must never answer "fine" when it means "I do not
know".** Network error, HTTP error, an unmintable token, **and a 200 whose body is not the shape we
expected** all return `null`. The two APIs are the part nobody can test against reality until the
accounts exist, so a wrong field name is live — and if it parsed as "zero rejected items" the monitor
would report health forever, which is the original failure rebuilt one layer up and harder to see.
Same discipline as `CustomDomainCheck['unknown']`.

**Four failures, and separating them is most of the code:** no answer (ours, and its symptom is
silence) · feed-level rejection or empty catalogue (ours, every seller at once —
[[project_ad_platform_account_risk]]) · ids matching no product (ours, the JOIN class of
[[project_ad_item_id]], checked over EVERY row because a broken join looks like a healthy report
about nobody) · one row disapproved (the seller's, and the only one that reaches them).

A mass rejection is treated as the second kind: above `rejectionCeiling` the seller notifications are
**held** and one platform alert is raised — same reasoning as the domain check's demote ceiling.

**Severity is `error`, not `critical`, deliberately.** By `error-severity.ts`, critical means a buyer
could not buy or money/stock may be wrong; a dead feed is neither, and spend stops with the serving.

**The reminder is in the code, not in a person.** A PRODUCTION build running this job with no
credentials writes one Alerts entry a week saying the site is live and nothing is watching the feed;
dev and CI stay silent. Built 2026-08-06 when the owner asked "so will you remind me on launch day?"
— the honest answer was no, and a doc that has to be re-read on the one day it counts is the same
promise the job exists to stop relying on. It stops by itself once the variables are set.

**Waiting on the account: four ENV only** — `GOOGLE_MERCHANT_ID` + `GOOGLE_SERVICE_ACCOUNT_JSON`,
`META_CATALOG_ID` + `META_ACCESS_TOKEN`. Google's token is minted in-process from the key
(`google-auth.ts`), never pasted — theirs expire hourly, and a variable someone refreshes every hour
is the manual step this deletes.

Related: [[project_ads_verification_plan]], [[project_zero_touch_selfservice]], [[project_scheduler]]
