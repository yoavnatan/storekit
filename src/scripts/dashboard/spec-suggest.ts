/**
 * Attribute suggestions under the product form's "מפרט" rows — the write side of the store page's
 * filter panel (`lib/product-facets.ts`).
 *
 * **Why it exists.** The filter panel reads the spec rows a seller already fills, which is what
 * makes the whole feature free of new fields. The price of reading free text is drift: `3-5`,
 * `גילאי 3-5` and `3 עד 5` are one attribute to a shopper and three chips in the panel. Normalising
 * on the READ side can only fold differences that carry no meaning (case, spacing, dashes); it must
 * not guess that two different words mean the same thing. So convergence happens here, at the
 * moment of typing, by offering what this store has already used — and by offering only, never by
 * requiring, rewriting or rejecting (memory `feedback_seller_form_burden`).
 *
 * **One suggestion row, not one per spec row.** It sits under the whole field and changes what it
 * offers with the focus: attribute NAMES by default, and the VALUES this store has used for an
 * attribute while that row's value box has the caret. A row per input would put three suggestion
 * strips inside one field, which is more chrome than the field itself.
 *
 * **`mousedown` and not `click`** on the chips: a click on a chip would blur the input first, the
 * strip would repaint as the label list mid-gesture, and the button under the finger would no
 * longer be the button that gets clicked.
 *
 * The vocabulary is fetched once per page from `/api/store-spec-vocabulary`, lazily — most visits
 * to the products tab never open an editor, and the tab is already the heaviest page here
 * (memory `project_dashboard_html_weight`).
 */
import { matchSuggestions, MAX_SUGGESTED_VALUES, type SpecVocabulary } from '../../lib/spec-vocabulary.js';
import { facetKey } from '../../lib/product-facets.js';
import { escapeHtml } from '../../lib/html-escape.js';
import { announceValueChange } from './unsaved-guard.js';

/** Chips in the strip. Beyond this it stops reading as a hint and starts reading as a list. */
const MAX_CHIPS = 6;

let vocabulary: SpecVocabulary | null = null;
let inFlight: Promise<SpecVocabulary | null> | null = null;

function i18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}') as Record<string, string>; }
  catch { return {}; }
}

/**
 * Fetched once and kept for the page.
 *
 * silent: a failure here is deliberately not shown. This request is not something the seller asked
 * for — it fires on their first focus into the מפרט rows — and what it buys is a row of optional
 * hints. Reporting it would interrupt someone mid-form about a convenience they never requested,
 * and the form itself is entirely usable without it. `null` is cached rather than retried for the
 * same reason: re-requesting on every focus is a worse failure than quietly offering nothing.
 */
async function loadVocabulary(): Promise<SpecVocabulary | null> {
  if (vocabulary) return vocabulary;
  if (inFlight) return inFlight;
  const storeId = (document.getElementById('upload-config') as HTMLElement | null)?.dataset.storeId ?? '';
  if (!storeId) return null;
  inFlight = (async () => {
    try {
      const res = await fetch(`/api/store-spec-vocabulary?storeId=${encodeURIComponent(storeId)}`);
      const data = await res.json() as { ok?: boolean; entries?: SpecVocabulary['entries'] };
      if (!data.ok || !Array.isArray(data.entries)) return null;
      vocabulary = { entries: data.entries };
      return vocabulary;
    } catch {
      // silent: nobody asked for this request — it fires on the seller's first focus into the
      // מפרט rows and buys a row of optional hints. Interrupting someone mid-form about a
      // convenience they never requested is the worse failure; the form works without it.
      return null;
    }
  })();
  return inFlight;
}

function chipHtml(value: string, kind: 'label' | 'value'): string {
  return `<button type="button" class="spec-suggest-chip" data-spec-suggest="${kind}" data-value="${escapeHtml(value)}">`
    + `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`
    + escapeHtml(value) + '</button>';
}

/** The labels already on this product — never re-offered, since adding one twice is a no-op row. */
function usedLabels(field: HTMLElement): Set<string> {
  const used = new Set<string>();
  field.querySelectorAll<HTMLInputElement>('input[name="specs_label"]').forEach((input) => {
    const key = facetKey(input.value);
    if (key) used.add(key);
  });
  return used;
}

/**
 * Paint the strip for the current focus.
 *
 * `focused` is the value input with the caret, when there is one — that is what turns this from a
 * list of attribute names into the list of values this store spells that attribute with.
 */
function render(field: HTMLElement, focused: HTMLInputElement | null): void {
  const strip = field.querySelector<HTMLElement>('[data-spec-suggestions]');
  if (!strip || !vocabulary) return;
  const t = i18n();
  let chips: string[] = [];
  let kind: 'label' | 'value' = 'label';

  if (focused) {
    const row = focused.closest('.specs-row');
    const labelInput = row?.querySelector<HTMLInputElement>('input[name="specs_label"]');
    const labelKey = facetKey(labelInput?.value ?? '');
    const entry = labelKey ? vocabulary.entries.find((e) => facetKey(e.label) === labelKey) : undefined;
    if (entry) {
      kind = 'value';
      chips = matchSuggestions(entry.values, focused.value, Math.min(MAX_CHIPS, MAX_SUGGESTED_VALUES))
        .map((v) => chipHtml(v, 'value'));
    }
  }

  if (!chips.length) {
    // Either nothing is focused, or the row's attribute is one we have no values for — in both
    // cases the useful offer is the attribute names this store has not used on this product yet.
    kind = 'label';
    const used = usedLabels(field);
    chips = vocabulary.entries
      .filter((e) => !used.has(facetKey(e.label)))
      .slice(0, MAX_CHIPS)
      .map((e) => chipHtml(e.label, 'label'));
  }

  if (!chips.length) {
    strip.style.display = 'none';
    strip.innerHTML = '';
    return;
  }
  const caption = kind === 'value' ? (t.specsSuggestValues ?? '') : (t.specsSuggestLabels ?? '');
  strip.innerHTML = `<span class="spec-suggest-caption">${escapeHtml(caption)}</span>${chips.join('')}`;
  strip.style.display = 'flex';
}

/** The one place a new spec row is built, so the markup matches `specsEditorHtml`'s exactly. */
function addRow(field: HTMLElement, label: string): HTMLInputElement | null {
  const rows = field.querySelector<HTMLElement>('.specs-rows');
  if (!rows) return null;
  const t = i18n();
  // An empty row already waiting is filled instead of stacking a second one beneath it.
  const empty = [...rows.querySelectorAll<HTMLInputElement>('input[name="specs_label"]')]
    .find((input) => !input.value.trim());
  if (empty) {
    empty.value = label;
    announceValueChange(empty);
    return empty.closest('.specs-row')?.querySelector<HTMLInputElement>('input[name="specs_value"]') ?? null;
  }
  const row = document.createElement('div');
  row.className = 'specs-row';
  row.style.cssText = 'display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem';
  row.innerHTML = `
    <input class="input" name="specs_label" value="${escapeHtml(label)}" placeholder="${escapeHtml(rows.dataset.labelPlaceholder ?? '')}" style="width:170px;flex:0 0 auto">
    <input class="input" name="specs_value" placeholder="${escapeHtml(rows.dataset.valuePlaceholder ?? '')}" style="width:220px;flex:0 0 auto">
    <button type="button" class="specs-remove-row btn btn--ghost btn--sm" aria-label="${escapeHtml(t.specsRemoveRow ?? 'Remove')}">×</button>`;
  rows.appendChild(row);
  return row.querySelector<HTMLInputElement>('input[name="specs_value"]');
}

/**
 * Delegated on `document`, because the spec editor is built and rebuilt as inline edit rows open —
 * there is nothing stable to bind to, and re-binding per editor is how a listener ends up attached
 * three times to one field.
 */
export function initSpecSuggestions(): void {
  document.addEventListener('focusin', (event) => {
    const target = event.target as HTMLElement | null;
    const field = target?.closest<HTMLElement>('[data-specs-field]');
    if (!field) return;
    const focused = target?.matches('input[name="specs_value"]') ? target as HTMLInputElement : null;
    if (vocabulary) { render(field, focused); return; }
    // First focus in any spec field on this page pays for the fetch; the strip appears when it
    // lands, which is the same shape the tag suggestions already have.
    void loadVocabulary().then(() => {
      const stillHere = document.activeElement?.closest<HTMLElement>('[data-specs-field]');
      if (stillHere === field) {
        const active = document.activeElement as HTMLElement | null;
        render(field, active?.matches('input[name="specs_value"]') ? active as HTMLInputElement : null);
      }
    });
  });

  // Typing in a value box narrows the offer; typing in a label box changes which attribute the
  // values belong to, so both repaint.
  document.addEventListener('input', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.matches('input[name="specs_label"], input[name="specs_value"]')) return;
    const field = target.closest<HTMLElement>('[data-specs-field]');
    if (!field) return;
    const active = document.activeElement as HTMLElement | null;
    render(field, active?.matches('input[name="specs_value"]') ? active as HTMLInputElement : null);
  });

  /**
   * "בטל שינויים" and a recovered draft both replace the מפרט rows from OUTSIDE this module and
   * announce it with `dash:fieldsrewritten`. The strip derives what it offers FROM those rows —
   * it hides an attribute the product already carries — so without this it keeps offering the
   * vocabulary of the form as it was before the rows were swapped.
   */
  document.addEventListener('dash:fieldsrewritten', () => {
    document.querySelectorAll<HTMLElement>('[data-specs-field]').forEach((field) => render(field, null));
  });

  document.addEventListener('mousedown', (event) => {
    const chip = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-spec-suggest]');
    if (!chip) return;
    const field = chip.closest<HTMLElement>('[data-specs-field]');
    if (!field) return;
    // Keeps the caret where it was — see the header. Without this the strip has already repainted
    // by the time the click lands, and the chip under the cursor is a different one.
    event.preventDefault();
    const value = chip.dataset.value ?? '';
    if (chip.dataset.specSuggest === 'value') {
      const active = document.activeElement as HTMLInputElement | null;
      if (active?.matches('input[name="specs_value"]')) {
        active.value = value;
        // The form's own change tracking (unsaved guard, record-rev merge) listens for `input`,
        // which a programmatic assignment does not fire — announceValueChange is the one place
        // that says so (unsaved-guard.ts).
        announceValueChange(active);
      }
      render(field, document.activeElement as HTMLInputElement | null);
      return;
    }
    const valueInput = addRow(field, value);
    if (valueInput) announceValueChange(valueInput);
    valueInput?.focus();
    render(field, valueInput);
  });
}
