/** Ripple anchored to document.body — use when the target element may be destroyed mid-animation. */
export function spawnFloatingRipple(clientX: number, clientY: number): void {
  const size = 52;
  const ripple = document.createElement('span');
  Object.assign(ripple.style, {
    position: 'fixed',
    borderRadius: '50%',
    width:  `${size}px`,
    height: `${size}px`,
    left: `${clientX - size / 2}px`,
    top:  `${clientY - size / 2}px`,
    pointerEvents: 'none',
    background: 'color-mix(in srgb, var(--color-accent) 22%, transparent)',
    animation: 'ripple-wave 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards',
    zIndex: '9999',
  });
  document.body.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
}

export function spawnRipple(el: HTMLElement, clientX: number, clientY: number) {
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2.5;
  const inDarkCtx = !!el.closest('.lightbox') ||
    (el.classList.contains('btn') && !el.classList.contains('btn--ghost') && !el.classList.contains('btn--danger'));
  const color = inDarkCtx
    ? 'rgba(255,255,255,0.65)'
    : 'color-mix(in srgb, var(--color-accent) 22%, transparent)';

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

  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.style.overflow = 'hidden';
  el.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
}
