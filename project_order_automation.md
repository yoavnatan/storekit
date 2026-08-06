---
name: project-order-automation
description: Order-lifecycle automation (session ג׳) — source-agnostic status→buyer-notify pipeline built; delivery methods + carrier states deferred to Sendit
metadata: 
  node_type: memory
  type: project
  originSessionId: df51454c-9bf3-4699-97ff-25f09616c900
  modified: 2026-07-24T11:45:12.456Z
---

Session ג׳ built the INTERNAL half of order-fulfillment automation (no email yet).

**Core idea aligned with user:** automation ≠ the seller doing something new. The seller changes status the SAME as before; what's automated is the DOWNSTREAM — the buyer gets told automatically. The status change is source-agnostic: same function fires whether the seller clicks it today or the carrier webhook fires it later.

**What's built:**
- `src/lib/order-notify.ts` — pure `buildOrderStatusNotification` + `notifyOrderStatusChanged`; on any shippingStatus change, in-app notification to the buyer (registered only — `order.buyerId`). Wired into `/api/seller/orders.ts` PATCH.
- **Seller's manual statuses simplified** to בטיפול→נשלח→נמסר (`processing`/`shipped`/`delivered`). `pending` is auto-initial (not pickable). `cancelled` is a confirm-gated button, not a dropdown pick. `ready` kept in the type/maps but REMOVED from the seller dropdown — it returns as a **carrier-driven** state ("ממתין לאיסוף שליח") once Sendit is wired, not a manual toggle with nothing behind it.
- **Cancel path** — `cancelled` status; server restocks (variant-aware `restockProduct`) + notifies buyer; blocked once shipped/delivered; terminal (no un-cancel). Tests: `tests/seller-orders-cancel.test.ts`, `tests/order-notify.test.ts`.
- **Second escalation** (`order-age.ts`): any order still owing shipping (`pending`/`processing`/`ready`) that's overdue escalates calm→amber→red AND gets a red-BORDER card (changed from bg-fill → border-only per user: fill hurt text readability). Applies to seller + admin (`orderAgeCardClass`).

**Decided model (ecommerce-standard):** no accept/reject gate — payment captured → order auto-confirmed → seller just fulfills. Cancel is the exception escape-hatch. Carrier ('delivered') is the authoritative "buyer received it" source (not seller/buyer); self-pickup → seller marks collected.

**Deferred to the Sendit shipping phase (GO_LIVE_CHECKLIST §5), NOT built now:** three `deliveryMethod`s the buyer picks at checkout — שליח עד הבית / נקודת איסוף (locker, point-list from Sendit) / איסוף עצמי מהחנות — each branches the status flow + needs seller settings (which methods + price) + checkout UI. Carrier webhook (`/api/shipping/webhook`) → source-agnostic pipeline. The pipeline is already method-agnostic so it won't need rewriting.

**Email phase — BUILT (session ד׳, 2026-07-24).** Modular `src/lib/email/` adapter (Resend chosen after research; console fallback in dev). `sendEmail()` + branded RTL template (`template.ts`), shared render helpers in `parts.ts`, status copy shared with the in-app channel in `src/lib/order-status-copy.ts`. Automations live:
- **Order confirmation** (checkout) — buyer (one email, grouped by store, thumbnails, "not a tax invoice" note) + seller (per-store, store name in subject/heading). `email/order-emails.ts` + `email/order-confirmation.ts`, wired into `/api/checkout`. Closes checklist #5.
- **Status emails** — ready/shipped(+tracking)/cancelled, `email/order-status-email.ts`, fired from `notifyOrderStatusChanged` so they reach GUESTS too (in-app only reaches registered). Same source-agnostic pipeline → future Sendit webhook triggers them for free.
Both fire-and-forget + resilient (never break checkout/status update). Tests: `order-emails.test.ts`, `order-status-email.test.ts`. **Only outstanding: connect the provider (Resend key + verified domain + SPF/DKIM) at go-live — GO_LIVE §4.** Invoices/receipts NOT this email's job — payment provider (SUMIT/Takbull) issues them per-seller. See [[project_messaging_email]], [[project_platform_name]], [[project_automations_in_code]].
