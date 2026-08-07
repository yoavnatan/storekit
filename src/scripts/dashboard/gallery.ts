import { galleryWidgetHtml } from '../../lib/gallery-widget.js';
import { removeBackgroundInWorker, cancelBgWorker, warmBgWorker } from './bg-worker.js';
import { cloudinaryUpload } from './cloudinary.js';
import { openCropModal } from './crop-modal.js';
import { openCleanupModal } from './cleanup-modal.js';
import { announceValueChange } from './unsaved-guard.js';
import { outboundFetch } from '../../lib/outbound-fetch.js';
import { initImageSkeletons } from '../../lib/img-skeleton.js';

/**
 * How long a re-fetch of a stored image may take before it counts as a failure.
 *
 * All three fetches below are GETs to Cloudinary for a photo the seller uploaded earlier, and each
 * runs behind a loading state. A bare `fetch` had no way to end: the CDN accepting the connection
 * and then not answering left the panel stuck on "Loading image…" with no error and no way out but
 * a reload, which a seller cannot tell apart from "it is still working". Thirty seconds because
 * these download full-resolution ORIGINALS — long enough never to abort a slow phone, short enough
 * to be a failure a person recognises. Every catch here already restores the panel, so a deadline
 * turns a hang into the failure the code was always written for.
 */
const IMAGE_FETCH_TIMEOUT_MS = 30_000;

export { galleryWidgetHtml };

export interface WidgetState {
  original?: Blob; processed?: Blob; useProcessed: boolean; processing: boolean;
  pristineOriginal?: Blob;  // untouched upload, kept so a crop of the original can be undone
  pristineProcessed?: Blob; // bg-removed/cleaned cutout before any crop was applied to it
  croppedOriginal: boolean;  // true once a crop has been applied to `original`
  croppedProcessed: boolean; // true once a crop has been applied to `processed`
  /** This slot's saved URL (or '' if it was empty) at the moment the widget was rendered —
   *  the target Cancel reverts to, discarding anything picked/edited in this session. */
  initialUrl: string;
}
const wState = new WeakMap<Element, WidgetState>();

export function initGalleryWidget(gallery: Element): void {
  if ((gallery as HTMLElement).dataset.galleryInit) return;
  (gallery as HTMLElement).dataset.galleryInit = '1';

  // The saved photos this widget rendered (gallery-widget.ts marks a filled slot `data-skeleton`)
  // — a shimmer while they arrive from Cloudinary, which is what an opened edit row waits on.
  // Only the SSR ones: every later `src` this file sets is a local blob or a URL already fetched
  // once, so the module would find the image complete and skip it anyway.
  initImageSkeletons('.gallery-slot__filled', gallery);

  const panel          = gallery.querySelector<HTMLElement>('.gallery-panel');
  const panelImg       = gallery.querySelector<HTMLImageElement>('.gallery-panel__img');
  const loadingOverlay = gallery.querySelector<HTMLElement>('.img-loading-overlay');
  const removeBgBtn    = gallery.querySelector<HTMLButtonElement>('.gallery-remove-bg-btn');
  const restoreBgBtn   = gallery.querySelector<HTMLButtonElement>('.gallery-restore-bg-btn');
  const keepBgBtn      = gallery.querySelector<HTMLButtonElement>('.gallery-keep-bg-btn');
  const cleanupBtn     = gallery.querySelector<HTMLButtonElement>('.gallery-cleanup-btn');
  const cropBtn        = gallery.querySelector<HTMLButtonElement>('.gallery-crop-btn');
  const undoCropBtn    = gallery.querySelector<HTMLButtonElement>('.gallery-undo-crop-btn');
  const changeBtn      = gallery.querySelector<HTMLButtonElement>('.gallery-change-btn');
  const cancelBtn      = gallery.querySelector<HTMLButtonElement>('.gallery-cancel-btn');
  const doneBtn        = gallery.querySelector<HTMLButtonElement>('.gallery-done-btn');
  const sharedFileInput = gallery.querySelector<HTMLInputElement>('.gallery-shared-file-input');
  const batchBar       = gallery.querySelector<HTMLElement>('.gallery-batch');
  const batchStartBtn  = gallery.querySelector<HTMLButtonElement>('.gallery-batch-start');
  const batchRunBtn    = gallery.querySelector<HTMLButtonElement>('.gallery-batch-run');
  const batchRunLabel  = gallery.querySelector<HTMLElement>('.gallery-batch-run__label');
  const batchCancelBtn = gallery.querySelector<HTMLButtonElement>('.gallery-batch-cancel');
  const batchBaseLabel = batchRunLabel?.textContent ?? 'Remove background';
  const form           = gallery.closest<HTMLFormElement>('form');
  const submitBtn      = form?.querySelector<HTMLButtonElement>('[type="submit"]');

  let activeSlot: Element | null = null;
  let pendingPickSlot: Element | null = null;
  let selecting = false;      // batch-selection mode active
  let batchRunning = false;   // a batch bg-removal pass is in flight
  const batchSelected = new Set<Element>();

  function getState(): WidgetState | null {
    return activeSlot ? (wState.get(activeSlot) ?? null) : null;
  }

  function getGalleryI18n(): Record<string, string> {
    try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').gallery ?? {}; } catch { return {}; }
  }

  function getRemovingBgMsg() {
    return getGalleryI18n().removingBg ?? 'Removing background…';
  }

  function setLoading(active: boolean, msg = getRemovingBgMsg()) {
    const st = getState();
    if (st) st.processing = active;
    if (loadingOverlay) loadingOverlay.hidden = !active;
    const span = loadingOverlay?.querySelector('span');
    if (span) span.textContent = msg;
    if (submitBtn) submitBtn.disabled = active;
  }

  function updatePanelButtons() {
    const st = getState();
    if (!st) return;
    const hasProcessed = !!st.processed;
    const showingProcessed = hasProcessed && st.useProcessed;
    const isProcessing = st.processing;
    // Kept visible (disabled) while processing so its label can carry the live percentage,
    // rather than vanishing behind the overlay.
    removeBgBtn?.toggleAttribute('hidden', hasProcessed);
    if (removeBgBtn) removeBgBtn.disabled = isProcessing;
    restoreBgBtn?.toggleAttribute('hidden', !hasProcessed || showingProcessed || isProcessing);
    keepBgBtn?.toggleAttribute('hidden', !showingProcessed && !isProcessing);
    cleanupBtn?.toggleAttribute('hidden', !showingProcessed || isProcessing);
    const isCropped = showingProcessed ? st.croppedProcessed : st.croppedOriginal;
    undoCropBtn?.toggleAttribute('hidden', !isCropped || isProcessing);
    if (cropBtn)   cropBtn.disabled   = isProcessing;
    if (changeBtn) changeBtn.disabled = isProcessing;
  }

  function setSlotThumbnail(slot: Element, src: string) {
    const slotImg = slot.querySelector<HTMLImageElement>('.gallery-slot__img');
    const empty   = slot.querySelector<HTMLElement>('.gallery-slot__empty');
    const filled  = slot.querySelector<HTMLElement>('.gallery-slot__filled');
    if (slotImg) slotImg.src = src;
    empty?.setAttribute('hidden', '');
    filled?.removeAttribute('hidden');
  }

  function clearSlot(slot: Element) {
    const st = wState.get(slot);
    if (st) {
      st.original = undefined; st.processed = undefined; st.useProcessed = false;
      st.pristineOriginal = undefined; st.pristineProcessed = undefined;
      st.croppedOriginal = false; st.croppedProcessed = false;
    }
    batchSelected.delete(slot); markSelected(slot, false);
    const slotImg   = slot.querySelector<HTMLImageElement>('.gallery-slot__img');
    const empty     = slot.querySelector<HTMLElement>('.gallery-slot__empty');
    const filled    = slot.querySelector<HTMLElement>('.gallery-slot__filled');
    const urlInput  = slot.querySelector<HTMLInputElement>('.gallery-slot__url');
    if (slotImg) slotImg.src = '';
    empty?.removeAttribute('hidden');
    filled?.setAttribute('hidden', '');
    if (urlInput) { urlInput.value = ''; announceValueChange(urlInput); }
    updateBatchAvailability();
  }

  // Discards whatever was picked/cropped/bg-removed for this ONE slot in this editing session,
  // restoring it to exactly what it was when the widget was first rendered (a saved url, or
  // empty) — so a bulk-panel "Done" click right after can't accidentally save it.
  function revertSlot(slot: Element) {
    const st = wState.get(slot);
    const initialUrl = st?.initialUrl ?? '';
    if (st) {
      st.original = undefined; st.processed = undefined; st.useProcessed = false;
      st.pristineOriginal = undefined; st.pristineProcessed = undefined;
      st.croppedOriginal = false; st.croppedProcessed = false;
    }
    const slotImg   = slot.querySelector<HTMLImageElement>('.gallery-slot__img');
    const empty     = slot.querySelector<HTMLElement>('.gallery-slot__empty');
    const filled    = slot.querySelector<HTMLElement>('.gallery-slot__filled');
    const urlInput  = slot.querySelector<HTMLInputElement>('.gallery-slot__url');
    batchSelected.delete(slot); markSelected(slot, false);
    if (urlInput) { urlInput.value = initialUrl; announceValueChange(urlInput); }
    if (slotImg) slotImg.src = initialUrl;
    empty?.toggleAttribute('hidden', !!initialUrl);
    filled?.toggleAttribute('hidden', !initialUrl);
    updateBatchAvailability();
  }

  function activateSlot(slot: Element) {
    // Opening an image to edit is a strong signal a bg-removal is coming — start the model
    // download now so the (large, one-time) fetch is done or underway before the click.
    warmBgWorker();
    activeSlot = slot;
    gallery.querySelectorAll<Element>('.gallery-slot').forEach(s => s.classList.remove('gallery-slot--active'));
    slot.classList.add('gallery-slot--active');
    const st = wState.get(slot);
    if (!st) return;
    const blob = st.useProcessed && st.processed ? st.processed : st.original;
    if (blob) {
      if (panelImg) panelImg.src = URL.createObjectURL(blob);
    } else {
      const urlInput = slot.querySelector<HTMLInputElement>('.gallery-slot__url');
      if (panelImg && urlInput?.value) panelImg.src = urlInput.value;
    }
    panel?.removeAttribute('hidden');
    updatePanelButtons();
  }

  function closePanel() {
    activeSlot = null;
    gallery.querySelectorAll<Element>('.gallery-slot').forEach(s => s.classList.remove('gallery-slot--active'));
    panel?.setAttribute('hidden', '');
    if (panelImg) panelImg.src = '';
  }

  const allSlots = Array.from(gallery.querySelectorAll<Element>('.gallery-slot'));

  function isSlotEmpty(slot: Element): boolean {
    return !slot.querySelector<HTMLElement>('.gallery-slot__empty')?.hasAttribute('hidden');
  }

  function filledSlots(): Element[] {
    return allSlots.filter((s) => !isSlotEmpty(s));
  }

  function setSlotLoading(slot: Element, active: boolean) {
    slot.querySelector<HTMLElement>('.gallery-slot__loading')?.toggleAttribute('hidden', !active);
  }

  // The batch bar only makes sense with two or more images to choose between — hide it
  // otherwise (a single image is faster to cut out via its own panel button).
  function updateBatchAvailability() {
    if (!batchBar || selecting) return;
    batchBar.hidden = filledSlots().length < 2;
  }

  function updateBatchRunLabel() {
    if (batchRunLabel) batchRunLabel.textContent = `${batchBaseLabel} (${batchSelected.size})`;
    if (batchRunBtn) batchRunBtn.disabled = batchSelected.size === 0 || batchRunning;
  }

  function markSelected(slot: Element, on: boolean) {
    slot.classList.toggle('gallery-slot--batch-selected', on);
    slot.querySelector<HTMLElement>('.gallery-slot__check')?.toggleAttribute('hidden', !on);
  }

  function toggleBatchSelect(slot: Element) {
    if (batchSelected.has(slot)) batchSelected.delete(slot);
    else batchSelected.add(slot);
    markSelected(slot, batchSelected.has(slot));
    updateBatchRunLabel();
  }

  // Enter selection: every filled photo starts selected (the common case is "cut them all
  // out"), and the seller taps to exclude any that should keep their background.
  function enterSelecting() {
    if (activeSlot) closePanel();
    selecting = true;
    gallery.classList.add('gallery--selecting');
    batchSelected.clear();
    filledSlots().forEach((s) => { batchSelected.add(s); markSelected(s, true); });
    batchStartBtn?.setAttribute('hidden', '');
    batchRunBtn?.removeAttribute('hidden');
    batchCancelBtn?.removeAttribute('hidden');
    updateBatchRunLabel();
  }

  function exitSelecting() {
    selecting = false;
    gallery.classList.remove('gallery--selecting');
    allSlots.forEach((s) => markSelected(s, false));
    batchSelected.clear();
    if (batchRunLabel) batchRunLabel.textContent = batchBaseLabel;
    batchStartBtn?.removeAttribute('hidden');
    batchRunBtn?.setAttribute('hidden', '');
    batchCancelBtn?.setAttribute('hidden', '');
    updateBatchAvailability();
  }

  // Loads a slot's source blob — either the in-session upload/edit, or (for an already-saved
  // product image) fetched back from its stored URL, same as the single "remove background".
  async function ensureOriginalBlob(slot: Element): Promise<Blob | null> {
    const st = wState.get(slot);
    if (!st) return null;
    if (st.original) return st.original;
    const url = slot.querySelector<HTMLInputElement>('.gallery-slot__url')?.value;
    if (!url) return null;
    try {
      const resp = await outboundFetch(url, { timeoutMs: IMAGE_FETCH_TIMEOUT_MS });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      st.original = blob; st.pristineOriginal = blob;
      return blob;
    } catch { return null; }
  }

  // Processes the selected slots one at a time — the segmentation model is CPU-bound, so a
  // sequential queue is no slower than firing them in parallel and won't blow up memory. The
  // run-button doubles as the progress readout (n/total); a failed image is skipped, not fatal.
  async function runBatch() {
    if (batchRunning || batchSelected.size === 0) return;
    const slots = filledSlots().filter((s) => batchSelected.has(s)); // keep visual order
    batchRunning = true;
    if (batchCancelBtn) batchCancelBtn.disabled = true;
    if (batchRunBtn) batchRunBtn.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (batchRunLabel) batchRunLabel.textContent = `${batchBaseLabel} (${i + 1}/${slots.length})`;
      setSlotLoading(slot, true);
      try {
        const original = await ensureOriginalBlob(slot);
        if (original) {
          const processed = await removeBackgroundInWorker(original, (p) => {
            if (batchRunLabel) batchRunLabel.textContent = `${batchBaseLabel} (${i + 1}/${slots.length} · ${Math.round(p * 100)}%)`;
          });
          const st = wState.get(slot)!;
          st.processed = processed; st.pristineProcessed = processed; st.useProcessed = true; st.croppedProcessed = false;
          setSlotThumbnail(slot, URL.createObjectURL(processed));
        }
      } catch { /* skip a failed image, keep going */ }
      finally { setSlotLoading(slot, false); }
    }
    batchRunning = false;
    if (batchCancelBtn) batchCancelBtn.disabled = false;
    if (submitBtn) submitBtn.disabled = false;
    exitSelecting();
  }

  function assignFileToSlot(slot: Element, file: File) {
    const st = wState.get(slot);
    if (!st) return;
    st.original = file; st.pristineOriginal = file;
    st.processed = undefined; st.pristineProcessed = undefined; st.useProcessed = false;
    st.croppedOriginal = false; st.croppedProcessed = false;
    setSlotThumbnail(slot, URL.createObjectURL(file));
  }

  // A slot's own file picker/drop always fills that slot first (replacing whatever it held,
  // same as before); a multi-file pick/drop (multiple photos chosen at once, or several dragged
  // together) spills any extra images forward into the next still-empty slots in order — so
  // picking 5 photos in one native picker action (common on mobile) fills the whole gallery in
  // one go instead of needing 5 separate taps.
  function handleFiles(files: FileList | File[], startSlot: Element) {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    const startIdx = allSlots.indexOf(startSlot);
    const targets = [startSlot, ...allSlots.slice(startIdx + 1).filter(isSlotEmpty)];
    imageFiles.slice(0, targets.length).forEach((file, i) => assignFileToSlot(targets[i]!, file));
    updateBatchAvailability();
    activateSlot(startSlot);
  }

  // One shared, off-screen (not just visually-hidden) file input per widget drives every
  // slot's click-to-choose — see the comment in gallery-widget.ts for why: a real OS drag-drop
  // was double-processing files when each slot nested its own input, because the browser's
  // native "drop a file onto a file input" default action could land on it independently of our
  // own drop handler, no matter how we tried to suppress it. With no input anywhere near a drop
  // zone's hit-testable area, that's structurally impossible now.
  sharedFileInput?.addEventListener('change', () => {
    if (pendingPickSlot && sharedFileInput.files?.length) handleFiles(sharedFileInput.files, pendingPickSlot);
    sharedFileInput.value = '';
    pendingPickSlot = null;
  });

  allSlots.forEach((slot) => {
    const emptyBtn  = slot.querySelector<HTMLButtonElement>('.gallery-slot__empty');
    const editBtn   = slot.querySelector<HTMLButtonElement>('.gallery-slot__action--edit');
    const removeBtn = slot.querySelector<HTMLButtonElement>('.gallery-slot__action--remove');
    const initialUrl = slot.querySelector<HTMLInputElement>('.gallery-slot__url')?.value ?? '';
    const st: WidgetState = { useProcessed: false, processing: false, croppedOriginal: false, croppedProcessed: false, initialUrl };
    wState.set(slot, st);

    emptyBtn?.addEventListener('click', () => { pendingPickSlot = slot; sharedFileInput?.click(); });
    editBtn?.addEventListener('click', (e) => { e.stopPropagation(); activateSlot(slot); });
    removeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const gi = getGalleryI18n();
      window.dispatchEvent(new CustomEvent('confirm:open', {
        detail: {
          title: gi.removeImageTitle ?? 'Remove image?',
          message: gi.removeImageMsg ?? 'This image will be removed from the product.',
          okLabel: gi.removeImageBtn ?? 'Remove',
          onConfirm: () => { clearSlot(slot); if (activeSlot === slot) closePanel(); },
        },
      }));
    });

    // Drag-and-drop straight onto the slot frame, in addition to the click-to-choose button —
    // dragenter/dragover must both preventDefault or the browser refuses the drop entirely.
    slot.addEventListener('dragenter', (e) => { e.preventDefault(); slot.classList.add('gallery-slot--dragover'); });
    slot.addEventListener('dragover', (e) => { e.preventDefault(); });
    slot.addEventListener('dragleave', (e) => {
      if (!slot.contains((e as DragEvent).relatedTarget as Node | null)) slot.classList.remove('gallery-slot--dragover');
    });
    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      slot.classList.remove('gallery-slot--dragover');
      const files = (e as DragEvent).dataTransfer?.files;
      if (files?.length) handleFiles(files, slot);
    });

    // In batch-selection mode a tap toggles the photo in/out of the set — captured before
    // the edit/remove overlay buttons so it wins over their own handlers.
    slot.addEventListener('click', (e) => {
      if (!selecting || batchRunning || isSlotEmpty(slot)) return;
      e.preventDefault(); e.stopPropagation();
      toggleBatchSelect(slot);
    }, true);
  });

  batchStartBtn?.addEventListener('click', enterSelecting);
  batchCancelBtn?.addEventListener('click', () => { if (!batchRunning) exitSelecting(); });
  batchRunBtn?.addEventListener('click', runBatch);
  updateBatchAvailability();

  removeBgBtn?.addEventListener('click', async () => {
    if (!activeSlot) return;
    const st = wState.get(activeSlot)!;
    if (!st.original) {
      const urlInput = activeSlot.querySelector<HTMLInputElement>('.gallery-slot__url');
      const url = urlInput?.value;
      if (!url) return;
      setLoading(true);
      try {
        const resp = await outboundFetch(url, { timeoutMs: IMAGE_FETCH_TIMEOUT_MS });
        if (!resp.ok) throw new Error('fetch failed');
        st.original = await resp.blob();
        st.pristineOriginal = st.original;
      } catch { setLoading(false); updatePanelButtons(); return; }
    }
    setLoading(true);
    updatePanelButtons();
    const baseMsg = getRemovingBgMsg().replace(/[.…]+$/, '');
    const removeBgLabel = removeBgBtn?.querySelector<HTMLElement>('.gallery-remove-bg-btn__label');
    const removeBgBaseText = removeBgLabel?.textContent ?? '';
    try {
      const processed = await removeBackgroundInWorker(st.original!, (p) => {
        // Live percentage on the button itself — a bar that sweeps twice (first-run fetch,
        // then the removal) still beats a blind wait with no sense of progress.
        if (removeBgLabel) removeBgLabel.textContent = `${baseMsg} ${Math.round(p * 100)}%`;
      });
      st.processed = processed; st.pristineProcessed = processed; st.useProcessed = true; st.croppedProcessed = false;
      if (panelImg) panelImg.src = URL.createObjectURL(processed);
      if (activeSlot) setSlotThumbnail(activeSlot, URL.createObjectURL(processed));
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') return;
    } finally {
      if (removeBgLabel) removeBgLabel.textContent = removeBgBaseText;
      setLoading(false); updatePanelButtons();
    }
  });

  keepBgBtn?.addEventListener('click', () => {
    if (!activeSlot) return;
    const st = wState.get(activeSlot)!;
    if (st.processing) cancelBgWorker();
    if (!st.original) return;
    st.useProcessed = false;
    if (panelImg) panelImg.src = URL.createObjectURL(st.original);
    setSlotThumbnail(activeSlot, URL.createObjectURL(st.original));
    setLoading(false); updatePanelButtons();
  });

  restoreBgBtn?.addEventListener('click', () => {
    if (!activeSlot) return;
    const st = wState.get(activeSlot)!;
    if (!st.processed) return;
    st.useProcessed = true;
    if (panelImg) panelImg.src = URL.createObjectURL(st.processed);
    setSlotThumbnail(activeSlot, URL.createObjectURL(st.processed));
    updatePanelButtons();
  });

  cleanupBtn?.addEventListener('click', () => {
    if (!activeSlot) return;
    const st = wState.get(activeSlot)!;
    if (!st.original || !st.processed) return;
    const slotRef = activeSlot;
    openCleanupModal(st.original, st.processed, (cleanedBlob) => {
      const st2 = wState.get(slotRef)!;
      st2.processed = cleanedBlob; st2.pristineProcessed = cleanedBlob; st2.useProcessed = true; st2.croppedProcessed = false;
      if (panelImg) panelImg.src = URL.createObjectURL(cleanedBlob);
      setSlotThumbnail(slotRef, URL.createObjectURL(cleanedBlob));
      if (slotRef === activeSlot) updatePanelButtons();
    });
  });

  undoCropBtn?.addEventListener('click', () => {
    if (!activeSlot) return;
    const st = wState.get(activeSlot)!;
    const showingProcessed = !!(st.processed && st.useProcessed);
    if (showingProcessed) {
      if (!st.pristineProcessed) return;
      st.processed = st.pristineProcessed;
      st.croppedProcessed = false;
      if (panelImg) panelImg.src = URL.createObjectURL(st.processed);
      setSlotThumbnail(activeSlot, URL.createObjectURL(st.processed));
    } else {
      if (!st.pristineOriginal) return;
      st.original = st.pristineOriginal;
      st.processed = undefined; st.pristineProcessed = undefined;
      st.useProcessed = false; st.croppedOriginal = false; st.croppedProcessed = false;
      if (panelImg) panelImg.src = URL.createObjectURL(st.original);
      setSlotThumbnail(activeSlot, URL.createObjectURL(st.original));
    }
    updatePanelButtons();
  });

  cropBtn?.addEventListener('click', async () => {
    if (!activeSlot) return;
    const st = wState.get(activeSlot)!;
    let blob = st.useProcessed && st.processed ? st.processed : st.original;
    if (!blob) {
      const urlInput = activeSlot.querySelector<HTMLInputElement>('.gallery-slot__url');
      const url = urlInput?.value;
      if (!url) return;
      // Fetching the existing image before opening the crop tool — NOT removing bg.
      // setLoading defaults its label to the bg-removal message, so pass the right one.
      setLoading(true, getGalleryI18n().loadingImage ?? 'Loading image…');
      try {
        const resp = await outboundFetch(url, { timeoutMs: IMAGE_FETCH_TIMEOUT_MS });
        if (!resp.ok) throw new Error('fetch failed');
        st.original = await resp.blob();
        st.pristineOriginal = st.original;
        blob = st.original;
      } catch { setLoading(false); return; }
      setLoading(false);
    }
    const isProcessed = !!(st.useProcessed && st.processed);
    const slotRef = activeSlot;
    openCropModal(blob, isProcessed, (croppedBlob, wasProcessed) => {
      const st2 = wState.get(slotRef)!;
      if (wasProcessed) {
        st2.processed = croppedBlob;
        st2.croppedProcessed = true;
      } else {
        st2.original = croppedBlob;
        st2.croppedOriginal = true;
        // The cached bg-removed cutout no longer matches the newly-cropped original — drop it
        // so "Remove background" becomes available again instead of offering a stale "Restore".
        st2.processed = undefined;
        st2.pristineProcessed = undefined;
        st2.useProcessed = false;
        st2.croppedProcessed = false;
      }
      if (panelImg) panelImg.src = URL.createObjectURL(croppedBlob);
      if (slotRef === activeSlot) updatePanelButtons();
      setSlotThumbnail(slotRef, URL.createObjectURL(croppedBlob));
    });
  });

  changeBtn?.addEventListener('click', () => {
    if (!activeSlot) return;
    pendingPickSlot = activeSlot;
    sharedFileInput?.click();
  });

  cancelBtn?.addEventListener('click', () => {
    if (!activeSlot) return;
    revertSlot(activeSlot);
    closePanel();
  });

  doneBtn?.addEventListener('click', closePanel);
}

export async function resolveGalleryUrls(
  gallery: Element, cloud: string, preset: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // **Counted BEFORE uploading, so a caller can say "1 of 3" rather than just "working".**
  // Reported 2026-08-03: a seller who picks a photo and hits Save without closing the image editor
  // first pays for the whole upload inside that click, and the button said "שומר..." throughout —
  // so the slow part was the one part the label denied was happening. A total is the difference
  // between a progress report and a spinner.
  const pending: { slot: Element; blob: Blob }[] = [];
  if (cloud && preset) {
    for (const slot of gallery.querySelectorAll<Element>('.gallery-slot')) {
      const st = wState.get(slot);
      if (!st?.original) continue;
      pending.push({ slot, blob: st.useProcessed && st.processed ? st.processed : st.original });
    }
  }
  if (!pending.length) return;

  onProgress?.(0, pending.length);
  for (let i = 0; i < pending.length; i++) {
    const { slot, blob } = pending[i]!;
    const url = await cloudinaryUpload(blob, cloud, preset);
    const urlInput = slot.querySelector<HTMLInputElement>('.gallery-slot__url');
    if (urlInput) { urlInput.value = url; announceValueChange(urlInput); }
    onProgress?.(i + 1, pending.length);
  }
}

// After a save, treat the just-uploaded image as the new starting point: drop every
// in-memory blob (original/processed/crop history) so the next "edit" click behaves
// like a fresh page load instead of resuming mid-edit from before this save.
export function finalizeGallery(gallery: Element): void {
  gallery.querySelectorAll<Element>('.gallery-slot').forEach((slot) => {
    const st = wState.get(slot);
    if (st) {
      st.original = undefined; st.processed = undefined; st.useProcessed = false;
      st.pristineOriginal = undefined; st.pristineProcessed = undefined;
      st.croppedOriginal = false; st.croppedProcessed = false; st.processing = false;
    }
    const urlInput = slot.querySelector<HTMLInputElement>('.gallery-slot__url');
    const slotImg  = slot.querySelector<HTMLImageElement>('.gallery-slot__img');
    if (slotImg && urlInput?.value) slotImg.src = urlInput.value;
  });
}

// Same effect as clicking the gallery panel's own "Done" button — used when saving the
// product should implicitly close the image editor too, without waiting for that click.
export function closeGalleryPanel(gallery: Element): void {
  gallery.querySelectorAll<Element>('.gallery-slot').forEach(s => s.classList.remove('gallery-slot--active'));
  gallery.querySelector<HTMLElement>('.gallery-panel')?.setAttribute('hidden', '');
  const panelImg = gallery.querySelector<HTMLImageElement>('.gallery-panel__img');
  if (panelImg) panelImg.src = '';
}

export function resetGallery(gallery: Element): void {
  gallery.querySelectorAll<Element>('.gallery-slot').forEach((slot) => {
    const st = wState.get(slot);
    if (st) {
      st.original = undefined; st.processed = undefined; st.useProcessed = false;
      st.pristineOriginal = undefined; st.pristineProcessed = undefined;
      st.croppedOriginal = false; st.croppedProcessed = false;
    }
    const slotImg   = slot.querySelector<HTMLImageElement>('.gallery-slot__img');
    const empty     = slot.querySelector<HTMLElement>('.gallery-slot__empty');
    const filled    = slot.querySelector<HTMLElement>('.gallery-slot__filled');
    const urlInput  = slot.querySelector<HTMLInputElement>('.gallery-slot__url');
    if (slotImg) slotImg.src = '';
    empty?.removeAttribute('hidden');
    filled?.setAttribute('hidden', '');
    if (urlInput) { urlInput.value = ''; announceValueChange(urlInput); }
  });
  const sharedFileInput = gallery.querySelector<HTMLInputElement>('.gallery-shared-file-input');
  if (sharedFileInput) sharedFileInput.value = '';
  gallery.querySelector<HTMLElement>('.gallery-panel')?.setAttribute('hidden', '');
  const panelImg = gallery.querySelector<HTMLImageElement>('.gallery-panel__img');
  if (panelImg) panelImg.src = '';
}

