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
const shadowToggle   = document.getElementById('cleanup-shadow') as HTMLButtonElement | null;
const bgCustomInput  = document.getElementById('cleanup-bg-custom') as HTMLInputElement | null;
const swatchesEl     = document.getElementById('cleanup-swatches') as HTMLElement | null;
const customSwatchesEl = document.getElementById('cleanup-custom-swatches') as HTMLElement | null;

// Saved background colours are a per-STORE preference held on the server, so they follow the
// store even if the seller uploads from another device — not a per-browser localStorage list.
// The current store's palette is embedded on the page (#upload-config); adding one POSTs to the
// store API, which returns the authoritative list we then mirror.
const uploadConfig = document.getElementById('upload-config');
let customColors: string[] = readEmbeddedColors();

// The four fixed presets never need saving — only a genuinely new picked colour does.
const PRESET_BGS = new Set(['transparent', '#f1f2f4', '#f3ece1', '#1a1a1a']);
function isCustomBg(c: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(c) && !PRESET_BGS.has(c.toLowerCase());
}

function readEmbeddedColors(): string[] {
  try {
    const raw = JSON.parse(uploadConfig?.dataset.bgColors ?? '[]');
    return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [];
  } catch { return []; }
}

function renderCustomSwatches(): void {
  if (!customSwatchesEl) return;
  customSwatchesEl.textContent = '';
  for (const color of customColors) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cleanup-swatch';
    btn.dataset.bg = color;
    btn.style.background = color;
    btn.title = color;
    btn.setAttribute('aria-label', color);
    customSwatchesEl.appendChild(btn);
  }
}

// Persists a just-picked colour to the store. Optimistically shows it right away, then
// reconciles with the server's returned list (dedup/cap/ordering are decided server-side).
async function persistCustomColor(hex: string): Promise<void> {
  const storeId = uploadConfig?.dataset.storeId ?? '';
  if (!storeId) return;
  try {
    const body = new URLSearchParams({ _action: 'add-bg-color', storeId, color: hex });
    const resp = await fetch('/api/store', { method: 'POST', body });
    const data = await resp.json();
    if (data?.ok && Array.isArray(data.colors)) {
      customColors = data.colors.filter((c: unknown): c is string => typeof c === 'string');
      if (uploadConfig) uploadConfig.dataset.bgColors = JSON.stringify(customColors);
      renderCustomSwatches();
      syncFinishControls();
    }
  } catch { /* offline / failed — the optimistic swatch stays for this session */ }
}

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

// Output finishing options, baked into the saved cutout (not the editing surface).
let bgColor: 'transparent' | string = 'transparent';
let shadow = false;

// Mirrors the chosen background + shadow onto the live editing viewport so the seller sees
// the final look. The checkerboard (transparent) is the default CSS background, so an empty
// inline value falls back to it; a solid color overrides it.
function updateFinishPreview(): void {
  if (viewport) viewport.style.background = bgColor === 'transparent' ? '' : bgColor;
  if (canvas) canvas.style.filter = shadow ? 'drop-shadow(0 6px 10px rgba(0,0,0,0.28))' : '';
}

// Reflects the current bgColor/shadow state onto the swatch + toggle controls.
function syncFinishControls(): void {
  document.querySelectorAll<HTMLButtonElement>('.cleanup-swatch').forEach((sw) => {
    sw.classList.toggle('cleanup-swatch--active', (sw.dataset.bg ?? '') === bgColor);
  });
  shadowToggle?.setAttribute('aria-pressed', String(shadow));
}

// Bakes the chosen background fill + soft drop shadow into a copy of the edited cutout.
// Shadow blur/offset scale with image size so they read the same on a 300px or 3000px photo.
function buildOutputBlob(cb: (blob: Blob | null) => void): void {
  if (!canvas) { cb(null); return; }
  const w = canvas.width, h = canvas.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  if (!octx) { cb(null); return; }
  if (bgColor !== 'transparent') { octx.fillStyle = bgColor; octx.fillRect(0, 0, w, h); }
  if (shadow) {
    const s = Math.max(w, h);
    octx.save();
    octx.shadowColor = 'rgba(0,0,0,0.32)';
    octx.shadowBlur = s * 0.03;
    octx.shadowOffsetY = s * 0.02;
    octx.drawImage(canvas, 0, 0);
    octx.restore();
  } else {
    octx.drawImage(canvas, 0, 0);
  }
  out.toBlob(cb, 'image/png');
}

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
  bgColor = 'transparent'; shadow = false;
  renderCustomSwatches();
  syncFinishControls();
  updateFinishPreview();
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

// Swaps the Apply button into a busy dot-pulse (design rule: disable + dot-pulse, not a
// spinner) and locks the other actions so a slow PNG encode can't be interrupted mid-flight.
let applyBtnHtml = '';
function setApplyBusy(busy: boolean): void {
  if (!applyBtn) return;
  if (busy && !applyBtnHtml) applyBtnHtml = applyBtn.innerHTML;
  applyBtn.disabled = busy;
  if (resetBtn) resetBtn.disabled = busy;
  if (cancelBtn) cancelBtn.disabled = busy;
  applyBtn.innerHTML = busy
    ? '<span class="dot-pulse" role="status" aria-label="loading"><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span></span>'
    : applyBtnHtml;
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
  // Delegated so it also covers the dynamically-rendered saved-colour swatches. The rainbow
  // add-button is a <label> (no data-bg), so it's naturally skipped here.
  swatchesEl?.addEventListener('click', (e) => {
    const sw = (e.target as HTMLElement).closest<HTMLElement>('.cleanup-swatch[data-bg]');
    if (!sw || !swatchesEl.contains(sw)) return;
    bgColor = sw.dataset.bg ?? 'transparent';
    syncFinishControls();
    updateFinishPreview();
  });
  shadowToggle?.addEventListener('click', () => {
    shadow = !shadow;
    syncFinishControls();
    updateFinishPreview();
  });
  // `input` fires continuously while dragging in the picker — use it only for live preview,
  // never to save (that was adding a swatch on every drag tick). `change` fires once, when the
  // seller commits a colour (picker closed with a new value) — that's when we persist it.
  bgCustomInput?.addEventListener('input', () => {
    bgColor = bgCustomInput.value;
    updateFinishPreview();
  });
  bgCustomInput?.addEventListener('change', () => {
    bgColor = bgCustomInput.value.toLowerCase();
    // Show the swatch for reuse within this editing session only — NOT persisted to the store
    // yet. It's saved server-side only if the seller actually applies the edit (see applyBtn),
    // so abandoned colours never clutter the saved palette.
    if (!customColors.some((c) => c.toLowerCase() === bgColor)) {
      customColors = [bgColor, ...customColors];
      renderCustomSwatches();
    }
    syncFinishControls();
    updateFinishPreview();
  });
  resetBtn?.addEventListener('click', () => {
    if (ctx && pristineProcessed) ctx.putImageData(pristineProcessed, 0, 0);
  });
  applyBtn?.addEventListener('click', () => {
    if (!canvas || applyBtn.disabled) return;
    // PNG-encoding a full-resolution cutout (toBlob) can take a few seconds and briefly
    // hitches the main thread — without a visible busy state the modal just sat there
    // frozen. Disable the button + show the dot-pulse, then defer the encode one frame so
    // that busy state actually paints before the (blocking) encode starts.
    // The edit is being saved — now (and only now) persist a newly-picked background colour to
    // the store, so an abandoned pick never reaches the saved palette.
    if (isCustomBg(bgColor)) void persistCustomColor(bgColor);
    setApplyBusy(true);
    requestAnimationFrame(() => {
      buildOutputBlob((blob) => {
        if (blob && applyCallback) applyCallback(blob);
        setApplyBusy(false);
        closeCleanupModal();
      });
    });
  });

  cancelBtn?.addEventListener('click', closeCleanupModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) closeCleanupModal(); });
}
