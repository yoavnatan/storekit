// Freezes a <table>'s column widths so filtering can't resize them.
//
// Why: a table-layout:auto table re-measures its columns against whatever
// rows are currently visible. Tick a value in a header filter dropdown and
// the rows change, so every column resizes and the header row slides
// sideways — while the dropdown itself (body-anchored, position:fixed,
// positioned once on open) correctly stays put. The result reads as the
// dropdown coming loose from its column, when what actually moved is the
// table underneath it.
//
// Taking the lock must be visually invisible, so it pins THREE things, in px
// measured off the live layout: the table's own width, then each column's.
// The table width matters because the auto and fixed algorithms disagree
// about it — an auto table is allowed to grow past its container to fit
// min-content, a fixed one is not, and that difference alone shifted the
// table by a couple of pixels the moment the lock was taken. A correction
// pass then folds any residual back in, since fixed layout redistributes a
// sum that doesn't add up to the table width.
//
// px, not %, for exactness — the cost is that a locked table can't reflow, so
// a viewport resize releases the lock and hands the columns back to the
// browser (the caller re-locks on its next filter change).

interface LockState { prevLayout: string; prevWidth: string; onResize: () => void }

const LOCKED = new WeakMap<HTMLTableElement, LockState>();

/** Pin the table's current geometry. No-op if already locked, if there's no
 *  header row, or if the header is collapsed (mobile card layout,
 *  `thead { display:none }`) — there are no real column widths to capture
 *  there, and the cells aren't laid out as a table anyway.
 *  Locking is idempotent, so the FIRST lock of a filtering session is the one
 *  that sets the proportions and every later call keeps them. */
export function lockTableColumns(table: HTMLTableElement | null): void {
  if (!table || LOCKED.has(table)) return;
  const headRow = table.tHead?.rows[0];
  if (!headRow) return;
  const cells = Array.from(headRow.cells);
  const targets = cells.map((c) => c.getBoundingClientRect().width);
  if (targets.reduce((a, b) => a + b, 0) < 1) return;
  const tableWidth = table.getBoundingClientRect().width;

  const state: LockState = {
    prevLayout: table.style.tableLayout,
    prevWidth: table.style.width,
    onResize: () => unlockTableColumns(table),
  };
  table.style.width = `${tableWidth.toFixed(3)}px`;
  cells.forEach((c, idx) => { c.style.width = `${(targets[idx] ?? 0).toFixed(3)}px`; });
  table.style.tableLayout = 'fixed';

  // Correction pass — see the header note. Anything still off by more than a
  // rounding error gets the delta added back to its specified width.
  cells.forEach((c, idx) => {
    const want = targets[idx] ?? 0;
    const actual = c.getBoundingClientRect().width;
    if (Math.abs(actual - want) > 0.05) c.style.width = `${Math.max(0, want + (want - actual)).toFixed(3)}px`;
  });

  window.addEventListener('resize', state.onResize);
  LOCKED.set(table, state);
}

/** Hand the table back to the browser's own content-based sizing. */
export function unlockTableColumns(table: HTMLTableElement | null): void {
  const state = table && LOCKED.get(table);
  if (!table || !state) return;
  const headRow = table.tHead?.rows[0];
  if (headRow) Array.from(headRow.cells).forEach((c) => { c.style.width = ''; });
  table.style.tableLayout = state.prevLayout;
  table.style.width = state.prevWidth;
  window.removeEventListener('resize', state.onResize);
  LOCKED.delete(table);
}
