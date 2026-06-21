export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface GalleryLabels {
  main?: string;
  removeBg?: string;
  restoreBg?: string;
  keepOriginal?: string;
  crop?: string;
  changeImage?: string;
  done?: string;
  removingBg?: string;
}

export function galleryWidgetHtml(images: string[] = [], labels: GalleryLabels = {}): string {
  const l = {
    main:          labels.main          ?? 'Main',
    removeBg:      labels.removeBg      ?? 'Remove background',
    restoreBg:     labels.restoreBg     ?? 'Restore removed BG',
    keepOriginal:  labels.keepOriginal  ?? 'Keep original',
    crop:          labels.crop          ?? 'Crop',
    changeImage:   labels.changeImage   ?? 'Change image',
    done:          labels.done          ?? 'Done',
    removingBg:    labels.removingBg    ?? 'Removing background…',
  };

  const uploadIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  const editIcon   = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const removeIcon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

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
            <button type="button" class="btn btn--sm gallery-remove-bg-btn">${esc(l.removeBg)}</button>
            <button type="button" class="btn btn--ghost btn--sm gallery-restore-bg-btn" hidden>${esc(l.restoreBg)}</button>
            <button type="button" class="btn btn--ghost btn--sm gallery-keep-bg-btn" hidden>${esc(l.keepOriginal)}</button>
            <button type="button" class="btn btn--ghost btn--sm gallery-crop-btn">${esc(l.crop)}</button>
            <button type="button" class="btn btn--ghost btn--sm gallery-change-btn">${esc(l.changeImage)}</button>
            <button type="button" class="btn btn--ghost btn--sm gallery-done-btn">${esc(l.done)}</button>
          </div>
        </div>
      </div>
    </div>`;
}
