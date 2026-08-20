import { showToast, showActionFailedToast } from '../../lib/toast.js';
import { onPanelIntent } from './panel-intent.js';
import { toAgorot } from '../../lib/money.js';

/**
 * The returns tab's buttons — the seller's four verbs, wired to the one route.
 *
 * ── Every failure is spoken ──
 * A dropped request must not leave the button re-enabled and the screen looking idle, which is the
 * whole class `tests/silent-failure-guard.test.ts` exists to refuse (audit row 11). So: one `catch`
 * for the network, an explicit read of `res.ok`, and the server's own message when it sent one —
 * the API answers 409 with a sentence a person can act on ("בקשה כזאת כבר פתוחה"), and swallowing
 * that in favour of a generic toast would throw away the only useful part.
 *
 * ── Why the page reloads instead of patching the card ──
 * A move changes more than the card: the tab badge, the payments tab's held total, and — on a
 * refund — the order's own status. Patching one card would leave three surfaces stale and disagreeing
 * with each other, which is precisely the "money and what a seller SEES disagree" class this project
 * audited. A reload is a few hundred milliseconds on a tab that is opened rarely, and it cannot be
 * wrong.
 */
export function initReturnsTab(): void {
  const list = document.querySelector<HTMLElement>('[data-returns-list]');
  if (!list || list.dataset.wired) return;
  list.dataset.wired = '1';

  // ── Search and the open/closed switch ──
  //
  // Client-side because the whole set is already on the page (`getReturnsForStore` returns every case
  // for the shop), so a query per keystroke would be slower and no more correct. One function decides
  // visibility from both controls at once — two independent handlers each hiding rows is how a filter
  // and a search end up fighting over the same element.
  const search = document.querySelector<HTMLInputElement>('[data-returns-search]');
  const closedBtn = document.querySelector<HTMLButtonElement>('[data-returns-show-closed]');
  const emptyMsg = document.querySelector<HTMLElement>('[data-returns-empty]');

  // ── The pager, and it only exists when there is something to page ──
  //
  // The owner's rule: a pager that depends on the count and stays out of sight below it. A control
  // that always reads "1 מתוך 1" teaches a seller to ignore the exact spot a real pager will later
  // appear — the same reasoning the admin's reconciliation card is built on.
  //
  // Paging happens AFTER filtering and over the visible set, which is the only order that behaves:
  // paging first would leave a page that filters down to nothing while page 2 has every match on it.
  const pager = document.querySelector<HTMLElement>('[data-returns-pager]');
  const pageLabel = document.querySelector<HTMLElement>('[data-returns-page-label]');
  const prevBtn = document.querySelector<HTMLButtonElement>('[data-returns-prev]');
  const nextBtn = document.querySelector<HTMLButtonElement>('[data-returns-next]');
  const pageSize = Number(list.dataset.returnsPageSize) || 20;
  let page = 1;

  function applyFilters(resetPage = true): void {
    if (resetPage) page = 1;
    const q = (search?.value ?? '').trim().toLowerCase();
    const showClosed = closedBtn?.getAttribute('aria-pressed') === 'true';

    // Pass 1: which cards MATCH, regardless of page.
    const matching: HTMLElement[] = [];
    list!.querySelectorAll<HTMLElement>('[data-return-id]').forEach((card) => {
      const isClosed = card.hasAttribute('data-return-closed');
      const matches = !q || (card.dataset.returnOrder ?? '').toLowerCase().includes(q);
      if (matches && (showClosed || !isClosed)) matching.push(card);
      else card.hidden = true;
    });

    const pages = Math.max(1, Math.ceil(matching.length / pageSize));
    if (page > pages) page = pages;

    // Pass 2: of those, which are on this page.
    const from = (page - 1) * pageSize;
    matching.forEach((card, i) => { card.hidden = i < from || i >= from + pageSize; });

    // A list that filtered to nothing has to SAY so — an empty container reads as a broken tab
    // (audit row 11: a failure dressed as a fact about the data).
    if (emptyMsg) emptyMsg.hidden = matching.length > 0;

    if (pager) {
      pager.hidden = matching.length <= pageSize;
      if (pageLabel) pageLabel.textContent = `${page} מתוך ${pages}`;
      if (prevBtn) prevBtn.disabled = page <= 1;
      if (nextBtn) nextBtn.disabled = page >= pages;
    }
  }

  prevBtn?.addEventListener('click', () => { if (page > 1) { page--; applyFilters(false); } });
  nextBtn?.addEventListener('click', () => { page++; applyFilters(false); });

  search?.addEventListener('input', () => applyFilters());
  closedBtn?.addEventListener('click', () => {
    const on = closedBtn.getAttribute('aria-pressed') === 'true';
    closedBtn.setAttribute('aria-pressed', String(!on));
    closedBtn.classList.toggle('!border-[color:var(--color-primary)]', !on);
    applyFilters();
  });

  // ── Arrived from an order card's return chip? ──
  //
  // The chip records the intent and clicks the tab; this collects it, exactly once
  // (`panel-intent.ts` argues why the traffic runs in this direction and not the other).
  //
  // **It turns the closed cases ON, and that is the whole point rather than a nicety.** The chip is
  // drawn from the LATEST request on that order, open or not, so following one for a case that has
  // since been refused or refunded would land on a filtered list that hides the very row it named —
  // a link that goes somewhere and shows nothing, which reads as the feature being broken.
  onPanelIntent('returns', (intent) => {
    if (!intent.search) return;
    if (search) search.value = intent.search;
    // Closed cases ON, and that is the point rather than a nicety. The chip is drawn from the
    // LATEST request on that order, open or not, so following one for a case that has since been
    // refused or refunded would land on a filtered list hiding the very row it named — a link that
    // goes somewhere and shows nothing, which reads as the feature being broken.
    if (closedBtn && closedBtn.getAttribute('aria-pressed') !== 'true') closedBtn.click();
    else applyFilters();
  });

  // Paint once, so a shop with more than one page arrives on page 1 rather than showing everything.
  applyFilters();

  list.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-return-move]');
    if (!btn) return;
    const to = btn.dataset.returnMove;
    const id = btn.dataset.returnTarget;
    if (!to || !id) return;

    // Disable the whole card's buttons, not just the one pressed: "approve" and "reject" sit beside
    // each other, and a second click while the first is in flight is a race whose loser gets a 409
    // that reads like a bug.
    const card = btn.closest<HTMLElement>('[data-return-id]');
    const buttons = card ? [...card.querySelectorAll<HTMLButtonElement>('button')] : [btn];
    buttons.forEach((b) => { b.disabled = true; });

    // An offer needs a number, and it is the only move on this screen that does. Asked with a
    // prompt-free inline field rather than `prompt()`, which is banned platform-wide — the field is
    // already on the card, hidden until this button is pressed.
    let partialOfferAgorot: number | undefined;
    if (to === 'offered') {
      const field = card?.querySelector<HTMLInputElement>('[data-offer-amount]');
      if (field && field.hidden) {
        field.hidden = false;
        field.focus();
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      const shekels = Number(field?.value ?? '');
      if (!Number.isFinite(shekels) || shekels <= 0) {
        showToast('לא בוצע', 'צריך לכתוב סכום גדול מאפס');
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      // Agorot at the boundary, like every other amount that crosses into the server (money.ts).
      partialOfferAgorot = toAgorot(shekels);
    }

    void (async () => {
      try {
        const res = await fetch('/api/returns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, to, ...(partialOfferAgorot ? { partialOfferAgorot } : {}) }),
        });
        if (!res.ok) {
          const said = await res.json().catch(() => null) as { error?: string } | null;
          // The server's sentence when it has one — it knows why, and this does not.
          if (said?.error) showToast('לא בוצע', said.error);
          else showActionFailedToast();
          buttons.forEach((b) => { b.disabled = false; });
          return;
        }
        location.reload();
      } catch {
        showActionFailedToast();
        buttons.forEach((b) => { b.disabled = false; });
      }
    })();
  });
}
