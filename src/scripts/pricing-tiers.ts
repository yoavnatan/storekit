// `/pricing` — the one button on the page.
//
// ── This file was 221 lines and is now this ──
// It ran the plan calculator: parsed a revenue the reader typed, recomputed fee + commission for
// four tiers on every keystroke, moved the "cheapest" badge, rewrote the saving sentence, asked
// `/api/seller/tier` who was signed in, and — for a signed-in seller — saved a plan straight from
// this page, with a 502 branch for the processor refusing to amend his standing order.
//
// All of it answered "which plan", and since 2026-09-08 there is one plan: the per-sale commission
// went when the seller started clearing into his own account, and the ladder had no other dimension
// (`lib/pricing.ts` carries the decision, `tests/plan-chooser-guard.test.ts` forbids the regrowth).
//
// What is left is a button that starts the journey, and it does not need to know who is looking:
// `/seller/dashboard` sends a signed-in seller to his dashboard and everybody else to the login
// page with a `next`, which is the same redirect the header's own links rely on. That is why the
// page can stay one cached document for everybody — it no longer asks a per-seller question at all.
export function initPricingTiers(): void {
  const btn = document.querySelector<HTMLButtonElement>('[data-role="choose"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    window.location.href = '/seller/dashboard?panel=payouts';
  });
}
