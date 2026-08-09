import type { CategoryNode } from '../../lib/store-categories.js';
import { getCategoryTree, setCategoryTree } from './category-tree-cache.js';
import { escapeHtml as esc } from '../../lib/html-escape.js';
import { formatScopeNames } from '../../lib/sale-scope-label.js';
import { announceValueChange } from './unsaved-guard.js';

const MAX_CATEGORY_DEPTH = 3;

const BTN_CLASSES = 'text-[0.76rem] font-medium text-[color:var(--color-muted)] bg-transparent border border-[color:var(--color-border)] rounded-[var(--radius-sm)] py-1 px-2 cursor-pointer whitespace-nowrap transition-colors duration-[120ms] hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-text)]';
const ADD_CLASSES = 'block w-full text-start py-[0.4rem] px-[0.6rem] mt-[0.15rem] rounded-[var(--radius-sm)] text-[0.8rem] font-semibold text-[color:var(--color-primary)] bg-transparent cursor-pointer transition-colors duration-100 hover:bg-[color:var(--color-bg)]';
const ADD_ROOT_CLASSES = 'block w-full text-start py-[0.4rem] px-[0.6rem] mt-[0.3rem] pt-2 rounded-[var(--radius-sm)] text-[0.8rem] font-semibold text-[color:var(--color-primary)] bg-transparent border-t border-[color:var(--color-border)] cursor-pointer transition-colors duration-100 hover:bg-[color:var(--color-bg)]';
const EXPAND_CLASSES = 'shrink-0 w-5 h-5 flex items-center justify-center text-[color:var(--color-muted)] rounded-[var(--radius-sm)] transition-[transform,background-color] duration-150 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:bg-[color:var(--color-bg)] data-[open]:rotate-90';
const EXPAND_SPACER_CLASSES = 'shrink-0 w-5 h-5';
const OPTION_BASE_CLASSES = 'flex-1 block text-start py-[0.4rem] px-[0.6rem] rounded-[var(--radius-sm)] text-[0.84rem] bg-transparent border-0 cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis transition-colors duration-100 hover:bg-[color:var(--color-bg)]';

/** In multi-pick the ticked rows are the whole state of the field, so they can't be told apart
 *  by colour alone (accessibility: never colour-only state) — and with several ticks on screen
 *  at once a mark is also just faster to scan than weight+hue. Single-pick keeps the plain row:
 *  one bold entry among many is unambiguous, and a tick column would indent every menu on the
 *  product form for one selected item. */
function tickHtml(show: boolean, selected: boolean): string {
  if (!show) return '';
  return selected
    ? '<svg class="inline-block align-[-0.15em] me-1.5 shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<span class="inline-block align-[-0.15em] me-1.5 w-3 shrink-0" aria-hidden="true"></span>';
}

function optionClasses(selected: boolean, isNone: boolean): string {
  if (selected) return `${OPTION_BASE_CLASSES} font-bold text-[color:var(--color-primary)]`;
  if (isNone) return `${OPTION_BASE_CLASSES} text-[color:var(--color-muted)]`;
  return `${OPTION_BASE_CLASSES} text-[color:var(--color-text)]`;
}

function getDashI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}')?.dashboard ?? {}; }
  catch { return {}; }
}

function findTrail(id: string): string[] | null {
  function find(nodes: CategoryNode[], trail: string[]): string[] | null {
    for (const n of nodes) {
      if (n.id === id) return [...trail, n.name];
      const nested = find(n.children, [...trail, n.name]);
      if (nested) return nested;
    }
    return null;
  }
  return find(getCategoryTree(), []);
}

function pathLabel(id: string): string {
  return findTrail(id)?.join(' › ') ?? '';
}

/** Just the category's own name — what a multi-pick label lists, since a row of full paths
 *  reads as noise once there is more than one of them. */
function nameLabel(id: string): string {
  const trail = findTrail(id);
  return trail?.[trail.length - 1] ?? '';
}

function showError(message: string): void {
  if (!message) return;
  (window as unknown as { showToast?: (title: string, body: string) => void }).showToast?.(message, '');
}

/** Wires up one .category-picker instance — a dashboard-native pill+panel dropdown (matches
 *  .order-status-dropdown's visual language) whose panel is itself a nested accordion, not a
 *  flat list: a category with subcategories expands in place. Each level also has its own
 *  "+ add" row, wired straight to /api/store-category, so a seller can build out the tree
 *  without leaving the product form. Call once per instance — the add-product form's single
 *  picker, and each product row's own (existing rows at load, new ones after add/AJAX-render). */
export function initCategoryPicker(root: HTMLElement): void {
  if (root.dataset.pickerBound === '1') return;
  root.dataset.pickerBound = '1';

  // Field name is configurable so a second consumer can live on the same page without two
  // pickers fighting over one input name — the promotions tab's sale scope posts
  // `saleCategoryId`, the product forms keep `categoryId` (the default).
  const inputName = root.dataset.pickerInput ?? 'categoryId';
  // `data-picker-add="off"` makes the picker a pure chooser. Creating a category is a CATALOG
  // decision; the promotions tab is only asking which existing part of the catalog a sale
  // covers, and offering "+ add" there invites a seller to invent a category as a side effect
  // of running a sale — a tree they never meant to reshape, from a screen that doesn't show it.
  const canAdd = root.dataset.pickerAdd !== 'off';
  // `data-picker-multi="on"` — a sale may cover several categories, a product is filed under
  // exactly one. Same picker, and the multi one carries its ids comma-joined in the same single
  // hidden input, so the form posts one field either way.
  const multi = root.dataset.pickerMulti === 'on';
  // Translated "and {n} more" for the collapsed tail, handed in by the consumer so this label
  // and the storefront banner word one sale identically (sale-scope-label.ts).
  const andMore = root.dataset.pickerMoreLabel ?? '+{n}';
  const hiddenInput = root.querySelector<HTMLInputElement>(`input[name="${inputName}"]`);
  const trigger = root.querySelector<HTMLButtonElement>('.category-picker__trigger');
  const labelEl = root.querySelector<HTMLElement>('.category-picker__label');
  const menu = root.querySelector<HTMLElement>('.category-picker__menu');
  if (!hiddenInput || !trigger || !labelEl || !menu) return;

  const selectedIds: string[] = hiddenInput.value.split(',').map((s) => s.trim()).filter(Boolean);
  const isSelected = (id: string): boolean => (id ? selectedIds.includes(id) : !selectedIds.length);
  const expanded = new Set<string>();
  // undefined = no add-row open; null = adding a root category; string = adding under that parent id.
  let addingUnderId: string | null | undefined;

  function storeId(): string {
    return document.getElementById('category-tree-editor')?.getAttribute('data-store-id') ?? '';
  }

  /** Mirrors the banner's own rule (sale-scope-label.ts): one pick keeps its full path, several
   *  are named plainly and the tail past two collapses into a count. The seller reads here
   *  exactly the line a shopper will read there. */
  function updateLabel(): void {
    const i = getDashI18n();
    if (!selectedIds.length) { labelEl!.textContent = i.categoryNone ?? ''; return; }
    const names = selectedIds.length === 1
      ? [pathLabel(selectedIds[0]!)]
      : selectedIds.map((id) => nameLabel(id));
    labelEl!.textContent = formatScopeNames(names, andMore) || (i.categoryNone ?? '');
  }

  function renderAddRow(): string {
    const i = getDashI18n();
    return `<div class="flex items-center gap-[0.35rem] py-1">
      <input type="text" class="input category-picker__add-input max-w-[10rem] py-[0.3rem] px-2 text-[0.82rem]" placeholder="${esc(i.categoryNamePlaceholder ?? '')}" maxlength="40" />
      <button type="button" class="${BTN_CLASSES}" data-save-add>${esc(i.saveCategoryName ?? '')}</button>
      <button type="button" class="${BTN_CLASSES}" data-cancel-add>${esc(i.cancelCategoryEdit ?? '')}</button>
    </div>`;
  }

  /** Does any row in this sibling group get an arrow? The empty gutter beside a row exists ONLY
   *  to keep its label aligned with a sibling that has one — where no sibling does, it is 20px
   *  of nothing indenting a list for no reason, so the whole group loses it. In the add-enabled
   *  pickers every row can nest, so this is always true there and nothing moves. */
  function groupHasToggle(nodes: CategoryNode[], depth: number): boolean {
    return (canAdd && depth + 1 < MAX_CATEGORY_DEPTH) || nodes.some((n) => n.children.length > 0);
  }

  function renderRow(node: CategoryNode, depth: number, siblingHasToggle: boolean): string {
    const i = getDashI18n();
    const isExpanded = expanded.has(node.id);
    const canNest = canAdd && depth + 1 < MAX_CATEGORY_DEPTH;
    // Without the add row, a childless category has nothing to expand INTO — so it gets no
    // arrow either, and the menu stops promising a level that isn't there.
    const showToggle = node.children.length > 0 || canNest;

    const childrenHtml = isExpanded
      ? `<div class="flex flex-col ps-[1.1rem]">
          ${node.children.map((c) => renderRow(c, depth + 1, groupHasToggle(node.children, depth + 1))).join('')}
          ${canNest
            ? (addingUnderId === node.id ? renderAddRow() : `<button type="button" class="${ADD_CLASSES}" data-add-under="${esc(node.id)}">+ ${esc((i.addSubcategoryUnder ?? '{name}').replace('{name}', node.name))}</button>`)
            : ''}
        </div>`
      : '';

    return `<div class="flex flex-col">
      <div class="flex items-center gap-[0.15rem]" style="padding-inline-start:${depth * 0.9}rem">
        ${showToggle
          ? `<button type="button" class="${EXPAND_CLASSES}" data-expand="${esc(node.id)}" aria-label="${esc(i.toggleExpand ?? '')}"${isExpanded ? ' data-open' : ''}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>
            </button>`
          : siblingHasToggle ? `<span class="${EXPAND_SPACER_CLASSES}"></span>` : ''}
        <button type="button" class="${optionClasses(isSelected(node.id), false)}" data-select="${esc(node.id)}"${multi ? ` aria-pressed="${isSelected(node.id)}"` : ''}>${tickHtml(multi, isSelected(node.id))}${esc(node.name)}</button>
      </div>
      ${childrenHtml}
    </div>`;
  }

  function render(): void {
    const i = getDashI18n();
    const tree = getCategoryTree();
    menu!.innerHTML = `
      <button type="button" class="${optionClasses(isSelected(''), true)}" data-select="">${tickHtml(multi, isSelected(''))}${esc(i.categoryNone ?? '')}</button>
      ${tree.map((n) => renderRow(n, 0, groupHasToggle(tree, 0))).join('')}
      ${!canAdd ? '' : addingUnderId === null ? renderAddRow() : `<button type="button" class="${ADD_ROOT_CLASSES}" data-add-under="">+ ${esc(i.addRootCategory ?? '')}</button>`}
    `;
    menu!.querySelector<HTMLInputElement>('.category-picker__add-input')?.focus();
  }

  function close(): void {
    menu!.hidden = true;
    trigger!.setAttribute('aria-expanded', 'false');
    addingUnderId = undefined;
  }

  function open(): void {
    render();
    menu!.hidden = false;
    trigger!.setAttribute('aria-expanded', 'true');
  }

  trigger.addEventListener('click', () => { menu.hidden ? open() : close(); });

  // The consumer owns the hidden input too: the promotions tab empties it when the sale's scope
  // moves off categories, so that switching away and back doesn't quietly keep a narrow scope.
  // Without this the trigger kept advertising categories the form was no longer posting, and the
  // save then failed on "pick at least one" while the label showed a selection. A dedicated
  // event, not `input` — the picker dispatches `input` itself and would re-enter.
  const syncFromField = (): void => {
    const ids = hiddenInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    selectedIds.length = 0;
    selectedIds.push(...ids);
    updateLabel();
    if (!menu.hidden) render();
  };
  hiddenInput.addEventListener('picker:sync', syncFromField);
  // The FORM-wide version of the same statement: "discard changes" and a recovered draft both
  // replace this field from outside (unsaved-guard.ts owns the pair). Without it a restore put the
  // ids back while the trigger kept advertising the old ones — the identical mismatch `picker:sync`
  // exists for, arriving by a different door.
  hiddenInput.closest('form')?.addEventListener('dash:fieldsrewritten', syncFromField);

  // Not root.contains(e.target) — the in-menu click handler below can call render(), which
  // replaces menu.innerHTML (and so detaches the original e.target) before this bubbles up
  // here; a detached node reads as "not contained" by anything, which would misfire close()
  // on every single click inside the menu (expand arrows going nowhere, etc.). composedPath()
  // is captured at dispatch time, so it's immune to that.
  document.addEventListener('click', (e) => {
    if (!e.composedPath().includes(root)) close();
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !menu.hidden) { close(); trigger.focus(); }
  });

  /**
   * Enter in the new-category field adds the category. It used to SAVE THE WHOLE PRODUCT and
   * discard the half-typed category with it (reported 2026-08-03).
   *
   * This picker is rendered inside the product `<form>`, and a lone text input in a form makes
   * Enter an implicit submit — the browser does it, no handler is involved, which is why nothing
   * in this file looked wrong. The seller typed a name, pressed the key that means "confirm this",
   * and got a product saved with no category on it.
   *
   * Bound on the menu rather than the input because the add-row is re-rendered on every `render()`,
   * so a listener attached to the element itself would not survive its own creation.
   */
  menu.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const input = (e.target as HTMLElement).closest<HTMLInputElement>('.category-picker__add-input');
    if (!input) return;
    e.preventDefault();   // the implicit submit — this is the whole bug
    e.stopPropagation();
    void saveNewCategory();
  });

  menu.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;

    const expandBtn = target.closest<HTMLButtonElement>('[data-expand]');
    if (expandBtn) {
      const id = expandBtn.dataset.expand!;
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      render();
      return;
    }

    const selectBtn = target.closest<HTMLButtonElement>('[data-select]');
    if (selectBtn) {
      const id = selectBtn.dataset.select ?? '';
      if (!multi || !id) {
        // Single-pick, or the "no category" row in either mode — that row means "clear", so in
        // multi mode it empties the whole set rather than becoming a selectable member of it.
        selectedIds.length = 0;
        if (id) selectedIds.push(id);
      } else {
        const at = selectedIds.indexOf(id);
        if (at >= 0) selectedIds.splice(at, 1); else selectedIds.push(id);
      }
      hiddenInput!.value = selectedIds.join(',');
      // ORDER MATTERS: the trigger's label is repainted BEFORE the event fires. A listener may
      // read that label as its source of truth — the sale preview does, since the picker is the
      // only place the category NAMES are known — so notifying first left the banner rendering
      // the selection as it was one click ago, every click.
      updateLabel();
      // Let listeners (the tag-suggestion recompute, the sale preview) react to a category
      // change — a plain `.value =` assignment fires no event on its own.
      announceValueChange(hiddenInput!);
      // Multi-pick keeps the menu open: closing after every tick would make choosing four
      // categories four round trips through the trigger. Re-rendered in place so the ticks and
      // the trigger's label follow the click that caused them.
      if (multi && id) render(); else close();
      return;
    }

    const addBtn = target.closest<HTMLButtonElement>('[data-add-under]');
    if (addBtn) {
      addingUnderId = addBtn.dataset.addUnder || null;
      render();
      return;
    }

    if (target.closest('[data-cancel-add]')) {
      addingUnderId = undefined;
      render();
      return;
    }

    if (target.closest('[data-save-add]')) await saveNewCategory();
  });

  /**
   * Create the category the add-row names, then SELECT it and leave the menu open on it.
   *
   * **The previous behaviour was the opposite and it was deliberate**, on the reasoning that
   * creating a category and assigning this product to it are two different decisions — so the new
   * row was merely revealed and picking it was one more click. Overruled by the seller who uses it
   * (2026-08-03): in the add-product form nobody types a category name except to put the product
   * they are describing into it, and being handed a fresh category that the product is NOT in
   * reads as the save having failed.
   *
   * So it is selected — and the menu deliberately stays OPEN on it rather than closing the way a
   * plain pick does. That is what keeps the third requirement reachable: a tree is three levels
   * deep, and the moment after creating "ריהוט" is exactly when a seller wants "+ תת-קטגוריה תחת
   * ריהוט". Closing would make nesting a fresh category a matter of reopening the menu and hunting
   * for the row they just made. It is expanded for the same reason: its own add-row is on screen.
   *
   * Multi-pick APPENDS instead of replacing — there the field is a set (the sale scope), and
   * clearing the seller's other picks because they created a category would lose real work.
   */
  async function saveNewCategory(): Promise<void> {
    const input = menu!.querySelector<HTMLInputElement>('.category-picker__add-input');
    const name = input?.value.trim() ?? '';
    if (!name) return;
    const parentId = addingUnderId ?? null;

    const fd = new FormData();
    fd.set('_action', 'create-category');
    fd.set('storeId', storeId());
    fd.set('name', name);
    fd.set('parentId', parentId ?? '');

    const res = await fetch('/api/store-category', { method: 'POST', body: fd });
    const data = await res.json() as { ok: boolean; tree?: CategoryNode[]; error?: string };
    if (!data.ok || !data.tree) { showError(data.error ?? ''); return; }

    setCategoryTree(data.tree);
    const created = findCreated(data.tree, name, parentId);
    if (created) {
      if (multi) { if (!selectedIds.includes(created)) selectedIds.push(created); }
      else { selectedIds.length = 0; selectedIds.push(created); }
      hiddenInput!.value = selectedIds.join(',');
      // Same order as a normal pick: repaint the trigger's label BEFORE notifying, because a
      // listener may read that label as its source of truth.
      updateLabel();
      announceValueChange(hiddenInput!);
      expanded.add(created);
    }
    if (parentId) expanded.add(parentId);
    addingUnderId = undefined;
    render();
  }

  /** The row the server just made: matched under the parent it was created under, so a name that
   *  already exists elsewhere in the tree cannot be mistaken for it. */
  function findCreated(tree: CategoryNode[], name: string, parentId: string | null): string | undefined {
    const siblings = parentId ? findNode(tree, parentId)?.children ?? [] : tree;
    return siblings.find((n) => n.name === name)?.id;
  }

  function findNode(nodes: CategoryNode[], id: string): CategoryNode | undefined {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = findNode(n.children, id);
      if (hit) return hit;
    }
    return undefined;
  }

  updateLabel();
}
