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
    btn: el.querySelector<HTMLButtonElement>('[data-role="choose"]')!,
  }));

  // ── The calculator ────────────────────────────────────────────────────────────────────────
  const field = document.getElementById('calc-revenue') as HTMLInputElement | null;
  const summary = document.getElementById('calc-summary');

  /**
   * **The line that says whether any of this matters.**
   *
   * The fee ladder is deliberately shallow (`lib/pricing.ts`), so under roughly 7,000₪ a month all
   * four plans land within a few shekels of each other. Boasting of 24₪ off a 699₪ bill reads as a
   * trick; saying "the plans are nearly identical, start on the entry plan" while the badge beside
   * it marks Growth is the page contradicting itself, which is what the owner read on 2026-08-24.
   * So both branches name the MARKED plan, and the only thing that varies is whether the gap is
   * worth quoting. The same threshold is in `PricingTiers.astro`, which renders this sentence for
   * the worked example before any script runs.
   */
  function summarise(cheapestName: string, dearestName: string, cheapestCost: number, spread: number): string {
    if (spread < cheapestCost * 0.05) return label('labelClose').replace('{tier}', cheapestName);
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

    for (const { t } of costs) {
      const best = t === cheapest.t;
      // **The mark, and nothing else.** What each plan would COST at this revenue is computed here
      // and deliberately never rendered: fee-plus-commission on a guessed turnover is a bill the
      // seller has not earned yet, and beside a 99₪ subscription it reads as though the
      // subscription had been a lie (owner, 2026-08-24). The arithmetic still decides which card is
      // cheapest — that is the whole answer he came for.
      t.el.toggleAttribute('data-best', best);
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
      if (res.status === 502) {
        // The gateway refused to move a standing order, and the endpoint wrote nothing (its own
        // header says why that order is not negotiable). So the sentence says the plan did NOT
        // change, which is true of our row and of PayMe at the same time.
        btn.disabled = false;
        btn.textContent = before;
        showErrorToast(label('labelGateway'));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json().catch(() => ({}))) as { fromNextCharge?: boolean };
      current = tierId;
      paint();
      showToast(label('labelSaved'));
      // **Where it went.** A toast says it was saved and then takes the fact away with it; this
      // line stays on the page and names the screen the plan now lives on (owner, 2026-08-24:
      // *"מה קורה אחרי שעושים בחירת מסלול? איפה זה מופיע?"*). Rendered only for a signed-in seller,
      // so on a visitor's page there is nothing here to reveal.
      document.getElementById('tier-saved-where')?.classList.remove('!hidden');
      // And for a seller who is already being billed, WHEN — his standing order has just been
      // patched to the new amount, and a change to what someone pays that does not say when it
      // starts is the half of the answer that generates the support message.
      if (body.fromNextCharge) document.getElementById('tier-saved-next')?.classList.remove('!hidden');
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
