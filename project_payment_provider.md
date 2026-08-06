---
name: project-payment-provider
description: "Payments provider research 2026-08-03 — Takbull was WRONG and is out, PayMe leads / SUMIT second; the provider-independent architecture is settled, the provider choice is deliberately deferred to when there's a ח.פ + demo + sellers"
metadata: 
  node_type: memory
  type: project
  originSessionId: 21d76370-a867-4204-b55e-a091f4325f68
  modified: 2026-08-03T12:24:18.853Z
---

**Full findings live in GO_LIVE_CHECKLIST.md §3 — read that before re-researching anything here.**
This note exists so a future session starts from the conclusion instead of redoing a very long search.

**Takbull is OUT.** It was recorded as the leading choice on 2026-07-22 and that was wrong: its
marketplace product is a **WooCommerce/WCFM plugin only**, and its API documents no marketplace,
split, or merchant-creation endpoint. This project is Astro. Don't re-propose it.

**The regulatory frame that fixes the architecture:** ISA staff position 25.11.2024 splits
Marketplace (needs a licence) from Reseller (exempt, but requires owning the goods and taking full
financial risk — kills the model). The only fit is **pure technology provider**: each seller is a
merchant of a licensed party, funds never pass through the platform.

**Leaders:** **PayMe** first — its whole product is being a marketplace's payment layer, it states
it can *"split a transaction between multiple sellers and charge a dynamic fee"* (our commission
taken **inside** the transaction), 0₪ monthly / 0₪ setup / 0₪ withdrawal, ~2.5–3% + 1.2₪, invoices
at 0.20₪ **per document**, and the rate is negotiated **per platform** — the wholesale posture SUMIT
refused. Licensed (ח.פ 515033553). Live Israeli reference: folyou. **SUMIT** second, and the only
one whose behaviour was verified in real source (their WooCommerce plugin): `multivendorcharge` is
**one** call returning `Data.Vendors[]` with a Payment + DocumentID per vendor, and
`/website/companies/create/` opens a seller account via API. Ruled out: Upay (no API, 1.5% direct),
Tranzila (70–170₪/mo **per merchant**), Paddle (no physical goods, no third-party sellers),
PayPlus/EasyCard/Cardcom/Grow (no merchant-creation or split endpoints).

**Settled and provider-independent — build against this, it does not change with the choice:**
seller = an entity holding its own clearing credentials; the platform never receives funds;
**the seller pays the provider directly — never collect and forward, that IS the licence trigger**;
embed via **iFrame / Hosted Fields, never server-to-server** (PCI-DSS scope); the signup wizard
needs **both** "connect my existing account" and "open one for me", or every established seller is
forced into a second bookkeeping system; one-click-across-stores stays possible, per-store checkout
is the safe fallback.

**Deliberately deferred, 2026-08-03:** the provider and rate. No provider gives real terms at zero
sellers — SUMIT's first-line support offered nothing and contradicted their own docs. Revisit with
**ח.פ + demo + sellers lined up**, when there's leverage. The ח.פ is a launch prerequisite anyway
(charging 99₪ + 12%), not a payments prerequisite. Nothing in the app is blocked meanwhile — no
provider is wired in at all. See [[project_business_model_pricing]] and [[project_boost_billing_model]].
