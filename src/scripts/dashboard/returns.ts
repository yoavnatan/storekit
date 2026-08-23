import { showToast, showActionFailedToast } from '../../lib/toast.js';
import { showFieldError, clearFieldError } from '../../lib/field-validity.js';
import { onPanelIntent } from './panel-intent.js';
import { toAgorot } from '../../lib/money.js';
import { createFloatingPortal, toolbarMenuTitle, filterClearButtonHtml } from '../../lib/toolbar-portal.js';
import { escapeHtml } from '../../lib/html-escape.js';
import { RETURN_REASON_LABELS, type ReturnReason } from '../../lib/returns.js';

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
/**
 * The moves that ask before they run — and, just as deliberately, the ones that do not.
 *
 * **The rule: irreversible AND it decides money or closes the case against somebody** (owner,
 * 2026-08-20: *"האם על כל אחד מהדברים שהם קריטיים יש גם מודל? שהלחיצה לא תקרה בטעות"*). This tab had
 * none at all, on a screen whose buttons sit two centimetres apart and move real money.
 *
 * **`approved` was left out and that was wrong (owner, 2026-08-20: *"גם אישורים צריכים מודל
 * בהחזרות, זה תנועה של כסף"*).** The reasoning had been that it is reversible — the machine does
 * allow approved → rejected — and reversibility is the wrong test here. Approving tells the buyer to
 * post the goods back, and from that moment the money is frozen and a refund is the expected end.
 * Undoing it after he has posted is not a correction, it is a second decision against him. The test
 * is whether the press COMMITS you, and this one does.
 *
 * The two that are still not here:
 *   · `received` — "it arrived here"; the case can still go to `disputed`, and the 2-business-day
 *     wait is stated on the card before and after.
 *   · `offered` — already two presses with a number typed between them. That IS the confirmation.
 *
 * Each dialog NAMES the amount. "Are you sure?" over a decision worth 49 shekels trains people to
 * press OK, which is worse than no dialog at all — the same reasoning the admin's dispute dialog is
 * built on, and the reason its own broken `body:` key was worth fixing the same day.
 */
/**
 * ── The COLOUR of the OK button is part of what the dialog says (owner, 2026-08-20) ──
 *
 * *"מודלים של אישורים לא צריך שיהיה בתוכם כפתור אדום, כי אם מאשרים משהו זה דבר שהוא נתפס כחיובי"*.
 * `ConfirmModal` ships its OK in the danger skin because most confirmations on this site guard a
 * delete, a block or a cancellation — and that default is exactly what makes red MEAN something.
 * Spending it on "אשר את ההחזרה" spends the only signal the platform has for "this one takes
 * something away", and it also contradicts the sentence beside it: approving is the seller doing the
 * ordinary, lawful thing, most often one he has no say in at all.
 *
 * So the tone travels with the words, per move, instead of being one constant at the dispatch below.
 * Positive/ordinary → `primary`; the three that close a case against somebody or move money out →
 * `danger`.
 */
type ConfirmSpec = { title: string; message: string; okLabel: string; tone: 'danger' | 'primary' };

const CONFIRMED_MOVES: Record<string, ((amount: string, items: number) => ConfirmSpec) | undefined> = {
  approved: (amount, items) => ({
    title: 'לאשר את ההחזרה?',
    // "אישור אי אפשר לבטל אחרי שהוא כבר שלח" until 2026-08-20 — the owner's note was that it
    // *"לא נשמע טוב"*, and the shape is why: it hangs the finality on something the buyer does
    // later, so a seller reading it cannot tell whether he still has a way back RIGHT NOW. He does
    // not — the approved card offers him no undo (`ReturnsPanel.astro#MOVES`) — so the plain
    // sentence is both kinder and more accurate. ("יישלח" was also simply the wrong verb: future
    // הפעיל is ישלח; יישלח is passive.)
    // Singular or plural, from the case's own line count (owner, 2026-08-21) — a dialog that says
    // "המוצר" over a three-item return is describing a different case from the one being approved.
    message: items > 1
      ? `הקונה ישלח לך את המוצרים בחזרה, והסכום של ${amount} יוקפא עד הגעתם. שים לב שאישור זה אינו ניתן לביטול.`
      : `הקונה ישלח לך את המוצר בחזרה, והסכום של ${amount} יוקפא עד הגעתו. שים לב שאישור זה אינו ניתן לביטול.`,
    okLabel: 'אשר את ההחזרה',
    tone: 'primary',
  }),
  refunded: (amount) => ({
    title: `להחזיר לקונה ${amount}?`,
    message: 'הסכום יירשם כחוב לקונה וירד לך מהתשלום הבא. שים לב שהחזר שבוצע אינו ניתן לביטול.',
    okLabel: 'החזר את הכסף',
    // Primary, not danger (owner, 2026-08-21). It moves money out, which is why it is confirmed at
    // all — but it is the ordinary, expected end of a return and the seller saying the goods came
    // back fine. Red is for the moves that close a case AGAINST somebody: refusing, and escalating.
    tone: 'primary',
  }),
  rejected: () => ({
    title: 'לסרב לבקשה?',
    message: 'הכסף יישאר אצלך והמוצר יישאר אצל הקונה. הוא יוכל לבקש מאיתנו לבדוק את הסירוב.',
    okLabel: 'סרב לבקשה',
    tone: 'danger',
  }),
  disputed: () => ({
    title: 'להעביר את המקרה להכרעה שלנו?',
    // Names what TRAVELS with it, since 2026-08-20 — the claim now carries the seller's sentence and,
    // if he attached one, his picture. A dialog that describes only the consequence and not the
    // evidence leaves him thinking somebody will come and ask him; nobody will.
    message: 'מה שכתבת והתמונה שצירפת יגיעו אלינו, ולפיהם נכריע. עד ההכרעה הכסף של ההזמנה הזאת לא ישוחרר אליך, ואי אפשר לבטל את הפנייה.',
    okLabel: 'העבר להכרעה',
    tone: 'danger',
  }),
};

/**
 * ── Sorting and filtering the case list (owner, 2026-08-23) ──
 *
 * *"בעייתית, קודם כל אין אפשרות למיין ואולי גם לפלטר לפי ממתין לטיפולי או לפי תאריך."*
 *
 * Everything below reads DATA ATTRIBUTES the server wrote on each card and never the words inside
 * it: the lane, the reason, the request date, the day this case's clock lands on, and the amount in
 * agorot. That is the rule the orders tab learned the hard way — a filter keyed on a rendered
 * Hebrew word breaks silently the first time a copy pass renames it, and it breaks as "the filter
 * finds nothing", which reads like missing data rather than like a bug.
 *
 * The DEFAULT order is written by the server, not applied here on load: `ReturnsPanel.astro` sorts
 * by the same three keys before rendering, so the first paint is already in urgency order and
 * nothing jumps when this file wakes up. The comparators must therefore agree, and
 * `tests/returns-sort.test.ts` is what keeps them agreeing.
 */
const LANE_RANK: Record<string, number> = { mine: 0, ours: 1, buyer: 2, closed: 3 };

/** Sorting keys, read off the card. `￿` for a missing clock — the last code point, so a case with
 *  no deadline sorts after every case that has one instead of jumping to the front of the queue. */
const laneRank = (el: HTMLElement): number => LANE_RANK[el.dataset.returnLane ?? 'closed'] ?? 3;
const dueKey = (el: HTMLElement): string => el.dataset.returnDue || '￿';
const createdKey = (el: HTMLElement): string => el.dataset.returnCreated ?? '';
const agorotKey = (el: HTMLElement): number => Number(el.dataset.returnAgorot ?? 0);
/** Code-point order, not `localeCompare` — the same helper the panel uses, for the reason its own
 *  comment gives: a collator may give the no-clock sentinel no weight, and the two renderers would
 *  then order one list two ways. */
const cmpKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type ReturnSortKey = 'urgency' | 'newest' | 'oldest' | 'highest' | 'lowest';

const RETURN_SORTS: { key: ReturnSortKey; label: string; cmp: (a: HTMLElement, b: HTMLElement) => number }[] = [
  {
    // Whose move it is first, then the nearest clock. A seller opening this tab is asking one
    // question — "what needs me, and what needs me soonest" — and this is that question as an
    // ordering. It is also why it is the default: the list should already be the answer.
    key: 'urgency',
    label: 'הדחוף ביותר',
    cmp: (a, b) => laneRank(a) - laneRank(b)
      || cmpKey(dueKey(a), dueKey(b))
      || cmpKey(createdKey(b), createdKey(a)),
  },
  { key: 'newest', label: 'הבקשה החדשה ביותר', cmp: (a, b) => cmpKey(createdKey(b), createdKey(a)) },
  { key: 'oldest', label: 'הבקשה הוותיקה ביותר', cmp: (a, b) => cmpKey(createdKey(a), createdKey(b)) },
  { key: 'highest', label: 'הסכום הגבוה ביותר', cmp: (a, b) => agorotKey(b) - agorotKey(a) },
  { key: 'lowest', label: 'הסכום הנמוך ביותר', cmp: (a, b) => agorotKey(a) - agorotKey(b) },
];

/**
 * The lanes the FILTER offers — and "נסגרה" is deliberately not among them.
 *
 * Closed cases are what the "הצג גם בקשות שנסגרו" checkbox governs, and it is the owner's own
 * control (2026-08-20). A filter value meaning the same thing two centimetres away would be a
 * second definition of one piece of state, which is the shape that ends with the two disagreeing
 * about what the seller is looking at. The words are `ReturnsPanel.astro`'s chip words, because a
 * chip that says one thing and a menu that offers another is two vocabularies for one fact.
 */
const LANE_FILTER: { value: string; label: string }[] = [
  { value: 'mine', label: 'ממתין לך' },
  { value: 'buyer', label: 'ממתין לקונה' },
  // ⚠️ Never "אצלנו" — on a seller's screen the first person is HIS. `ReturnsPanel.astro#LANE_LABEL`
  // carries the owner's ruling and the reason the buyer's dashboard is allowed the opposite word.
  { value: 'ours', label: 'ממתין להכרעת המערכת' },
];

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
  const closedBox = document.querySelector<HTMLInputElement>('[data-returns-show-closed]');
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

  /** Which values are ticked, per dimension. Empty set = that dimension narrows nothing — the same
   *  semantics the orders and messages filters use, so a seller who has learned one has learned
   *  all three. */
  const filters = new Map<'lane' | 'reason', Set<string>>();
  let sortKey: ReturnSortKey = 'urgency';

  function applyFilters(resetPage = true): void {
    if (resetPage) page = 1;
    const q = (search?.value ?? '').trim().toLowerCase();
    const showClosed = closedBox?.checked === true;
    const lanes = filters.get('lane');
    const reasons = filters.get('reason');

    // Pass 1: which cards MATCH, regardless of page.
    const matching: HTMLElement[] = [];
    // …and, in the same pass, whether ticking the box could add anything AT ALL under the current
    // search. A control that is on screen and does nothing is one the seller presses twice and then
    // stops trusting (owner, 2026-08-20) — so it goes grey instead of lying about being available.
    let closedMatches = 0;
    list!.querySelectorAll<HTMLElement>('[data-return-id]').forEach((card) => {
      const isClosed = card.hasAttribute('data-return-closed');
      const matches = (!q || (card.dataset.returnOrder ?? '').toLowerCase().includes(q))
        // A lane filter narrows the OPEN cases and is not asked of a closed one: "ממתין לך" and
        // "נסגרה" are answers to different questions, and making a closed case fail the lane test
        // would let a filter silently overrule the checkbox the seller just ticked.
        && (!lanes?.size || isClosed || lanes.has(card.dataset.returnLane ?? ''))
        && (!reasons?.size || reasons.has(card.dataset.returnReason ?? ''));
      if (matches && isClosed) closedMatches++;
      if (matches && (showClosed || !isClosed)) matching.push(card);
      else card.hidden = true;
    });

    // Order before paging, or page 2 holds cases that belong on page 1. Re-appending is what
    // actually moves them, and it is done ONLY when the order really changed: this function runs on
    // every keystroke in the search box, and moving twenty cards each time is twenty relayouts to
    // arrive at the arrangement already on screen.
    const before = matching.slice();
    matching.sort(RETURN_SORTS.find((s) => s.key === sortKey)?.cmp ?? RETURN_SORTS[0]!.cmp);
    if (matching.some((card, i) => card !== before[i])) matching.forEach((card) => list!.appendChild(card));
    // Never disabled while it is ON: that would strand the seller inside a view he cannot leave.
    if (closedBox) closedBox.disabled = closedMatches === 0 && !closedBox.checked;

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
  closedBox?.addEventListener('change', () => applyFilters());

  // ── The two toolbar menus ──
  //
  // One portal for both triggers, exactly as the orders toolbar does it: the module already knows
  // that moving from one pill to the other never passes through close(), and hands back the first
  // trigger's `aria-expanded` itself. Two portals would light both pills at once.
  const portal = createFloatingPortal('returns-toolbar-portal');
  const sortTrigger = document.getElementById('returns-sort-trigger');
  const filterTrigger = document.getElementById('returns-filter-trigger');
  const sortLabel = document.getElementById('returns-sort-label');
  const filterCount = document.getElementById('returns-filter-count');

  /** How many values are ticked, over both dimensions — the badge on the filter pill. It counts
   *  VALUES rather than dimensions so that a seller who narrowed to two lanes can see, from the
   *  closed menu, that he did. */
  function paintFilterCount(): void {
    if (!filterCount) return;
    let n = 0;
    filters.forEach((set) => { n += set.size; });
    filterCount.hidden = n === 0;
    filterCount.textContent = String(n);
  }

  /** The values of one dimension that actually occur in this shop's list. Offering a reason no case
   *  carries is offering a filter whose only possible result is the empty list. */
  function presentValues(attr: 'returnLane' | 'returnReason'): Set<string> {
    const seen = new Set<string>();
    list!.querySelectorAll<HTMLElement>('[data-return-id]').forEach((card) => {
      const v = card.dataset[attr];
      if (v) seen.add(v);
    });
    return seen;
  }

  function checkboxRow(dim: 'lane' | 'reason', value: string, label: string): string {
    const on = filters.get(dim)?.has(value) === true;
    return `<label class="product-menu__checkbox-item flex items-center gap-[.4rem] py-[.45rem] px-3 rounded-[var(--radius-sm)] cursor-pointer text-[.82rem] [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]">`
      + `<input type="checkbox" class="cursor-pointer shrink-0" data-ret-filter-dim="${dim}" data-ret-filter-value="${escapeHtml(value)}" ${on ? 'checked' : ''}>`
      + `${escapeHtml(label)}</label>`;
  }

  /**
   * Both dimensions in ONE menu, rather than the orders tab's drill-down.
   *
   * That tab has six columns and dozens of values, which is what a two-level menu is for. This one
   * has three lanes and four reasons: putting them behind a column list would be two presses to
   * reach a list of three, and a seller would meet "מצב" as a word before ever seeing that his own
   * queue is one of the choices.
   */
  function filterMenuHtml(): string {
    const reasonsPresent = presentValues('returnReason');
    const lanesPresent = presentValues('returnLane');
    const reasonRows = (Object.keys(RETURN_REASON_LABELS) as ReturnReason[])
      .filter((v) => reasonsPresent.has(v))
      .map((v) => checkboxRow('reason', v, RETURN_REASON_LABELS[v]));
    return [
      toolbarMenuTitle('מצב הטיפול'),
      ...LANE_FILTER.filter((l) => lanesPresent.has(l.value)).map((l) => checkboxRow('lane', l.value, l.label)),
      reasonRows.length ? toolbarMenuTitle('סיבת החזרה') : '',
      ...reasonRows,
      '<div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>',
      filterClearButtonHtml('data-ret-filter-clear', 'נקה סינון', [...filters.values()].some((s) => s.size > 0)),
    ].join('');
  }

  function openFilterMenu(trigger: HTMLElement): void {
    portal.open(trigger, '12rem', filterMenuHtml, (menu) => {
      menu.querySelectorAll<HTMLInputElement>('[data-ret-filter-value]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const dim = cb.dataset.retFilterDim as 'lane' | 'reason';
          const set = filters.get(dim) ?? new Set<string>();
          if (cb.checked) set.add(cb.dataset.retFilterValue ?? '');
          else set.delete(cb.dataset.retFilterValue ?? '');
          if (set.size) filters.set(dim, set); else filters.delete(dim);
          applyFilters();
          paintFilterCount();
          // Re-rendered rather than left as it was: the "נקה סינון" row at the bottom goes live or
          // grey with this tick, and a disabled row under a menu the seller is still using is the
          // one thing that would be stale.
          openFilterMenu(trigger);
        });
      });
      menu.querySelector('[data-ret-filter-clear]')?.addEventListener('click', () => {
        if (![...filters.values()].some((s) => s.size > 0)) return;
        filters.clear();
        applyFilters();
        paintFilterCount();
        openFilterMenu(trigger);
      });
    });
  }

  function openSortMenu(trigger: HTMLElement): void {
    portal.open(trigger, '13rem', () => toolbarMenuTitle('מיין לפי') + RETURN_SORTS.map((o) => {
      const on = o.key === sortKey;
      return `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-ret-sort="${o.key}" style="${on ? 'font-weight:700;color:var(--color-primary)' : ''}">${escapeHtml(o.label)}</button>`;
    }).join(''), (menu) => {
      menu.querySelectorAll<HTMLButtonElement>('[data-ret-sort]').forEach((btn) => {
        btn.addEventListener('click', () => {
          sortKey = (btn.dataset.retSort as ReturnSortKey) ?? 'urgency';
          if (sortLabel) sortLabel.textContent = RETURN_SORTS.find((s) => s.key === sortKey)?.label ?? '';
          applyFilters();
          portal.close();
        });
      });
    });
  }

  sortTrigger?.addEventListener('click', () => {
    if (portal.currentTrigger() === sortTrigger) portal.close();
    else openSortMenu(sortTrigger);
  });
  filterTrigger?.addEventListener('click', () => {
    if (portal.currentTrigger() === filterTrigger) portal.close();
    else openFilterMenu(filterTrigger);
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
    if (closedBox) { closedBox.disabled = false; closedBox.checked = true; }
    // And the lane/reason filters OFF, for exactly the same reason. A seller who narrowed to
    // "ממתין לך", went to the orders tab and followed a return chip back would arrive at a list
    // that hides the one case the chip named — the shape of link that reads as broken.
    filters.clear();
    paintFilterCount();
    applyFilters();
  });

  // Paint once, so a shop with more than one page arrives on page 1 rather than showing everything.
  applyFilters();

  /**
   * Photos already uploaded, per card — the URL Cloudinary answered with, waiting for the press
   * that sends the claim.
   *
   * A `WeakMap` keyed by the card element rather than a field on it: the value is a URL, and a URL
   * parked in the DOM is a URL some other renderer can read back and put in an attribute. It also
   * disappears with the card, which is what a page-reload-after-move wants.
   */
  const uploadedPhoto = new WeakMap<HTMLElement, string>();

  // The upload happens on CHOOSING the file, not on submitting the claim — a file crossing the
  // network while the seller stares at a dead button is how an upload gets pressed twice. Every
  // outcome is spoken beside the field (audit row 11: a dropped request must never look idle).
  list.addEventListener('change', (e) => {
    const input = (e.target as HTMLElement | null)?.closest<HTMLInputElement>('[data-dispute-photo]');
    if (!input?.files?.length) return;
    const card = input.closest<HTMLElement>('[data-return-id]');
    const state = card?.querySelector<HTMLElement>('[data-dispute-photo-state]');
    const cloud = input.dataset.cloudName ?? '';
    const preset = input.dataset.cloudPreset ?? '';
    if (!cloud || !preset) return;
    if (state) state.textContent = 'מעלה…';
    void (async () => {
      try {
        const { cloudinaryUpload } = await import('./cloudinary.js');
        const url = await cloudinaryUpload(input.files![0]!, cloud, preset);
        if (card) uploadedPhoto.set(card, url);
        if (state) state.textContent = 'התמונה צורפה';
      } catch {
        if (state) state.textContent = 'ההעלאה נכשלה. אפשר להמשיך בלי תמונה.';
        input.value = '';
      }
    })();
  });

  // ── The offer row's own two buttons ──
  //
  // `שלח` forwards to the card's `הצע החזר חלקי` button, which already owns the whole move: this
  // way the validation, the request and the failure handling stay in ONE place instead of becoming
  // a second copy that drifts the first time either changes. `ביטול` closes the field and clears
  // it, so re-opening never offers a number the seller decided against.
  list.addEventListener('click', (e) => {
    const el = e.target as HTMLElement | null;
    const send = el?.closest<HTMLButtonElement>('[data-offer-send]');
    const cancel = el?.closest<HTMLButtonElement>('[data-offer-cancel]');
    if (!send && !cancel) return;
    const card = el!.closest<HTMLElement>('[data-return-id]');
    const field = card?.querySelector<HTMLInputElement>('[data-offer-amount]');
    if (cancel) {
      if (field) { field.value = ''; clearFieldError(field); field.hidden = true; }
      return;
    }
    card?.querySelector<HTMLButtonElement>('[data-return-move="offered"]')?.click();
  });

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

    /**
     * The empty-parcel claim, and why it is the same two-press shape as the offer.
     *
     * `received → disputed` is the seller asserting something about goods only he has seen, and it
     * used to be one press that sent nothing at all — so the case reached a person carrying the
     * buyer's note and photo and none of his (owner, 2026-08-20: *"מה זה עוזר שזה מגיע אליי
     * להכרעה, מה אני אמור לעשות עם זה?"*). First press reveals the fields, second press sends.
     *
     * The sentence is required and the server refuses without it (`/api/returns`); the error lands
     * ON the field, in the site's one style, because a toast reports something that happened
     * elsewhere. The photo is optional and uploaded when chosen, not when submitted — a file
     * crossing the network while the seller stares at a dead button is how an upload gets pressed
     * twice.
     */
    let sellerNote: string | undefined;
    if (to === 'disputed') {
      const field = card?.querySelector<HTMLTextAreaElement>('[data-dispute-note]');
      if (field && field.hidden) {
        field.hidden = false;
        field.focus();
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      const said = (field?.value ?? '').trim();
      if (field) clearFieldError(field);
      if (said.length < 3) {
        if (field) showFieldError(field, 'כתוב כמה מילים על מה שהיה בחבילה');
        field?.focus();
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      sellerNote = said;
    }

    // An offer needs a number, and it is the only move on this screen that does. Asked with a
    // prompt-free inline field rather than `prompt()`, which is banned platform-wide — the field is
    // already on the card, hidden until this button is pressed.
    let partialOfferAgorot: number | undefined;
    /**
     * The offer, and the two faults the owner found in its first shape (2026-08-21).
     *
     * It used to be the same button twice: the first press revealed a field, the second sent it.
     * *"לא ברור איפה צריך ללחוץ, אין שם עוד כפתור"* — and he had worked it out and still said so,
     * which is the tell. A revealed field with nothing beside it looks like it is waiting for
     * Enter, and the button that opened it has visibly already been used. It now opens a row with
     * its own שלח and ביטול, wired below; this branch only ever RUNS from that שלח.
     *
     * And the amount has a CEILING. The server has always clamped to the case's full refund, but
     * silently — so 900 typed on a 49 ₪ return was accepted, stored as 49, and nothing said so.
     * A number quietly changed on its way to the database is worse than a refusal.
     */
    if (to === 'offered') {
      const field = card?.querySelector<HTMLInputElement>('[data-offer-amount]');
      if (field && field.hidden) {
        field.hidden = false;
        field.value = '';
        field.focus();
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      const shekels = Number(field?.value ?? '');
      const ceiling = Number(field?.max ?? '') || Infinity;
      if (field) clearFieldError(field);
      if (!Number.isFinite(shekels) || shekels <= 0) {
        // On the field, not in a toast — the same correction the admin's decision screen took the
        // same day (owner, 2026-08-20). A toast reports something that happened elsewhere; a field
        // that is wrong says so where it is wrong, in the site's one style (`lib/field-validity.ts`).
        if (field) showFieldError(field, 'צריך סכום גדול מאפס');
        field?.focus();
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      if (shekels > ceiling) {
        if (field) showFieldError(field, `הסכום גבוה מההחזר עצמו. אפשר להציע עד ${ceiling} ₪`);
        field?.focus();
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      // Agorot at the boundary, like every other amount that crosses into the server (money.ts).
      partialOfferAgorot = toAgorot(shekels);
    }

    const send = (): void => {
      void (async () => {
      try {
        const res = await fetch('/api/returns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id, to,
            ...(partialOfferAgorot ? { partialOfferAgorot } : {}),
            ...(sellerNote ? { sellerNote } : {}),
            // Only when an upload actually finished. Sending the key with `undefined` would be the
            // same as omitting it; sending it EMPTY would COALESCE a stored URL away on a later move.
            ...(card && uploadedPhoto.get(card) ? { sellerPhotoUrl: uploadedPhoto.get(card) } : {}),
          }),
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
    };

    const ask = CONFIRMED_MOVES[to];
    if (!ask) { send(); return; }
    // The tone comes from the spec, never from here: a constant at the dispatch is how "approve"
    // ended up wearing the delete button's colour in the first place.
    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: { ...ask(btn.dataset.returnAmount ?? '', Number(btn.dataset.returnItems) || 1), onConfirm: send },
    }));
    // The card's buttons come back on: the seller may still say no in the dialog, and a card left
    // dead behind a cancelled confirmation is the same bug as a request that failed silently.
    buttons.forEach((b) => { b.disabled = false; });
  });
}
