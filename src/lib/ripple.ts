export function spawnRipple(el: HTMLElement, clientX: number, clientY: number) {
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2.5;
  const inDarkCtx = !!el.closest('.lightbox') ||
    (el.classList.contains('btn') && !el.classList.contains('btn--ghost') && !el.classList.contains('btn--danger'));
  const color = inDarkCtx
    ? 'rgba(255,255,255,0.65)'
    : 'rgba(0,0,0,0.09)';

  const ripple = document.createElement('span');
  Object.assign(ripple.style, {
    position: 'absolute',
    borderRadius: '50%',
    width: `${size}px`,
    height: `${size}px`,
    left: `${clientX - rect.left - size / 2}px`,
    top: `${clientY - rect.top - size / 2}px`,
    pointerEvents: 'none',
    background: color,
    animation: 'ripple-wave 0.6s cubic-bezier(0.4, 0, 0.2, 1) forwards',
  });

  // The ripple needs to be clipped to el's shape, but el itself must stay
  // overflow:visible at all times — some buttons (e.g. the avatar) position
  // a corner badge outside their own box, and clipping el (even only while
  // the ripple animates) would swallow it for that whole window. So the clip
  // lives on a dedicated same-size layer that's a sibling of the badge, not
  // an ancestor — it only ever clips its own ripple children.
  let layer = el.querySelector<HTMLElement>(':scope > .ripple-layer');
  if (!layer) {
    layer = document.createElement('span');
    layer.className = 'ripple-layer';
    Object.assign(layer.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      borderRadius: 'inherit',
      pointerEvents: 'none',
    });
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.appendChild(layer);
  }

  layer.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
}
