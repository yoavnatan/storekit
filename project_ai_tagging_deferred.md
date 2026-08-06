---
name: project_ai_tagging_deferred
description: Per-product AI tag extraction was explored and rejected pre-DB; the real smart engine is the planned semantic search
metadata: 
  node_type: memory
  type: project
  originSessionId: fca090d3-48da-4a21-984a-1c9f8dd0f5b7
  modified: 2026-07-27T09:19:11.275Z
---

Session ד׳ (2026-07-27) explored AI-powered product tagging (Anthropic SDK: a synchronous per-product "suggest tags" button, then a background auto-tagger). **Rejected and fully removed** — user's objections: sync call too slow, doesn't scale to bulk CSV import (100 products in the table), and per-product tag *strings* are a weak proxy for intelligence.

**Decision:** the genuinely "smart engine" the user wants IS the already-planned **semantic/contextual search** — embed each product once, understand intent at query time — which is DB-dependent (pgvector) and lands at the DB migration. See [[project_contextual_search_strategy]] and CURRENT_TASK item 13.4. A per-product AI tag layer on the current JSON architecture converges with that anyway (needs a job queue + DB to be robust for bulk/durability), so **do not re-attempt an AI tagging layer before the DB phase.**

**What was kept** (free, instant, offline baseline — no API key, no cost): the heuristic tag engine in `src/lib/tag-suggest.ts` (category segments + name words + variant values + a curated attribute lexicon) — client shows click-to-add suggestions; `src/lib/product-labels.ts` + `/api/product` auto-apply category+variant tags on save ("partial auto"). Tests in `tests/tag-suggest.test.ts`.

**Why:** [[feedback_scalability]] (JSON = dev-only, no shared write state, "breaks at 1000 sellers?"), [[project_db_migration_indexes]].
