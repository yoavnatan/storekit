export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface GalleryLabels {
  main?: string;
  removeBg?: string;
  restoreBg?: string;
  keepOriginal?: string;
  cleanup?: string;
  crop?: string;
  undoCrop?: string;
  changeImage?: string;
  done?: string;
  removingBg?: string;
}

export function galleryWidgetHtml(images: string[] = [], labels: GalleryLabels = {}): string {
  const l = {
    main:          labels.main          ?? 'Main',
    removeBg:      labels.removeBg      ?? 'Remove background',
    restoreBg:     labels.restoreBg     ?? 'Restore removed BG',
    keepOriginal:  labels.keepOriginal  ?? 'Restore original',
    cleanup:       labels.cleanup       ?? 'Manual cleanup',
    crop:          labels.crop          ?? 'Crop',
    undoCrop:      labels.undoCrop      ?? 'Undo crop',
    changeImage:   labels.changeImage   ?? 'Change image',
    done:          labels.done          ?? 'Done',
    removingBg:    labels.removingBg    ?? 'Removing background…',
  };

  const uploadIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  const editIcon   = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const removeIcon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  // Panel action icons — same wand icon for remove/restore-bg (they're the same conceptual
  // action, just from different states); undo-crop reuses the restore-original undo arrow.
  const wandIcon    = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>`;
  const undoIcon    = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>`;
  const brushIcon   = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></svg>`;
  const cropIcon    = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>`;
  const checkIcon   = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

  const slots = [0, 1, 2, 3, 4].map((i) => {
    const url = images[i] ?? '';
    const hasUrl = !!url;
    return `
      <div class="gallery-slot" data-slot="${i}">
        <label class="gallery-slot__empty"${hasUrl ? ' hidden' : ''}>
          ${i === 0 ? `<span class="gallery-slot__label">${l.main}</span>` : ''}
          ${uploadIcon}
          <input type="file" accept="image/*" class="visually-hidden gallery-file-input">
        </label>
        <div class="gallery-slot__filled"${hasUrl ? '' : ' hidden'}>
          <img class="gallery-slot__img" src="${esc(url)}" alt="" width="88" height="88" loading="lazy" decoding="async">
          <div class="gallery-slot__overlay">
            <button type="button" class="gallery-slot__action gallery-slot__action--edit" aria-label="Edit image">${editIcon}</button>
            <button type="button" class="gallery-slot__action gallery-slot__action--remove" aria-label="Remove image">${removeIcon}</button>
          </div>
          <div class="gallery-slot__loading" hidden><div class="spinner spinner--sm"></div></div>
        </div>
        <input type="hidden" name="images" class="gallery-slot__url" value="${esc(url)}">
      </div>`;
  });

  return `
    <div class="gallery-widget">
      <div class="gallery-grid">${slots.join('')}</div>
      <div class="gallery-panel" hidden>
        <div class="gallery-panel__inner">
          <div class="img-preview-box">
            <img class="gallery-panel__img img-preview__img" src="" alt="Product image" width="160" height="160">
            <div class="img-loading-overlay" hidden>
              <div class="spinner"></div>
              <span>${esc(l.removingBg)}</span>
            </div>
          </div>
          <div class="img-preview__actions">
            <div class="img-preview__actions-group">
              <button type="button" class="btn btn--sm gallery-remove-bg-btn">${wandIcon}${esc(l.removeBg)}</button>
              <button type="button" class="btn btn--ghost btn--sm gallery-restore-bg-btn" hidden>${wandIcon}${esc(l.restoreBg)}</button>
              <button type="button" class="btn btn--ghost btn--sm gallery-keep-bg-btn" hidden>${undoIcon}${esc(l.keepOriginal)}</button>
              <button type="button" class="btn btn--ghost btn--sm gallery-cleanup-btn" hidden>${brushIcon}${esc(l.cleanup)}</button>
              <button type="button" class="btn btn--ghost btn--sm gallery-crop-btn">${cropIcon}${esc(l.crop)}</button>
              <button type="button" class="btn btn--ghost btn--sm gallery-undo-crop-btn" hidden>${undoIcon}${esc(l.undoCrop)}</button>
            </div>
            <div class="img-preview__actions-group img-preview__actions-group--meta">
              <button type="button" class="btn btn--ghost btn--sm gallery-change-btn">${uploadIcon}${esc(l.changeImage)}</button>
              <button type="button" class="btn btn--ghost btn--sm gallery-done-btn">${checkIcon}${esc(l.done)}</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}
