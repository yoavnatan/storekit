/**
 * The pricing page's two behaviours: work out which plan is cheapest, and record the one that was
 * picked.
 *
 * ── Why the page is server-rendered but this is client-side ──
 * `/pricing` is read far more often by someone who has no account than by someone who has one, so
 * the page itself says nothing about "your plan" and can be cached and crawled as one document.
 * Who is signed in is asked afterwards, over `/api/seller/tier` — which answers `signedIn: false`
 * without an error, because logged-out is this page's normal state, not a failure of it.
 *
 * ── The arithmetic ──
 * A tier costs `monthlyFee + revenue × commission%`, all before VAT (`lib/pricing.ts`). Both numbers
 * are read off the card's own `data-` attributes, so this cannot drift from what the page printed.
 */
import { showErrorToast, showToast } from '../lib/toast.js';

/** Digits only. The field is `inputmode="numeric"` and accepts a formatted amount, so "8,000 ₪" and
 *  "8000" are the same answer — anything with no digit in it is "no answer yet", not zero. A zero
 *  would be a real revenue figure and would confidently name the cheapest plan for a shop that
 *  sells nothing. */
function parseRevenue(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** ILS, no agorot: this is an estimate off a number the seller guessed, and two decimal places
 *  would dress it as a quotation. */
const ils = (n: number): string => `₪${Math.round(n).toLocaleString('he-IL')}`;

export function initPricingTiers(): void {
  const list = document.getElementById('tier-list');
  if (!list) return;
  const cards = [...list.querySelectorAll<HTMLElement>('[data-tier]')];
  if (!cards.length) return;

  const label = (name: string): string => list.dataset[name] ?? '';
  const tiers = cards.map((el) => ({
    el,
    id: el.dataset['tier'] ?? '',
    fee: Number(el.dataset['fee'] ?? 0),
    commission: Number(el.dataset['commission'] ?? 0),
    out: el.querySelector<HTMLElement>('[data-role="calc"]')!,
    btn: el.querySelector<HTMLButtonElement>('[data-role="choose"]')!,
  }));

  // ── The calculator ────────────────────────────────────────────────────────────────────────
  const field = document.getElementById('calc-revenue') as HTMLInputElement | null;

  function render(revenue: number | null): void {
    if (revenue === null) {
      // Back to the resting state rather than leaving the last answer on screen: a stale figure
      // beside an emptied field is the one reading that is actively wrong.
      for (const t of tiers) { t.out.textContent = ''; t.el.removeAttribute('data-best'); }
      return;
    }
    const costs = tiers.map((t) => ({ t, cost: t.fee + (revenue * t.commission) / 100 }));
    const cheapest = costs.reduce((a, b) => (b.cost < a.cost ? b : a));
    // The runner-up, so the winner can say what choosing it actually saves. Without it the mark is
    // a claim with no size — and at low revenue the gap is a few shekels, which is worth seeing
    // before switching plan for it.
    const runnerUp = costs.filter((c) => c !== cheapest).reduce((a, b) => (b.cost < a.cost ? b : a));

    for (const { t, cost } of costs) {
      const best = t === cheapest.t;
      t.el.toggleAttribute('data-best', best);
      const saving = best && runnerUp.cost > cost
        ? ` · ${label('labelSaves').replace('{amount}', ils(runnerUp.cost - cost))}`
        : '';
      // The mark is never colour alone (WCAG 2.1 AA): the winning card says so IN WORDS on the same
      // line as the figure, and `data-best` — which the card styles itself off, via a Tailwind
      // variant rather than an inline style written from here — is the second, redundant signal.
      t.out.textContent = `${label('labelTotal')}: ${ils(cost)}${best ? ` · ${label('labelBest')}${saving}` : ''}`;
    }
  }

  field?.addEventListener('input', () => render(parseRevenue(field.value)));

  // ── Which plan is this seller on, and choosing one ────────────────────────────────────────
  let current = '';
  function paint(): void {
    for (const t of tiers) {
      const mine = !!current && t.id === current;
      t.btn.textContent = mine ? label('labelCurrent') : label('labelChoose');
      // `disabled`, and the site's `not-allowed` ban means it simply reads as inert rather than
      // as forbidden (Hard rules → three standing bans). Re-choosing the plan you are already on
      // is a no-op, and a no-op click that moves nothing is the interaction the owner banned.
      t.btn.disabled = mine;
    }
  }

  async function choose(tierId: string, btn: HTMLButtonElement): Promise<void> {
    const before = btn.textContent;
    btn.disabled = true;
    btn.textContent = label('labelSaving');
    try {
      const res = await fetch('/api/seller/tier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: tierId }),
      });
      if (res.status === 401) {
        // Not an error to apologise for — it is the normal path for a visitor who has not
        // registered yet, and the answer is the registration form with a way back to this page.
        window.location.href = `/seller/register?next=${encodeURIComponent('/pricing')}`;
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      current = tierId;
      paint();
      showToast(label('labelSaved'));
    } catch {
      // Said out loud, never swallowed — a plan the seller believes they chose and we did not
      // record is a bill for the wrong amount later (tests/silent-failure-guard.test.ts).
      btn.disabled = false;
      btn.textContent = before;
      showErrorToast(label('labelFailed'));
    }
  }

  for (const t of tiers) t.btn.addEventListener('click', () => void choose(t.id, t.btn));

  // Asked last, and its failure is silent on purpose: not knowing which plan a seller is on leaves
  // the page exactly as a logged-out visitor sees it, which is a complete and honest page.
  void fetch('/api/seller/tier')
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { signedIn?: boolean; tier?: string; chosen?: boolean } | null) => {
      if (!d?.signedIn || !d.chosen) return;
      current = d.tier ?? '';
      paint();
    })
    .catch(() => undefined);
}
