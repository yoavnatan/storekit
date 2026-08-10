import type { CategoryNode } from '../../lib/store-categories.js';
import { escapeHtml as esc } from '../../lib/html-escape.js';

const MAX_CATEGORY_DEPTH = 3;

function getDashI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}')?.dashboard ?? {}; }
  catch { return {}; }
}

export function initCategoryTreeEditor(): void {
  const root = document.getElementById('category-tree-editor') as HTMLElement | null;
  const list = document.getElementById('category-tree-list') as HTMLElement | null;
  const addRootForm = document.getElementById('add-root-category-form') as HTMLFormElement | null;
  const addRootInput = document.getElementById('add-root-category-input') as HTMLInputElement | null;
  if (!root || !list) return;
  const storeId = root.dataset.storeId ?? '';

  let tree: CategoryNode[] = [];
  try { tree = JSON.parse(document.getElementById('category-tree-data')?.textContent ?? '[]') as CategoryNode[]; }
  catch { tree = []; }

  // Which node (if any) is mid-rename or has its "add subcategory" row open —
  // re-rendered into the tree HTML on every change rather than patched in
  // place, since the tree is small and this keeps the render logic in one spot.
  let renamingId: string | null = null;
  let addingUnderId: string | null = null;

  function renderNode(node: CategoryNode, depth: number, index: number, siblingCount: number): string {
    const i = getDashI18n();
    const canAddChild = depth + 1 < MAX_CATEGORY_DEPTH;
    const isRenaming = renamingId === node.id;
    const isAddingChild = addingUnderId === node.id;
    // Nothing to move into at either end of its own sibling list (CURRENT_TASK.md
    // — the arrow used to always render, even with nowhere left to go).
    const isFirst = index === 0;
    const isLast = index === siblingCount - 1;

    const rowHtml = isRenaming
      ? `<input type="text" class="input category-tree__rename-input max-w-[14rem] py-[.35rem] px-[.6rem]" value="${esc(node.name)}" maxlength="40" />
         <button type="button" class="category-tree__btn text-[.76rem] font-medium text-[color:var(--color-muted)] bg-transparent border border-[color:var(--color-border)] rounded-[var(--radius-sm)] py-1 px-2 cursor-pointer inline-flex items-center whitespace-nowrap transition-colors duration-[120ms] hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-text)] disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[color:var(--color-muted)]" data-action="save-rename">${esc(i.saveCategoryName ?? '')}</button>
         <button type="button" class="category-tree__btn text-[.76rem] font-medium text-[color:var(--color-muted)] bg-transparent border border-[color:var(--color-border)] rounded-[var(--radius-sm)] py-1 px-2 cursor-pointer inline-flex items-center whitespace-nowrap transition-colors duration-[120ms] hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-text)] disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[color:var(--color-muted)]" data-action="cancel-rename">${esc(i.cancelCategoryEdit ?? '')}</button>`
      : `<span class="text-[.9rem] font-semibold text-[color:var(--color-text)]">${esc(node.name)}</span>
         <div class="flex items-center gap-[.3rem] ms-auto flex-wrap">
           <button type="button" class="category-tree__btn text-[.76rem] font-medium text-[color:var(--color-muted)] bg-transparent border border-[color:var(--color-border)] rounded-[var(--radius-sm)] py-1 px-2 cursor-pointer inline-flex items-center whitespace-nowrap transition-colors duration-[120ms] hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-text)] disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[color:var(--color-muted)]" data-action="move-up" aria-label="${esc(i.categoryMoveUp ?? '')}"${isFirst ? ' disabled' : ''}>
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>
           </button>
           <button type="button" class="category-tree__btn text-[.76rem] font-medium text-[color:var(--color-muted)] bg-transparent border border-[color:var(--color-border)] rounded-[var(--radius-sm)] py-1 px-2 cursor-pointer inline-flex items-center whitespace-nowrap transition-colors duration-[120ms] hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-text)] disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[color:var(--color-muted)]" data-action="move-down" aria-label="${esc(i.categoryMoveDown ?? '')}"${isLast ? ' disabled' : ''}>
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
           </button>
           ${canAddChild ? `<button type="button" class="category-tree__btn text-[.76rem] font-medium text-[color:var(--color-muted)] bg-transparent border border-[color:var(--color-border)] rounded-[var(--radius-sm)] py-1 px-2 cursor-pointer inline-flex items-center whitespace-nowrap transition-colors duration-[120ms] hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-text)] disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[color:var(--color-muted)]" data-action="add-child">+ ${esc(i.addSubcategoryBtn ?? '')}</button>` : ''}
           <button type="button" class="category-tree__btn text-[.76rem] font-medium text-[color:var(--color-muted)] bg-transparent border border-[color:var(--color-border)] rounded-[var(--radius-sm)] py-1 px-2 cursor-pointer inline-flex items-center whitespace-nowrap transition-colors duration-[120ms] hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-text)] disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[color:var(--color-muted)]" data-action="rename">${esc(i.renameCategory ?? '')}</button>
           <button type="button" class="category-tree__btn text-[.76rem] font-medium text-[color:var(--color-muted)] bg-transparent border border-[color:var(--color-border)] rounded-[var(--radius-sm)] py-1 px-2 cursor-pointer inline-flex items-center whitespace-nowrap transition-colors duration-[120ms] hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-text)] disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[color:var(--color-muted)] hover:text-[color:var(--color-danger)] hover:border-[color:var(--color-danger)]" data-action="delete"${node.children.length ? ` disabled title="${esc(i.categoryHasChildrenTooltip ?? '')}"` : ''}>${esc(i.deleteCategory ?? '')}</button>
         </div>`;

    const addChildRowHtml = isAddingChild
      ? `<li class="category-tree__add-row flex items-center gap-2 py-[.3rem]" style="padding-inline-start:${(depth + 1) * 1.25}rem">
           <input type="text" class="input category-tree__add-input max-w-[14rem] py-[.35rem] px-[.6rem]" placeholder="${esc(i.categoryNamePlaceholder ?? '')}" maxlength="40" />
           <button type="button" class="category-tree__btn text-[.76rem] font-medium text-[color:var(--color-muted)] bg-transparent border border-[color:var(--color-border)] rounded-[var(--radius-sm)] py-1 px-2 cursor-pointer inline-flex items-center whitespace-nowrap transition-colors duration-[120ms] hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-text)] disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[color:var(--color-muted)]" data-action="save-child">${esc(i.saveCategoryName ?? '')}</button>
           <button type="button" class="category-tree__btn text-[.76rem] font-medium text-[color:var(--color-muted)] bg-transparent border border-[color:var(--color-border)] rounded-[var(--radius-sm)] py-1 px-2 cursor-pointer inline-flex items-center whitespace-nowrap transition-colors duration-[120ms] hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-text)] disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[color:var(--color-muted)]" data-action="cancel-add">${esc(i.cancelCategoryEdit ?? '')}</button>
         </li>`
      : '';

    const childrenHtml = node.children.map((c, idx) => renderNode(c, depth + 1, idx, node.children.length)).join('') + addChildRowHtml;

    return `<li class="category-tree__item" data-category-id="${esc(node.id)}">
        <div class="category-tree__row flex items-center flex-wrap gap-2 py-[.3rem]" style="padding-inline-start:${depth * 1.25}rem">${rowHtml}</div>
        ${childrenHtml ? `<ul class="category-tree__children list-none m-0 p-0 flex flex-col gap-[.35rem] mt-[.35rem]">${childrenHtml}</ul>` : ''}
      </li>`;
  }

  function render(): void {
    const i = getDashI18n();
    list!.innerHTML = tree.length
      ? `<ul class="category-tree__list list-none m-0 p-0 flex flex-col gap-[.35rem]">${tree.map((n, idx) => renderNode(n, 0, idx, tree.length)).join('')}</ul>`
      : `<p class="muted category-tree__empty text-[.85rem] m-0">${esc(i.noCategoriesYet ?? '')}</p>`;

    if (renamingId) {
      const input = list!.querySelector<HTMLInputElement>(`[data-category-id="${renamingId}"] > .category-tree__row .category-tree__rename-input`);
      input?.focus();
      input?.select();
    }
    if (addingUnderId) {
      const addInput = list!.querySelector<HTMLInputElement>(`[data-category-id="${addingUnderId}"] .category-tree__add-input`);
      addInput?.focus();
    }
  }

  async function callApi(action: string, fields: Record<string, string>): Promise<{ ok: boolean; tree?: CategoryNode[]; error?: string }> {
    const fd = new FormData();
    fd.set('_action', action);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    try {
      const res = await fetch('/api/store-category', { method: 'POST', body: fd });
      return await res.json() as { ok: boolean; tree?: CategoryNode[]; error?: string };
    } catch {
      // silent: the caller renders this `error` string in the tree panel.
    return { ok: false, error: 'שגיאת רשת.' };
    }
  }

  function showError(message: string): void {
    (window as unknown as { showToast?: (title: string, body: string) => void }).showToast?.(message, '');
  }

  render();

  addRootForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = addRootInput?.value.trim() ?? '';
    if (!name) return;
    const data = await callApi('create-category', { storeId, name, parentId: '' });
    if (data.ok && data.tree) {
      tree = data.tree;
      if (addRootInput) addRootInput.value = '';
      render();
    } else if (data.error) showError(data.error);
  });

  list.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    if (!btn || btn.disabled) return;
    const item = btn.closest<HTMLElement>('.category-tree__item');
    const categoryId = item?.dataset.categoryId ?? '';
    const action = btn.dataset.action;

    if (action === 'move-up' || action === 'move-down') {
      const data = await callApi('move-category', { categoryId, direction: action === 'move-up' ? 'up' : 'down' });
      if (data.ok && data.tree) { tree = data.tree; render(); }
      else if (data.error) showError(data.error);
      return;
    }

    if (action === 'rename') { renamingId = categoryId; render(); return; }
    if (action === 'cancel-rename') { renamingId = null; render(); return; }

    if (action === 'save-rename') {
      const input = item?.querySelector<HTMLInputElement>('.category-tree__rename-input');
      const name = input?.value.trim() ?? '';
      if (!name) return;
      const data = await callApi('rename-category', { categoryId, name });
      renamingId = null;
      if (data.ok && data.tree) tree = data.tree;
      else if (data.error) showError(data.error);
      render();
      return;
    }

    if (action === 'add-child') { addingUnderId = categoryId; render(); return; }
    if (action === 'cancel-add') { addingUnderId = null; render(); return; }

    if (action === 'save-child') {
      const input = item?.querySelector<HTMLInputElement>('.category-tree__add-input');
      const name = input?.value.trim() ?? '';
      if (!name) return;
      const data = await callApi('create-category', { storeId, name, parentId: categoryId });
      addingUnderId = null;
      if (data.ok && data.tree) tree = data.tree;
      else if (data.error) showError(data.error);
      render();
      return;
    }

    if (action === 'delete') {
      const i = getDashI18n();
      window.dispatchEvent(new CustomEvent('confirm:open', {
        detail: {
          title: i.deleteCategoryTitle ?? 'Delete category?',
          message: i.deleteCategoryMsg ?? '',
          okLabel: i.deleteCategory ?? 'Delete',
          onConfirm: async () => {
            const data = await callApi('delete-category', { categoryId });
            if (data.ok && data.tree) { tree = data.tree; render(); return; }
            // `else if (data.error)` was the whole failure handling, which left two shapes silent:
            // a refusal carrying no `error` field, and an `ok` response with no tree. In both the
            // category stayed exactly where it was and the seller was told nothing — after
            // confirming a delete, which reads as done.
            showError(data.error ?? (i.deleteCategoryFailed ?? ''));
          },
        },
      }));
    }
  });

  // Enter-to-submit inside the inline rename/add inputs, without a <form> wrapper per row.
  list.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (target.classList.contains('category-tree__rename-input')) {
      e.preventDefault();
      target.closest<HTMLElement>('.category-tree__row')?.querySelector<HTMLButtonElement>('[data-action="save-rename"]')?.click();
    } else if (target.classList.contains('category-tree__add-input')) {
      e.preventDefault();
      target.closest<HTMLElement>('.category-tree__add-row')?.querySelector<HTMLButtonElement>('[data-action="save-child"]')?.click();
    }
  });
}
