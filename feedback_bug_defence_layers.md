---
name: feedback-bug-defence-layers
description: "user wants MAXIMUM protections against unknown bugs on money/reporting — build every layer, don't offer a menu"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cb102e3c-e457-47bb-b2a7-d2df686e6bd6
  modified: 2026-07-29T20:38:29.898Z
---

The user asked (2026-07-29) how to prevent bugs he doesn't know about and can't even think to look for, specifically around seller-visible data, money and sales reports. When offered a menu of techniques he replied: **do all of them** — "כמה שיותר הגנות כדי לעלות על באגים", and "תשתמש בכלים הכי מקצועיים, נכונים ומדוייקים".

**Why:** a suspicion-driven audit only finds what you already suspected. He learned this the hard way — a previous session spot-checked well, found two bugs, and a third only surfaced because he pushed back afterwards. He now wants defences that don't depend on anyone guessing right.

**How to apply — the standing layer list for any money/reporting work:**
1. **One rule, one place** + a guard test asserting nobody re-implemented it (grep the source for the forbidden pattern).
2. **Invariants** — properties that must hold for every input, run over fixtures AND the real data file.
3. **Fuzz / property tests** — seeded PRNG, hostile values, edge timestamps. This layer earns its keep: it found the negative-revenue bug nobody had imagined.
4. **Reconciliation** — compute each headline twice by genuinely independent routes, compare, surface the drift live in the admin UI (not only in a test).
5. **Rules as a table**, one row per state, one column per consequence, with a test that fails if a state has no row.
6. **Append-only journal** for anything that moves money.
7. **Idempotency** on every money-moving endpoint.
8. **Bounds/sanity checks** — no NaN, no negatives, nothing exceeding its own ceiling.

Don't offer these as options and wait — build them. Do flag genuinely ambiguous *business* semantics (what a headline should count) rather than deciding those unilaterally.

See [[project_metric_integrity_audit]] for what each layer looks like in this repo, [[feedback_fix_security_dont_report]] and [[feedback_new_state_sweep_consumers]] for the same instinct in other areas.
