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
    name: el.querySelector('h3')?.textContent?.trim() ?? '',
    fee: Number(el.dataset['fee'] ?? 0),
    commission: Number(el.dataset['commission'] ?? 0),
    total: el.querySelector<HTMLElement>('[data-role="calc-total"]')!,
    share: el.querySelector<HTMLElement>('[data-role="calc-share"]')!,
    btn: el.querySelector<HTMLButtonElement>('[data-role="choose"]')!,
  }));

  // ── The calculator ────────────────────────────────────────────────────────────────────────
  const field = document.getElementById('calc-revenue') as HTMLInputElement | null;
  const summary = document.getElementById('calc-summary');

  /**
   * **The line that says whether any of this matters.**
   *
   * The fee ladder is deliberately shallow (`lib/pricing.ts`), so under roughly 7,000₪ a month all
   * four plans land within a few shekels of each other. Naming the winner and its "saving" there
   * was the page boasting of 24₪ off a 699₪ bill — which reads as a trick and is the opposite of
   * what a seller comparing platforms wants to hear (owner, 2026-08-24: *"המחשבון מגוחך"*). So
   * below five percent of the bill the page says so in words instead, and points at the entry
   * plan. The same threshold is in `PricingTiers.astro`, which renders this sentence for the
   * worked example before any script runs.
   */
  function summarise(cheapestName: string, dearestName: string, cheapestCost: number, spread: number): string {
    if (spread < cheapestCost * 0.05) return label('labelClose').replace('{amount}', ils(spread));
    return label('labelGap')
      .replace('{tier}', cheapestName)
      .replace('{amount}', ils(spread))
      .replace('{other}', dearestName);
  }

  function render(revenue: number | null): void {
    if (revenue === null) {
      // Back to a resting state rather than leaving the last answer on screen: a stale figure
      // beside an emptied field is the one reading that is actively wrong. The cards keep their
      // fee and commission — those are true whatever is in the field — and lose only the two
      // lines that were an answer to a number nobody is asking any more.
      for (const t of tiers) {
        t.total.textContent = '';
        t.share.textContent = '';
        t.el.removeAttribute('data-best');
        t.btn.classList.remove('btn--accent');
        t.btn.classList.add('btn--ghost');
      }
      if (summary) summary.textContent = '';
      return;
    }
    const costs = tiers.map((t) => ({ t, cost: t.fee + (revenue * t.commission) / 100 }));
    const cheapest = costs.reduce((a, b) => (b.cost < a.cost ? b : a));
    const dearest = costs.reduce((a, b) => (b.cost > a.cost ? b : a));

    for (const { t, cost } of costs) {
      const best = t === cheapest.t;
      t.el.toggleAttribute('data-best', best);
      t.total.textContent = label('labelTotal').replace('{amount}', ils(cost));
      // The share of turnover, which is the figure a seller actually compares platforms on — a
      // three-digit shekel amount on its own says nothing about whether it is a lot. One decimal:
      // this is arithmetic on a number he guessed, and 13.5% is as precise as that guess deserves.
      t.share.textContent = revenue > 0
        ? label('labelShare').replace('{percent}', ((cost / revenue) * 100).toFixed(1))
        : '';
      // The filled button follows the mark. The page offers four identical actions and exactly one
      // of them answers the question just asked, so the answer is the one that looks like a button
      // — and it has to MOVE, or it is a recommendation of whichever plan the server guessed.
      t.btn.classList.toggle('btn--accent', best);
      t.btn.classList.toggle('btn--ghost', !best);
    }
    if (summary) {
      summary.textContent = summarise(cheapest.t.name, dearest.t.name, cheapest.cost, dearest.cost - cheapest.cost);
    }
  }

  field?.addEventListener('input', () => render(parseRevenue(field.value)));
  // The field opens holding the worked example (`PricingTiers.astro`), so the script's first act is
  // to re-derive what the server already rendered — same numbers, same winner. It is not redundant:
  // a browser that restores a typed value on a back-navigation would otherwise leave the server's
  // example on the cards under a different figure in the field.
  if (field) render(parseRevenue(field.value));

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
