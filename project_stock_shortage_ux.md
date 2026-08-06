---
name: project-stock-shortage-ux
description: Stock running out mid-checkout — two-layer correction (built 2026-07-29). The two-process oversell is CLOSED (2026-08-03, proved with 50 concurrent buyers); the refusal COUNT was the bug that check actually found
metadata: 
  node_type: memory
  type: project
  originSessionId: 63e37f81-377e-4976-a2b2-68df2d1556c1
  modified: 2026-07-30T07:30:53.783Z
---

A buyer can never be charged for stock that isn't there: `decrementStock` is atomic and runs BEFORE the charge, and every failure path restocks. That was already true; what was missing was the buyer-facing half, built 2026-07-29 (full mechanism now in AI_INSTRUCTIONS.md → Features built → Checkout). Two layers: `/api/checkout`'s `409 {error:'out-of-stock', outOfStock:{…available}}` corrected in place on the page, and `/api/cart/prices` answering each line's stock so the existing moments-of-attention re-price catches most cases before the pay button.

**Two real gaps remain — neither is fixed, both are seller-facing:**

1. ~~**Two server processes = oversell.**~~ **CLOSED 2026-08-03.** `UPDATE … WHERE stock >= qty` is one statement and the affected-row count is the verdict, so it is correct on any number of instances; the process-local mutex is deleted. **Proved against a real server, not reasoned:** 50 concurrent buyers of a product with stock 10 — exactly 10 succeeded and each claimed a **different** unit (`tests/stock-concurrency-live.test.ts`; PGlite is one process and could never have shown this). **But the check found a second, subtler defect in the same run: 7 of the 40 REFUSALS reported up to 8 units left when the true stock was 0** — a CTE reads the snapshot from statement start while the `UPDATE` beside it re-reads after the row lock releases, so under contention they disagree. That stale number is what the buyer's page clamps the quantity selector to, so a shopper was offered stock that no longer existed and refused again on retry. A refusal now re-reads in its own statement (`store-products.ts#stockAfterRefusal`), on the out-of-stock path only. **The general rule: when a conditional UPDATE is the verdict, the number you report on FAILURE needs its own read.**

2. ~~**The seller's own save can resurrect a sold unit.**~~ **FIXED 2026-07-30.** Stock is an ABSOLUTE write and the server writes it too (every sale decrements), so a number typed over a stale cell used to undo the sale. The full edit form was already safe (`stock` is in `PRODUCT_REV_FIELDS`, so `mergeByFieldRev` keeps the stored value when he didn't touch it and answers 409 when both sides changed) — the hole was the two INLINE edits, which deliberately skip that merge as "one explicit intent". Both now send the figure the cell DISPLAYED as `prevStock` and `/api/product` refuses the write with `409 {conflict:true, currentStock}` when the stored value moved since; the client corrects the cell to the real number instead of letting him retype the stale one. Absent `prevStock` the write proceeds (additive / zero-downtime). Tests: `tests/product-stock-cas.test.ts`.

**The rule this generalises to:** any field the seller edits as an absolute number that the SERVER also writes needs a compare-and-set, not a plain write. Stock is the only one today; check this before adding another.

**Why it matters:** the user asked directly whether stock can fail a buyer or a seller during payment. Buyer — verified no. Seller — only #1 remains, and it cannot happen on one process.
