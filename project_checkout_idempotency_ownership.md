---
name: project-checkout-idempotency-ownership
description: completed checkout keys are bound to the buyer (checkoutOwner) — replay only to them; claimCheckout/completeCheckout require the owner arg
metadata: 
  node_type: memory
  type: project
  originSessionId: 2b1d3bee-5dee-40de-9221-ab6c830a2914
  modified: 2026-08-01T22:06:26.119Z
---

A completed idempotency record is replayed only to the buyer who created it. `checkoutOwner(email)`
in `src/lib/checkout-idempotency.ts` is a sha256 of the normalised email; `claimCheckout(key, owner)`
and `completeCheckout(key, ref, orderIds, owner)` both **require** it, and a mismatch returns a new
`{status:'conflict'}` that `/api/checkout` answers with a generic 409 carrying no order data.

**Why:** the replay response hands back `orderIds` + `checkoutRef`, and the key alone used to decide
who received them — so the key was effectively a bearer token for another buyer's order references,
with nothing behind it but unguessability. Not exploitable in practice (122 bits of
`crypto.randomUUID` on any modern browser; the `Math.random` path in `checkout-attempt-key.ts` is a
last resort reachable only with no `crypto` at all), so this is defence in depth, not a patched hole.
Found by opening a `sonarjs/pseudo-random` finding that was about to be frozen into
`.eslint-baseline.json` as "pre-existing" — see [[project_redos_regex_class]] for the sibling class.

**The same class, found again on 2026-08-02 and this time exploitable — sweep for it, don't wait for it.** `PATCH /api/seller/orders` verified that the caller owned the *storeSlug* in the request and then trusted the `orderId` beside it: any seller could cancel another store's order (restocking that seller's inventory and mailing their buyer), rewrite the buyer's details, or delete items and have the total recomputed. Bound now through `orderBelongsToStore` in `lib/orders.ts`, with `tests/seller-orders-scope.test.ts` — which also scans `src/pages/api` so a new route calling `updateOrder` without the bind fails instead of shipping. **The generalisation worth carrying: a session proves which CONTAINERS you own (stores, accounts) and never which RECORDS, so every by-id mutation needs the record joined back to the container in the same handler.** The other seller routes were checked in the same pass and were already correct (`updateCampaign(id, store.id)`, `product.storeId !== store.id`) — orders was the one outlier, which is exactly why the check has to be mechanical rather than remembered.

**How to apply:** the owner arg is required on purpose — optional would let a call site silently drop
the protection, the rot pattern in [[feedback_new_state_sweep_consumers]]. Identity is the **email,
not the session**: it must be stable whether the buyer is a guest or signed in, and a mid-checkout
login must not turn a legitimate retry into a hard block. Records predating the field carry no owner
and stay replayable for the rest of their 24h TTL — refusing them would risk the double charge the
module exists to prevent. Tests: `tests/checkout-idempotency-owner.test.ts` (module) +
a route case in `tests/checkout.test.ts`; both were verified to fail with the check removed. Still
open, NOT done: the ledger is single-process (`Mutex`), so this needs a unique index + transaction at
the DB migration — see [[project_db_migration_indexes]].
