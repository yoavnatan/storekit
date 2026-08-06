---
name: feedback-scalability
description: Scalability is a core hard rule — design every feature for many concurrent sellers and buyers
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ef4e1ffc-5162-4f30-abe9-e614a65c38eb
---

Scalability is a non-negotiable hard rule encoded in AI_INSTRUCTIONS.md.

**Three rules to enforce on every feature:**
1. API routes must be stateless — no module-level mutable state, no in-process caches
2. JSON file storage (`data/*.json`) is dev-only — lib functions must be written as pure DB adapters, swappable for SQLite/Postgres with no API change
3. No shared write state — writes must be safe under two simultaneous Node processes

**Why:** User explicitly requested scalability as a central design principle to support many sellers and buyers without downtime.

**How to apply:** Before implementing any feature, ask: would this break at 1000 sellers / 10,000 concurrent buyers? Flag any new file writes, singleton state, or in-process caches.

[[feedback_architecture]]
