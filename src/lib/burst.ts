/* eslint-disable sonarjs/pseudo-random -- decorative jitter only: the angle, distance and size
 * of confetti dots. Nothing here is a token, an id or a choice anyone could exploit by predicting
 * it, and a CSPRNG would buy nothing but a slower animation. */

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

const HEART_PATH = 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';

/** A little fan of hearts floating up from the target — the celebratory cue
 * when a shopper "likes" (wishlists) a product. Fire it only on activation,
 * never on un-like. Positioned `fixed` off the target's box so a rounded /
 * clipped container can't swallow it (same rationale as spawnBurst). Also pops
 * the button's own heart icon with a springy scale+wobble when one is found. */
export function spawnHeartBurst(el: HTMLElement) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const icon = el.querySelector<SVGElement>('svg');
  icon?.animate(
    [
      { transform: 'scale(1) rotate(0deg)' },
      { transform: 'scale(1.45) rotate(-12deg)', offset: 0.35 },
      { transform: 'scale(0.9) rotate(7deg)', offset: 0.62 },
      { transform: 'scale(1) rotate(0deg)' },
    ],
    { duration: 460, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
  );

  // Emit from the heart icon itself, not the button box — otherwise on a
  // button with a text label ("אהבתי") the burst would launch from the middle
  // of the text rather than out of the heart.
  const rect = (icon ?? el).getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const count = 6;

  for (let i = 0; i < count; i++) {
    // Fan the hearts upward (centred on -90°), spread ±, with a little jitter.
    const angle = -Math.PI / 2 + (i - (count - 1) / 2) * 0.42 + (Math.random() - 0.5) * 0.3;
    const dist = 26 + Math.random() * 18;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const size = 9 + Math.random() * 5;

    const span = document.createElement('span');
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#e53e3e" stroke="none" aria-hidden="true"><path d="${HEART_PATH}"/></svg>`;
    Object.assign(span.style, {
      position: 'fixed',
      left: `${cx}px`,
      top: `${cy}px`,
      pointerEvents: 'none',
      zIndex: '9999',
      willChange: 'transform, opacity',
    });
    document.body.appendChild(span);

    const anim = span.animate(
      [
        { transform: 'translate(-50%,-50%) scale(0.3)', opacity: 0 },
        { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5}px)) scale(1)`, opacity: 1, offset: 0.4 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.5)`, opacity: 0 },
      ],
      { duration: 650 + Math.random() * 160, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' }
    );
    anim.onfinish = () => span.remove();
  }
}

/** The one multi-hue flourish on the site — see the `--color-confetti-*` block in
 *  base/tokens.css for why a celebration may be many colours where a surface may not.
 *  Six is enough that no two neighbouring pieces match; the list is walked in order and
 *  only the jitter is random, so a burst can never come out all one colour by chance. */
const CONFETTI_COLORS = [
  'var(--color-confetti-1)', 'var(--color-confetti-2)', 'var(--color-confetti-3)',
  'var(--color-confetti-4)', 'var(--color-confetti-5)', 'var(--color-confetti-6)',
];

/** A short confetti fall over `el` — pieces launch upward from along the element's own
 *  width, tumble, and drop past it. Used once, when the checkout's savings row scrolls
 *  into view (`checkout.astro`): the shopper reaches the number they saved and the page
 *  reacts to it. Deliberately NOT a click cue — `spawnBurst`/`spawnHeartBurst` above are
 *  that, and they stay restrained and near-monochrome because they fire many times a
 *  session, where this fires at most once.
 *
 *  `fixed`, off the target's viewport box, for the same reason as the two above: a
 *  rounded / overflow-hidden ancestor (the checkout summary card is one) would otherwise
 *  clip every piece that leaves the row. That also makes it correct to fire only while the
 *  row is ON SCREEN — a fixed-position burst drawn for an element scrolled away lands in
 *  the middle of whatever the shopper is actually looking at instead. */
export function spawnConfetti(el: HTMLElement) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const rect = el.getBoundingClientRect();
  // Nothing to decorate — the row is display:none (no saving) or has no box yet.
  if (rect.width === 0 || rect.height === 0) return;

  const count = 22;
  for (let i = 0; i < count; i++) {
    // Spread along the row rather than out of its centre: the row is wide and short, so a
    // radial burst from the middle reads as an explosion inside the text, not as confetti
    // over it.
    const x = rect.left + rect.width * ((i + 0.5) / count + (Math.random() - 0.5) * 0.04);
    const y = rect.top + rect.height * 0.5;
    // Outward from the row's centre, so the fan follows the row's own shape.
    const spread = (x - (rect.left + rect.width / 2)) * 0.35 + (Math.random() - 0.5) * 60;
    const rise = 34 + Math.random() * 46;
    const fall = rise + 90 + Math.random() * 70;
    const spin = (Math.random() - 0.5) * 720;
    const w = 4 + Math.random() * 4;
    const h = w * (1.4 + Math.random());
    const round = i % 3 === 0;

    const piece = document.createElement('span');
    Object.assign(piece.style, {
      position: 'fixed',
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${round ? w : h}px`,
      borderRadius: round ? '50%' : '1px',
      background: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
      pointerEvents: 'none',
      zIndex: '9999',
      willChange: 'transform, opacity',
    });
    document.body.appendChild(piece);

    const anim = piece.animate(
      [
        { transform: 'translate(-50%,-50%) translate(0,0) rotate(0deg)', opacity: 1, offset: 0 },
        { transform: `translate(-50%,-50%) translate(${spread * 0.6}px, ${-rise}px) rotate(${spin * 0.45}deg)`, opacity: 1, offset: 0.38 },
        { transform: `translate(-50%,-50%) translate(${spread}px, ${fall}px) rotate(${spin}deg)`, opacity: 0, offset: 1 },
      ],
      // Long enough to read as a fall rather than a pop, and each piece slightly out of step
      // with the next so the group never moves as one block.
      { duration: 1100 + Math.random() * 500, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'forwards' }
    );
    anim.onfinish = () => piece.remove();
  }
}
