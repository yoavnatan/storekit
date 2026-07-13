import type { CategoryNode } from '../../lib/store-categories.js';
import { getCategoryTree, setCategoryTree } from './category-tree-cache.js';

const MAX_CATEGORY_DEPTH = 3;

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
    return `<div class="category-picker__add-row">
      <input type="text" class="input category-picker__add-input" placeholder="${esc(i.categoryNamePlaceholder ?? '')}" maxlength="40" />
      <button type="button" class="category-picker__btn" data-save-add>${esc(i.saveCategoryName ?? '')}</button>
      <button type="button" class="category-picker__btn" data-cancel-add>${esc(i.cancelCategoryEdit ?? '')}</button>
    </div>`;
  }

  function renderRow(node: CategoryNode, depth: number): string {
    const i = getDashI18n();
    const isExpanded = expanded.has(node.id);
    const canNest = depth + 1 < MAX_CATEGORY_DEPTH;
    const showToggle = node.children.length > 0 || canNest;

    const childrenHtml = isExpanded
      ? `<div class="category-picker__group">
          ${node.children.map((c) => renderRow(c, depth + 1)).join('')}
          ${canNest
            ? (addingUnderId === node.id ? renderAddRow() : `<button type="button" class="category-picker__add" data-add-under="${esc(node.id)}">+ ${esc((i.addSubcategoryUnder ?? '{name}').replace('{name}', node.name))}</button>`)
            : ''}
        </div>`
      : '';

    return `<div class="category-picker__row-wrap">
      <div class="category-picker__row" style="padding-inline-start:${depth * 0.9}rem">
        ${showToggle
          ? `<button type="button" class="category-picker__expand${isExpanded ? ' is-open' : ''}" data-expand="${esc(node.id)}" aria-label="${esc(i.toggleExpand ?? '')}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>
            </button>`
          : `<span class="category-picker__expand-spacer"></span>`}
        <button type="button" class="category-picker__option${node.id === selectedId ? ' is-selected' : ''}" data-select="${esc(node.id)}">${esc(node.name)}</button>
      </div>
      ${childrenHtml}
    </div>`;
  }

  function render(): void {
    const i = getDashI18n();
    const tree = getCategoryTree();
    menu!.innerHTML = `
      <button type="button" class="category-picker__option category-picker__option--none${!selectedId ? ' is-selected' : ''}" data-select="">${esc(i.categoryNone ?? '')}</button>
      ${tree.map((n) => renderRow(n, 0)).join('')}
      ${addingUnderId === null ? renderAddRow() : `<button type="button" class="category-picker__add category-picker__add--root" data-add-under="">+ ${esc(i.addRootCategory ?? '')}</button>`}
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
