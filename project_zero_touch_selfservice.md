---
name: project-zero-touch-selfservice
description: Core principle — platform owner does zero manual sales/outreach AND zero ongoing manual contact; product must sell itself
metadata: 
  node_type: memory
  type: project
  originSessionId: ace550da-e7e6-4945-a746-c1bb0e5af92c
  modified: 2026-08-06T17:59:35.181Z
---

User's guiding principle (confirmed 2026-07-12, added to `AI_INSTRUCTIONS.md → Mission`): the platform must be **fully self-service** — this covers two distinct things, both hard requirements:
1. **Zero ongoing manual contact** with sellers/buyers once they're on the platform (no admin-mediated approval, disputes, support routing).
2. **Zero manual sales/acquisition** — he explicitly does not want to be the one going door-to-door, cold-calling, or pitching sellers to join. He wants the product itself to sell/market itself (product-led growth), not a founder-led sales motion.
3. **Zero recurring manual checks by him — added 2026-08-06, and it applies to operations, not only to sellers.** Stated flatly as *"שום דבר לא אמור להיות ידני"* when a launch item was offered to him as "either a job or a manual check by you". The distinction that survives: a **one-time** owner action is fine (opening a Merchant Center account, the §2.5 proof-of-correctness campaign on his own money) — anything **recurring** is a job in `src/lib/jobs/registry.ts` feeding the alerts tab, never a habit. Never offer him a manual monitoring option as one half of a choice.

**Why:** This is a scale requirement, not a preference — see [[feedback_scalability]] ("breaks at 1000 sellers?"). It's also why he rejected "go talk to real sellers" as validation advice (see [[project_seo_marketing_anxiety]]) not once but repeatedly — it's not discomfort with cold outreach specifically, it directly contradicts the core vision, at the acquisition stage as much as the operational stage. Already reflected in real architecture: split-payment (avoids the platform ever touching seller money or being a PSP), self-service seller registration (no manual approval gate), direct buyer↔seller messaging (owner isn't a go-between).

**How to apply:** 
- Any future feature involving admin/manual gatekeeping (seller approval, dispute mediation, manual payout, manual support routing) should default to an automated/self-service equivalent, not a step that puts the user in the loop.
- Never suggest manual sales/outreach/cold-calling/pitching sellers as a growth or validation strategy — already rejected twice. If growth/validation comes up, think in terms of product-led growth: frictionless self-signup, low/zero-commitment entry (no sales call needed to start), organic loops (SEO, existing sellers/buyers referring others), not founder-led sales.
