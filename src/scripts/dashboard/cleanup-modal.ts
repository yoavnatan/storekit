const modal          = document.getElementById('cleanup-modal') as HTMLDivElement | null;
const viewport       = document.getElementById('cleanup-viewport') as HTMLDivElement | null;
const canvas         = document.getElementById('cleanup-canvas') as HTMLCanvasElement | null;
const brushCursor    = document.getElementById('cleanup-brush-cursor') as HTMLDivElement | null;
const zoomInput      = document.getElementById('cleanup-zoom') as HTMLInputElement | null;
const sizeInput      = document.getElementById('cleanup-brush-size') as HTMLInputElement | null;
const modeEraseBtn   = document.getElementById('cleanup-mode-erase') as HTMLButtonElement | null;
const modeRestoreBtn = document.getElementById('cleanup-mode-restore') as HTMLButtonElement | null;
const modePanBtn     = document.getElementById('cleanup-mode-pan') as HTMLButtonElement | null;
const applyBtn       = document.getElementById('cleanup-apply') as HTMLButtonElement | null;
const resetBtn       = document.getElementById('cleanup-reset') as HTMLButtonElement | null;
const cancelBtn      = document.getElementById('cleanup-cancel') as HTMLButtonElement | null;

type Mode = 'erase' | 'restore' | 'pan';

const FIT_BOX = 280; // must match .cleanup-viewport's width/height in dashboard.css

let ctx: CanvasRenderingContext2D | null = null;
let originalCtx: CanvasRenderingContext2D | null = null;
let pristineProcessed: ImageData | null = null;
let mode: Mode = 'erase';
let drawing = false;
let panning = false;
let applyCallback: ((blob: Blob) => void) | null = null;
let baseFitScale = 1; // scale that fits the full image inside FIT_BOX at zoom=1
let zoom = 1;
let panX = 0, panY = 0;
let panStartX = 0, panStartY = 0, panStartOffsetX = 0, panStartOffsetY = 0;

// Fixed on-screen radius, independent of zoom — zooming in shrinks the *actual* area a stroke covers.
function brushRadiusScreen(): number {
  return (parseFloat(sizeInput?.value ?? '24')) / 2;
}

function setMode(next: Mode): void {
  mode = next;
  modeEraseBtn?.classList.toggle('cleanup-mode-btn--active', mode === 'erase');
  modeRestoreBtn?.classList.toggle('cleanup-mode-btn--active', mode === 'restore');
  modePanBtn?.classList.toggle('cleanup-mode-btn--active', mode === 'pan');
  canvas?.classList.toggle('cleanup-canvas--pan', mode === 'pan');
  brushCursor?.toggleAttribute('hidden', mode === 'pan');
}
// Panning only does something once zoomed past the fit-box — disable it otherwise.
function updatePanAvailability(): void {
  if (modePanBtn) modePanBtn.disabled = zoom <= 1;
  if (zoom <= 1 && mode === 'pan') setMode('erase');
}
function displayScale(): number { return baseFitScale * zoom || 1; } // zoom scales w/h together
function updateBrushCursorSize(): void {
  if (!brushCursor) return;
  const d = brushRadiusScreen() * 2;
  brushCursor.style.width = `${d}px`;
  brushCursor.style.height = `${d}px`;
}
// Clamps panX/panY then applies size+position — clamping first avoids a stale-pan flash.
function render(): void {
  if (!canvas) return;
  const dispW = canvas.width * displayScale();
  const dispH = canvas.height * displayScale();
  const halfW = Math.max(0, (dispW - FIT_BOX) / 2);
  const halfH = Math.max(0, (dispH - FIT_BOX) / 2);
  panX = Math.min(halfW, Math.max(-halfW, panX));
  panY = Math.min(halfH, Math.max(-halfH, panY));
  canvas.style.width = `${dispW}px`;
  canvas.style.height = `${dispH}px`;
  canvas.style.left = `${(FIT_BOX - dispW) / 2 + panX}px`;
  canvas.style.top = `${(FIT_BOX - dispH) / 2 + panY}px`;
}

export function openCleanupModal(originalBlob: Blob, processedBlob: Blob, onApply: (blob: Blob) => void): void {
  if (!modal || !canvas) return;
  applyCallback = onApply;
  setMode('erase');
  panX = 0; panY = 0;
  Promise.all([createImageBitmap(processedBlob), createImageBitmap(originalBlob)]).then(([procBmp, origBmp]) => {
    const w = procBmp.width, h = procBmp.height;
    canvas.width = w; canvas.height = h;
    ctx = canvas.getContext('2d');
    ctx!.clearRect(0, 0, w, h);
    ctx!.drawImage(procBmp, 0, 0, w, h);
    pristineProcessed = ctx!.getImageData(0, 0, w, h);
    const originalCanvas = document.createElement('canvas');
    originalCanvas.width = w; originalCanvas.height = h;
    originalCtx = originalCanvas.getContext('2d');
    originalCtx!.drawImage(origBmp, 0, 0, w, h);
    procBmp.close(); origBmp.close();
    baseFitScale = Math.min(FIT_BOX / w, FIT_BOX / h, 1);
    zoom = 1;
    if (zoomInput) zoomInput.value = '1';
    updatePanAvailability();
    render();
    updateBrushCursorSize();
    modal!.hidden = false;
  });
}

function closeCleanupModal(): void {
  if (!modal) return;
  modal.hidden = true;
  applyCallback = null;
  ctx = null; originalCtx = null; pristineProcessed = null;
}

function pointFromEvent(e: PointerEvent): { x: number; y: number } | null {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function paintAt(x: number, y: number): void {
  if (!ctx || !originalCtx || !canvas) return;
  const r = brushRadiusScreen() / displayScale(); // convert fixed screen radius to canvas-space
  const bx = Math.max(0, Math.floor(x - r));
  const by = Math.max(0, Math.floor(y - r));
  const bw = Math.min(canvas.width, Math.ceil(x + r)) - bx;
  const bh = Math.min(canvas.height, Math.ceil(y + r)) - by;
  if (bw <= 0 || bh <= 0) return;
  const target = ctx.getImageData(bx, by, bw, bh);
  const source = mode === 'restore' ? originalCtx.getImageData(bx, by, bw, bh) : null;
  const data = target.data;
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) {
      const dx = (bx + i) - x, dy = (by + j) - y;
      if (dx * dx + dy * dy > r * r) continue;
      const idx = (j * bw + i) * 4;
      if (mode === 'erase') {
        data[idx + 3] = 0;
      } else if (source) {
        data[idx] = source.data[idx];
        data[idx + 1] = source.data[idx + 1];
        data[idx + 2] = source.data[idx + 2];
        data[idx + 3] = source.data[idx + 3];
      }
    }
  }
  ctx.putImageData(target, bx, by);
}

export function initCleanupModal(): void {
  canvas?.addEventListener('pointerdown', (e) => {
    if (mode === 'pan') {
      panning = true;
      panStartX = e.clientX; panStartY = e.clientY;
      panStartOffsetX = panX; panStartOffsetY = panY;
      canvas?.classList.add('cleanup-canvas--panning');
      return;
    }
    drawing = true;
    const p = pointFromEvent(e);
    if (p) paintAt(p.x, p.y);
  });
  canvas?.addEventListener('pointermove', (e) => {
    if (panning) {
      panX = panStartOffsetX + (e.clientX - panStartX);
      panY = panStartOffsetY + (e.clientY - panStartY);
      render();
      return;
    }
    if (brushCursor && viewport) {
      const rect = viewport.getBoundingClientRect();
      brushCursor.style.left = `${e.clientX - rect.left}px`;
      brushCursor.style.top = `${e.clientY - rect.top}px`;
    }
    if (!drawing) return;
    const p = pointFromEvent(e);
    if (p) paintAt(p.x, p.y);
  });
  canvas?.addEventListener('pointerenter', () => { if (mode !== 'pan') brushCursor?.removeAttribute('hidden'); });
  canvas?.addEventListener('pointerleave', () => brushCursor?.setAttribute('hidden', ''));
  window.addEventListener('pointerup', () => {
    drawing = false; panning = false;
    canvas?.classList.remove('cleanup-canvas--panning');
  });
  sizeInput?.addEventListener('input', updateBrushCursorSize);
  zoomInput?.addEventListener('input', () => {
    zoom = parseFloat(zoomInput!.value);
    updatePanAvailability();
    render();
  });
  modeEraseBtn?.addEventListener('click', () => setMode('erase'));
  modeRestoreBtn?.addEventListener('click', () => setMode('restore'));
  modePanBtn?.addEventListener('click', () => setMode('pan'));
  resetBtn?.addEventListener('click', () => {
    if (ctx && pristineProcessed) ctx.putImageData(pristineProcessed, 0, 0);
  });
  applyBtn?.addEventListener('click', () => {
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (blob && applyCallback) applyCallback(blob);
      closeCleanupModal();
    }, 'image/png');
  });

  cancelBtn?.addEventListener('click', closeCleanupModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) closeCleanupModal(); });
}
