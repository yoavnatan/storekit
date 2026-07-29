import { escapeHtml as esc } from '../lib/html-escape.js';

/**
 * Client half of StoreCategoryPicker.astro. Purely a convenience layer over a hidden
 * `categories` input — `/api/store.ts` re-runs `sanitizeStoreCategories()` on whatever
 * arrives, so nothing here is a security boundary.
 *
 * The one behaviour worth naming: a proposed new category that shares a significant
 * word with an existing one is a SOFT block. The seller sees the existing categories
 * offered first (picking one is what keeps the mall's filter from splitting), and a
 * second click on "add anyway" still goes through — the mall genuinely can't predict
 * every niche, and refusing outright would push sellers to pick a wrong category.
 */
import {
  findSimilarCategories,
  normalizeCategory,
  proposeCategory,
} from '../lib/store-taxonomy.js';

interface PickerI18n {
  search: string;
  add: string;
  addAnyway: string;
  full: string;
  remove: string;
}

const CHIP_CLASS =
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-[0.15rem] text-[0.78rem] font-medium ' +
  '[border-color:color-mix(in_srgb,var(--color-accent)_30%,var(--color-surface))] ' +
  '[background:color-mix(in_srgb,var(--color-accent)_9%,var(--color-surface))] ' +
  '[color:var(--color-accent-dark)]';

const OPTION_CLASS =
  'block w-full text-start px-3 py-[0.45rem] rounded-[var(--radius-sm)] text-[0.85rem] ' +
  'cursor-pointer bg-transparent border-0 [color:var(--color-text)] hover:[background:var(--color-bg)]';

export function initStoreCategoryPicker(root: HTMLElement): void {
  const valueInput = root.querySelector<HTMLInputElement>('.store-cat-picker__value');
  const chipsEl = root.querySelector<HTMLElement>('[data-chips]');
  const searchEl = root.querySelector<HTMLInputElement>('[data-search]');
  const listEl = root.querySelector<HTMLElement>('[data-list]');
  const msgEl = root.querySelector<HTMLElement>('[data-msg]');
  if (!valueInput || !chipsEl || !searchEl || !listEl || !msgEl) return;

  const max = Number(root.dataset.max || '3');
  const vocabulary: string[] = JSON.parse(root.dataset.vocabulary || '[]');
  const i18n: PickerI18n = JSON.parse(root.dataset.i18n || '{}');

  let chosen: string[] = valueInput.value.split(',').map((c) => c.trim()).filter(Boolean);
  /** Set once the seller has been shown the near-duplicate suggestions and still wants their label. */
  let insistOn: string | null = null;

  const sync = (): void => { valueInput.value = chosen.join(', '); };

  function renderChips(): void {
    chipsEl!.innerHTML = chosen.map((c) =>
      `<span class="${CHIP_CLASS}">${esc(c)}<button type="button" class="leading-none opacity-60 hover:opacity-100"
         data-remove="${esc(c)}" aria-label="${esc(i18n.remove)} ${esc(c)}">×</button></span>`).join('');
  }

  function setMessage(text: string): void {
    msgEl!.textContent = text;
    msgEl!.classList.toggle('hidden', !text);
  }

  function renderList(): void {
    const q = normalizeCategory(searchEl!.value);
    if (!q) { listEl!.classList.add('hidden'); listEl!.innerHTML = ''; setMessage(''); return; }

    const taken = new Set(chosen.map((c) => normalizeCategory(c)));
    // Substring matches, PLUS near-duplicates by word overlap. Without the second
    // set, typing "חשמל ואלקטרוניקה" told the seller a similar category exists but
    // gave them nothing to click — "אלקטרוניקה" doesn't contain that string
    // (browser-caught 2026-07-28). Suggestions come first: picking one is the whole
    // point of the message above them.
    const suggested = findSimilarCategories(searchEl!.value, vocabulary)
      .filter((c) => !taken.has(normalizeCategory(c)));
    const suggestedKeys = new Set(suggested.map((c) => normalizeCategory(c)));
    const matches = [
      ...suggested,
      ...vocabulary.filter((c) =>
        !taken.has(normalizeCategory(c)) &&
        !suggestedKeys.has(normalizeCategory(c)) &&
        normalizeCategory(c).includes(q)),
    ];

    const exact = vocabulary.some((c) => normalizeCategory(c) === q);
    const rows = matches.slice(0, 40).map((c) =>
      `<button type="button" class="${OPTION_CLASS}" data-pick="${esc(c)}" role="option">${esc(c)}</button>`);

    // Nothing in the vocabulary matches exactly → offer to create it, but run the
    // proposal first so the seller sees an existing near-duplicate before adding.
    if (!exact) {
      const proposal = proposeCategory(searchEl!.value, vocabulary);
      if (!proposal.ok && proposal.reason === 'unsafe') {
        setMessage(proposal.message);
        listEl!.innerHTML = rows.join('');
        listEl!.classList.toggle('hidden', !rows.length);
        return;
      }
      const similar = findSimilarCategories(searchEl!.value, vocabulary);
      const insisting = insistOn === q;
      if (!proposal.ok && proposal.reason === 'similar' && !insisting) {
        setMessage(proposal.message);
      } else if (!proposal.ok && (proposal.reason === 'empty' || proposal.reason === 'too-long')) {
        setMessage(proposal.message);
        listEl!.innerHTML = rows.join('');
        listEl!.classList.toggle('hidden', !rows.length);
        return;
      } else {
        setMessage('');
      }
      const label = similar.length && !insisting ? i18n.addAnyway : i18n.add;
      rows.push(
        `<button type="button" class="${OPTION_CLASS} font-semibold [color:var(--color-accent-dark)]"
           data-create="${esc(searchEl!.value.trim())}" role="option">${esc(label)} “${esc(searchEl!.value.trim())}”</button>`);
    } else {
      setMessage('');
    }

    listEl!.innerHTML = rows.join('');
    listEl!.classList.toggle('hidden', !rows.length);
  }

  function add(value: string): void {
    const v = normalizeCategory(value);
    if (!v) return;
    if (chosen.length >= max) { setMessage(i18n.full); return; }
    if (chosen.some((c) => normalizeCategory(c) === v)) return;
    chosen.push(value.trim());
    insistOn = null;
    searchEl!.value = '';
    sync(); renderChips(); renderList();
  }

  listEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-pick],[data-create]');
    if (!btn) return;
    e.preventDefault();
    const pick = btn.dataset.pick;
    if (pick) { add(pick); return; }
    const create = btn.dataset.create ?? '';
    const q = normalizeCategory(create);
    // First click on "add anyway" only records the intent and re-renders, so the
    // seller sees the suggestions once before their own wording wins.
    if (findSimilarCategories(create, vocabulary).length && insistOn !== q) { insistOn = q; renderList(); return; }
    add(create);
  });

  chipsEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-remove]');
    if (!btn) return;
    e.preventDefault();
    const target = normalizeCategory(btn.dataset.remove ?? '');
    chosen = chosen.filter((c) => normalizeCategory(c) !== target);
    sync(); renderChips(); renderList();
  });

  searchEl.addEventListener('input', () => { insistOn = null; renderList(); });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();  // never submit the whole settings form from this field
    const first = listEl.querySelector<HTMLElement>('[data-pick]');
    if (first?.dataset.pick) add(first.dataset.pick);
  });

  renderChips();
}

export function initAllStoreCategoryPickers(): void {
  document.querySelectorAll<HTMLElement>('.store-cat-picker').forEach(initStoreCategoryPicker);
}
