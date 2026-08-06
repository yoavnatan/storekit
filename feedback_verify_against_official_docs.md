---
name: feedback_verify_against_official_docs
description: "Never answer a third-party-platform question from assumption or an SEO blog — fetch the vendor's own doc and quote it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8d3cf059-ae06-4038-a1be-d9639a399dca
  modified: 2026-08-06T18:01:20.031Z
---

Said explicitly 2026-08-06: **"עדיף תמיד לאמת ישירות מול התיעוד ולא להסתמך על הנחות יסוד."**

The case that produced it: a search summary (from an SEO site) said a `noindex` landing page gets
products disapproved in Merchant Center. Google's OWN `canonical_link` help page says the opposite —
noindex on a landing page is a documented, sanctioned way to keep the ad URL out of the web index.
Acting on the blog would have meant removing a `noindex` and pointing a canonical at an unclaimed
domain — i.e. building the exact account-suspension risk it was meant to prevent
([[project_ad_platform_account_risk]]).

**Why:** every one of these platforms can suspend the whole account, and one Merchant Center covers
every seller. A confident secondhand claim is worth less than nothing here, because it feels like
knowledge. **How to apply:** for Google / Meta / Bing / a payment or shipping provider — fetch the
vendor's page and quote the sentence, note the date, and mark anything still unresolved `[לאמת]`
(the convention CURRENT_TASK.md already uses). A search result is a pointer to the doc, never the
answer. If the doc contradicts an instruction he gave, say so with the quote before building — he
has asked to be argued with when the evidence is there. Related:
[[feedback_verify_before_recommending]], [[feedback_dont_imply_unverified_diligence]].
