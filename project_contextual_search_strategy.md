---
name: project_contextual_search_strategy
description: "Semantic search (the crown jewel) — DEFERRED by the owner 2026-08-03, and NOT for a technical reason: the DB is ready. It is blocked on ONE decision only him can make — who computes the embeddings (external provider = product text leaves the server, vs self-hosted = upkeep). Do not re-pitch it until he picks; do not start it half-way. Plan in CONTEXTUAL_SEARCH_STRATEGY.md, recorded as stage 4b in DB_MIGRATION_PLAN.md §8"
metadata: 
  node_type: memory
  type: project
  originSessionId: 804503c6-c830-4188-a666-f44c2af04c96
  modified: 2026-08-03T00:00:00.000Z
---

The on-site **contextual/semantic search** (natural-language intent, e.g. "gift for a 5-year-old who likes dinosaurs" → relevant products) is the user's stated crown jewel of the project. The **full strategy is written in `CONTEXTUAL_SEARCH_STRATEGY.md`** (repo root, Hebrew): vision, the two-front AIO distinction (external AI-engine discoverability = already done, vs. our own on-site semantic search = this), architecture (per-product embeddings from the same text that feeds JSON-LD/feed/labels, pgvector + HNSW, hybrid semantic+lexical search, re-embed via the existing IndexNow hooks), phasing, and open decisions (embedding provider / Hebrew quality / hybrid weighting).

**Not built yet — DB-dependent:** it's built together with the Postgres migration (pgvector), because building it on today's `data/*.json` would be throwaway work. Linked from [[CURRENT_TASK]] item 13.4 and GO_LIVE section 6.

The **external** half of AIO (be found/cited by ChatGPT/Perplexity/Gemini) is separate and already done: enriched Product JSON-LD, dynamic `/llms.txt`, robots.txt opened to AI crawlers, IndexNow (`src/lib/indexnow.ts`), and zero-touch ad labels (`src/lib/product-labels.ts`). Post-launch manual steps (Search Console, Bing Webmaster, Merchant Center) are in GO_LIVE section 7.


**⏸ DEFERRED by the owner, 2026-08-03 — and the reason matters more than the fact.** The DB
migration is finished and `pgvector` is available, so nothing technical is in the way. What blocks
it is **one decision, and only he can make it: who computes the embeddings.** An external provider
(OpenAI / Cohere — cheap, zero upkeep) means product text AND shopper queries leave the server; a
self-hosted model (`multilingual-e5`) means they never do, at the cost of running and maintaining
it. Privacy against operations, with no right answer available to me.

**Why it blocks CODE and not just budget:** the choice fixes the vector's dimension, which fixes
the column's schema and the index. "Start now and swap the provider later" is a data migration, not
a config change — so starting half-way is worse than waiting.

**How he asked about it, which is worth remembering:** when offered the three providers he answered
"I don't understand, is this the semantic search? can we postpone it and write it down somewhere?"
— i.e. the decision was presented before the thing itself was explained. **Explain what it buys in
one plain sentence before asking him to choose a vendor for it** (today's search matches WORDS;
this matches MEANING — "something for a baby's room" finds a night light without the word).

**What no longer needs building when it resumes:** the lexical half of the hybrid partly exists
since §3 — `store_products.search_text` (a generated column carrying the full Hebrew normalisation)
plus a trgm index, already serving platform search. It is NOT BM25, so whether the hybrid leans on
it or on `tsvector` stays open — and `tsvector` has no Hebrew stemmer in a standard configuration,
which makes its advantage an empirical question rather than a given. **Measure, do not assume.**
The other two "open decisions" in §6 never blocked: hybrid weighting is calibrated during the
build, and cross-platform vs per-store is already answered in the doc itself.