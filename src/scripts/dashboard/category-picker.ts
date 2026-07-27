import type { CategoryNode } from '../../lib/store-categories.js';
import { getCategoryTree, setCategoryTree } from './category-tree-cache.js';

const MAX_CATEGORY_DEPTH = 3;

const BTN_CLASSES = 'text-[0.76rem] font-medium text-[color:var(--color-muted)] bg-transparent border border-[color:var(--color-border)] rounded-[var(--radius-sm)] py-1 px-2 cursor-pointer whitespace-nowrap transition-colors duration-[120ms] hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-text)]';
const ADD_CLASSES = 'block w-full text-start py-[0.4rem] px-[0.6rem] mt-[0.15rem] rounded-[var(--radius-sm)] text-[0.8rem] font-semibold text-[color:var(--color-primary)] bg-transparent cursor-pointer transition-colors duration-100 hover:bg-[color:var(--color-bg)]';
const ADD_ROOT_CLASSES = 'block w-full text-start py-[0.4rem] px-[0.6rem] mt-[0.3rem] pt-2 rounded-[var(--radius-sm)] text-[0.8rem] font-semibold text-[color:var(--color-primary)] bg-transparent border-t border-[color:var(--color-border)] cursor-pointer transition-colors duration-100 hover:bg-[color:var(--color-bg)]';
const EXPAND_CLASSES = 'shrink-0 w-5 h-5 flex items-center justify-center text-[color:var(--color-muted)] rounded-[var(--radius-sm)] transition-[transform,background-color] duration-150 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:bg-[color:var(--color-bg)] data-[open]:rotate-90';
const EXPAND_SPACER_CLASSES = 'shrink-0 w-5 h-5';
const OPTION_BASE_CLASSES = 'flex-1 block text-start py-[0.4rem] px-[0.6rem] rounded-[var(--radius-sm)] text-[0.84rem] bg-transparent border-0 cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis transition-colors duration-100 hover:bg-[color:var(--color-bg)]';

function optionClasses(selected: boolean, isNone: boolean): string {
  if (selected) return `${OPTION_BASE_CLASSES} font-bold text-[color:var(--color-primary)]`;
  if (isNone) return `${OPTION_BASE_CLASSES} text-[color:var(--color-muted)]`;
  return `${OPTION_BASE_CLASSES} text-[color:var(--color-text)]`;
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getDashI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}')?.dashboard ?? {}; }
  catch { return {}; }
}

function pathLabel(id: string): string {
  function find(nodes: CategoryNode[], trail: string[]): string[] | null {
    for (const n of nodes) {
      if (n.id === id) return [...trail, n.name];
      const nested = find(n.children, [...trail, n.name]);
      if (nested) return nested;
    }
    return null;
  }
  return find(getCategoryTree(), [])?.join(' › ') ?? '';
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

  const hiddenInput = root.querySelector<HTMLInputElement>('input[name="categoryId"]');
  const trigger = root.querySelector<HTMLButtonElement>('.category-picker__trigger');
  const labelEl = root.querySelector<HTMLElement>('.category-picker__label');
  const menu = root.querySelector<HTMLElement>('.category-picker__menu');
  if (!hiddenInput || !trigger || !labelEl || !menu) return;

  let selectedId = hiddenInput.value;
  const expanded = new Set<string>();
  // undefined = no add-row open; null = adding a root category; string = adding under that parent id.
  let addingUnderId: string | null | undefined;

  function storeId(): string {
    return document.getElementById('category-tree-editor')?.getAttribute('data-store-id') ?? '';
  }

  function updateLabel(): void {
    const i = getDashI18n();
    labelEl!.textContent = selectedId ? (pathLabel(selectedId) || i.categoryNone || '') : (i.categoryNone ?? '');
  }

  function renderAddRow(): string {
    const i = getDashI18n();
    return `<div class="flex items-center gap-[0.35rem] py-1">
      <input type="text" class="input category-picker__add-input max-w-[10rem] py-[0.3rem] px-2 text-[0.82rem]" placeholder="${esc(i.categoryNamePlaceholder ?? '')}" maxlength="40" />
      <button type="button" class="${BTN_CLASSES}" data-save-add>${esc(i.saveCategoryName ?? '')}</button>
      <button type="button" class="${BTN_CLASSES}" data-cancel-add>${esc(i.cancelCategoryEdit ?? '')}</button>
    </div>`;
  }

  function renderRow(node: CategoryNode, depth: number): string {
    const i = getDashI18n();
    const isExpanded = expanded.has(node.id);
    const canNest = depth + 1 < MAX_CATEGORY_DEPTH;
    const showToggle = node.children.length > 0 || canNest;

    const childrenHtml = isExpanded
      ? `<div class="flex flex-col ps-[1.1rem]">
          ${node.children.map((c) => renderRow(c, depth + 1)).join('')}
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
          : `<span class="${EXPAND_SPACER_CLASSES}"></span>`}
        <button type="button" class="${optionClasses(node.id === selectedId, false)}" data-select="${esc(node.id)}">${esc(node.name)}</button>
      </div>
      ${childrenHtml}
    </div>`;
  }

  function render(): void {
    const i = getDashI18n();
    const tree = getCategoryTree();
    menu!.innerHTML = `
      <button type="button" class="${optionClasses(!selectedId, true)}" data-select="">${esc(i.categoryNone ?? '')}</button>
      ${tree.map((n) => renderRow(n, 0)).join('')}
      ${addingUnderId === null ? renderAddRow() : `<button type="button" class="${ADD_ROOT_CLASSES}" data-add-under="">+ ${esc(i.addRootCategory ?? '')}</button>`}
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
      selectedId = selectBtn.dataset.select ?? '';
      hiddenInput!.value = selectedId;
      // Let listeners (e.g. the tag-suggestion recompute) react to a category
      // change — a plain `.value =` assignment fires no event on its own.
      hiddenInput!.dispatchEvent(new Event('input', { bubbles: true }));
      updateLabel();
      close();
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

    if (target.closest('[data-save-add]')) {
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

      // Deliberately doesn't select the new category or close the menu — creating a
      // category and assigning *this* product to it are two different decisions; the
      // seller might just be building out the tree. It's revealed (parent expanded)
      // so picking it is one more click away, not auto-applied.
      setCategoryTree(data.tree);
      if (parentId) expanded.add(parentId);
      addingUnderId = undefined;
      render();
    }
  });

  updateLabel();
}
