---
name: project_store_readiness_gate
description: "Store readiness gate (2026-07-27) — a store with no visible product is undiscoverable but NOT 404'd; guidance vs gate are separate files on purpose"
metadata: 
  node_type: memory
  type: project
  originSessionId: 944af0e0-f7d4-4baf-b544-3b48ba14aa37
  modified: 2026-07-27T17:43:44.047Z
---

Built 2026-07-27 after the user asked that the important parts of opening a store be genuinely mandatory, "so there's never an operationally broken store on the site." What the gate excludes and where is in AI_INSTRUCTIONS → Store readiness gate; this file is the reasoning.

**Two concepts, deliberately two files:** `seller-onboarding.ts` = guidance (the dashboard checklist), soft. `store-readiness.ts` = the gate, hard. Don't merge them — one nudges, one decides discoverability.

**Why not a 404:** every platform surface is a promise that the link leads somewhere you can buy from, and sending Googlebot to an empty storefront costs the shared domain's trust, which the platform-SEO bet can't afford. But the seller still needs to preview and share their store while setting it up — so the direct URL keeps working and only *discovery* is gated.

**The real leak this fixed:** the sitemap and site search were emitting zero-product stores. Homepage and `/stores` had always filtered, which is exactly what made the gap invisible.

**Deliberately NOT a blocker:** self-pickup-without-address — already enforced in `/api/store` and re-checked on both checkout paths; re-gating it here would be a second source of truth for a solved problem.

**Extension point:** business/legal identity (ח.פ. / עוסק מורשה number, terms acceptance) SHOULD become a blocker — a store without it can't invoice or pass the processor's KYC. Those fields don't exist on `Seller` yet. Add it in `store-readiness.ts` and every surface inherits it. Related: [[project_zero_touch_selfservice]], [[project-business-model-pricing]]
