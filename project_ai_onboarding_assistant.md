---
name: project_ai_onboarding_assistant
description: Future idea — AI help chat that guides sellers during store setup/onboarding
metadata: 
  node_type: memory
  type: project
  originSessionId: e2540d2f-2875-47e6-bfb9-29995b43e8c6
  modified: 2026-07-26T18:53:13.749Z
---

Future feature (not built, discussed 2026-07-26): an AI help chat that assists a seller while opening/setting up their store — answers "how do I update stock from Excel?" in their own language instead of forcing them to understand internal concepts like id-vs-sku.

Fits the core value [[project_zero_touch_selfservice]] — closes the gap where a stuck seller would otherwise contact the owner (unwanted) or churn.

Planned shape when we get to it:
- Claude API + RAG over the store's own help/docs; the chat answers from docs, doesn't invent.
- Stateless server endpoint (`/api/assistant`), same pattern as the rest of the API — stays scalable ([[feedback_scalability]]).
- Guidance/help ONLY at first — no destructive actions (delete product, change price). Actions stay in the normal UI with existing validations ([[feedback_security_priority]]).
- LLM calls cost real money — tie usage to the pricing tiers ([[project_business_model_pricing]]): limited on Starter, generous on Enterprise.

**Timing:** not now. Needs stable docs + a mature product to sit on. Revisit after the basic flows (incl. CSV stock import/update) are closed.
