/** A small radial burst of dots in the site's own palette — a "confetti but
 * not" celebratory cue for a successful action, restrained rather than
 * literal confetti (no rainbow colors/varied shapes). Positioned `fixed` off
 * the target's own bounding box so it isn't clipped by a rounded container
 * (e.g. the qty-stepper pill) the way a same-element ripple would be. */
export function spawnBurst(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const colors = ['var(--color-accent)', 'var(--color-text)', 'var(--color-accent-dark)'];
  const count = 7;

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
    const dist = 18 + Math.random() * 12;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const size = 4 + Math.random() * 3;

    const dot = document.createElement('span');
    Object.assign(dot.style, {
      position: 'fixed',
      left: `${cx}px`,
      top: `${cy}px`,
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: '50%',
      background: colors[i % colors.length]!,
      pointerEvents: 'none',
      zIndex: '9999',
    });
    document.body.appendChild(dot);

    const anim = dot.animate(
      [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.4)`, opacity: 0 },
      ],
      { duration: 500 + Math.random() * 100, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' }
    );
    anim.onfinish = () => dot.remove();
  }
}
