import { galleryWidgetHtml } from '../../lib/gallery-widget.js';
import { removeBackgroundInWorker, cancelBgWorker } from './bg-worker.js';
import { cloudinaryUpload } from './cloudinary.js';
import { openCropModal } from './crop-modal.js';

export { galleryWidgetHtml };

export interface WidgetState { original?: Blob; processed?: Blob; useProcessed: boolean; processing: boolean }
const wState = new WeakMap<Element, WidgetState>();

export function initGalleryWidget(gallery: Element, cloud: string, preset: string): void {
  if ((gallery as HTMLElement).dataset.galleryInit) return;
  (gallery as HTMLElement).dataset.galleryInit = '1';

  const panel          = gallery.querySelector<HTMLElement>('.gallery-panel');
  const panelImg       = gallery.querySelector<HTMLImageElement>('.gallery-panel__img');
  const loadingOverlay = gallery.querySelector<HTMLElement>('.img-loading-overlay');
  const removeBgBtn    = gallery.querySelector<HTMLButtonElement>('.gallery-remove-bg-btn');
  const restoreBgBtn   = gallery.querySelector<HTMLButtonElement>('.gallery-restore-bg-btn');
  const keepBgBtn      = gallery.querySelector<HTMLButtonElement>('.gallery-keep-bg-btn');
  const cropBtn        = gallery.querySelector<HTMLButtonElement>('.gallery-crop-btn');
  const changeBtn      = gallery.querySelector<HTMLButtonElement>('.gallery-change-btn');
  const doneBtn        = gallery.querySelector<HTMLButtonElement>('.gallery-done-btn');
  const form           = gallery.closest<HTMLFormElement>('form');
  const submitBtn      = form?.querySelector<HTMLButtonElement>('[type="submit"]');

  let activeSlot: Element | null = null;

  function getState(): WidgetState | null {
    return activeSlot ? (wState.get(activeSlot) ?? null) : null;
  }

  function getRemovingBgMsg() {
    try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').gallery?.removingBg ?? 'Removing background…'; } catch { return 'Removing background…'; }
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
    removeBgBtn?.toggleAttribute('hidden', hasProcessed || isProcessing);
    restoreBgBtn?.toggleAttribute('hidden', !hasProcessed || showingProcessed || isProcessing);
    keepBgBtn?.toggleAttribute('hidden', !showingProcessed && !isProcessing);
    const lockEdit = showingProcessed || isProcessing;
    if (cropBtn)   cropBtn.disabled   = lockEdit;
    if (changeBtn) changeBtn.disabled = lockEdit;
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
    if (st) { st.original = undefined; st.processed = undefined; st.useProcessed = false; }
    const slotImg   = slot.querySelector<HTMLImageElement>('.gallery-slot__img');
    const empty     = slot.querySelector<HTMLElement>('.gallery-slot__empty');
    const filled    = slot.querySelector<HTMLElement>('.gallery-slot__filled');
    const urlInput  = slot.querySelector<HTMLInputElement>('.gallery-slot__url');
    const fileInput = slot.querySelector<HTMLInputElement>('.gallery-file-input');
    if (slotImg) slotImg.src = '';
    empty?.removeAttribute('hidden');
    filled?.setAttribute('hidden', '');
    if (urlInput) urlInput.value = '';
    if (fileInput) fileInput.value = '';
  }

  function activateSlot(slot: Element) {
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

  gallery.querySelectorAll<Element>('.gallery-slot').forEach((slot) => {
    const fileInput = slot.querySelector<HTMLInputElement>('.gallery-file-input');
    const editBtn   = slot.querySelector<HTMLButtonElement>('.gallery-slot__action--edit');
    const removeBtn = slot.querySelector<HTMLButtonElement>('.gallery-slot__action--remove');
    const st: WidgetState = { useProcessed: false, processing: false };
    wState.set(slot, st);

    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      st.original = file; st.processed = undefined; st.useProcessed = false;
      setSlotThumbnail(slot, URL.createObjectURL(file));
      activateSlot(slot);
    });
    editBtn?.addEventListener('click', (e) => { e.stopPropagation(); activateSlot(slot); });
    removeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('confirm:open', {
        detail: {
          title: 'Remove image?',
          message: 'This image will be removed from the product.',
          okLabel: 'Remove',
          onConfirm: () => { clearSlot(slot); if (activeSlot === slot) closePanel(); },
        },
      }));
    });
  });

  removeBgBtn?.addEventListener('click', async () => {
    if (!activeSlot) return;
    const st = wState.get(activeSlot)!;
    if (!st.original) {
      const urlInput = activeSlot.querySelector<HTMLInputElement>('.gallery-slot__url');
      const url = urlInput?.value;
      if (!url) return;
      setLoading(true);
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('fetch failed');
        st.original = await resp.blob();
      } catch { setLoading(false); updatePanelButtons(); return; }
    }
    setLoading(true);
    updatePanelButtons();
    try {
      const processed = await removeBackgroundInWorker(st.original!);
      st.processed = processed; st.useProcessed = true;
      if (panelImg) panelImg.src = URL.createObjectURL(processed);
      if (activeSlot) setSlotThumbnail(activeSlot, URL.createObjectURL(processed));
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') return;
    } finally { setLoading(false); updatePanelButtons(); }
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

  cropBtn?.addEventListener('click', () => {
    if (!activeSlot) return;
    const st = wState.get(activeSlot)!;
    const blob = st.useProcessed && st.processed ? st.processed : st.original;
    if (!blob) return;
    const isProcessed = !!(st.useProcessed && st.processed);
    const slotRef = activeSlot;
    openCropModal(blob, isProcessed, (croppedBlob, wasProcessed) => {
      const st2 = wState.get(slotRef)!;
      if (wasProcessed) st2.processed = croppedBlob;
      else st2.original = croppedBlob;
      if (panelImg) panelImg.src = URL.createObjectURL(croppedBlob);
      setSlotThumbnail(slotRef, URL.createObjectURL(croppedBlob));
    });
  });

  changeBtn?.addEventListener('click', () => {
    if (!activeSlot) return;
    activeSlot.querySelector<HTMLInputElement>('.gallery-file-input')?.click();
  });

  doneBtn?.addEventListener('click', closePanel);
}

export async function resolveGalleryUrls(gallery: Element, cloud: string, preset: string): Promise<void> {
  const slots = gallery.querySelectorAll<Element>('.gallery-slot');
  for (const slot of slots) {
    const st = wState.get(slot);
    const urlInput = slot.querySelector<HTMLInputElement>('.gallery-slot__url');
    if (!st?.original || !(cloud && preset)) continue;
    const blob = st.useProcessed && st.processed ? st.processed : st.original;
    const url = await cloudinaryUpload(blob, cloud, preset);
    if (urlInput) urlInput.value = url;
  }
}

export function resetGallery(gallery: Element): void {
  gallery.querySelectorAll<Element>('.gallery-slot').forEach((slot) => {
    const st = wState.get(slot);
    if (st) { st.original = undefined; st.processed = undefined; st.useProcessed = false; }
    const slotImg   = slot.querySelector<HTMLImageElement>('.gallery-slot__img');
    const empty     = slot.querySelector<HTMLElement>('.gallery-slot__empty');
    const filled    = slot.querySelector<HTMLElement>('.gallery-slot__filled');
    const urlInput  = slot.querySelector<HTMLInputElement>('.gallery-slot__url');
    const fileInput = slot.querySelector<HTMLInputElement>('.gallery-file-input');
    if (slotImg) slotImg.src = '';
    empty?.removeAttribute('hidden');
    filled?.setAttribute('hidden', '');
    if (urlInput) urlInput.value = '';
    if (fileInput) fileInput.value = '';
  });
  gallery.querySelector<HTMLElement>('.gallery-panel')?.setAttribute('hidden', '');
  const panelImg = gallery.querySelector<HTMLImageElement>('.gallery-panel__img');
  if (panelImg) panelImg.src = '';
}

