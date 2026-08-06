---
name: project-dashboard-bulk
description: "Dashboard bulk actions architecture — bulk edit, bulk image upload, bulk delete, thumbnail skeleton"
metadata: 
  node_type: memory
  type: project
  originSessionId: 7f10944f-1247-4c85-b403-db95972cd4dc
---

Bulk actions bar appears when checkboxes are checked. Architecture:

**Select-all checkbox**: indeterminate when any items selected; `change` event reads `selected.size === 0` before loop; `hidden` while bulk edit mode is active.

**Bulk edit**: opens all selected products' inline edit rows in-place (NOT a separate panel). Toggle — if any open → close all; else open all. Button label changes "ערוך"/"סגור עריכה". Save button shows ✓ "נשמר" with spring animation, auto-closes edit row after 1500ms.

**Bulk image upload**: panel below bar lists each selected product with gallery widget. Auto-saves when user clicks gallery "סיים" (delegated click on `.gallery-done-btn`). No separate "שמור" button.

**Bulk delete**: uses existing ConfirmModal, then DELETE via `/api/product`.

**Thumbnail column**: split into its own `thumb-col` (NOT inside name cell). Structure: `<td class="thumb-col"><span class="thumb-wrap"><img class="product-thumb"></span></td>`. Shimmer via `::before` pseudo-element; `img.decode()` used after `load` event to ensure paint-readiness before adding `loaded` class (fixes `decoding="async"` gap).

**Cloudinary thumbnail transforms**: `thumbUrl(src, 84, 84)` adds `w_84,h_84,c_fill,f_auto,q_auto` to URL — server-side in `src/lib/cloudinary.ts`, client-side in `src/scripts/dashboard/cloudinary.ts`. Serves 84×84 for 2× DPR at 42px display.

**Why:** `decoding="async"` causes `load` to fire before image is painted → `img.decode()` waits for actual paint-readiness. The `@keyframes skeleton-shimmer` lives in `utils.css` only — dashboard.css removed its duplicate and uses `background-size: 400% 100%` to match.
