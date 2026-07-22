// Shared JS-computed smooth scroll for the dashboard.
//
// Measured (not theoretical) on this RTL site: the browser's own native CSS
// smooth-scroll (`scroll-behavior:smooth` + `window.scrollTo({top, behavior:
// 'smooth'})`) visibly nudges window.scrollX away from 0 mid-animation and back
// — a diagonal jump — for a `top`-only scrollTo on a tall RTL document. Neither
// pinning `left` explicitly on the same call, nor a same-thread rAF loop forcing
// scrollX back to 0 every frame, stops it — the native animation runs off the
// main thread in a way that races both. The reliable fix is to not delegate to
// native smooth-scroll at all: animate scrollY ourselves and call the positional
// (always-instant, both-axes-explicit) `window.scrollTo(x, y)` every frame.
// (AI_INSTRUCTIONS → Architecture → Scroll.)
export function animateScrollTo(targetY: number, duration = 380): void {
  const startY = window.scrollY;
  const delta = targetY - startY;
  if (Math.abs(delta) < 1) { window.scrollTo(0, targetY); return; }
  const start = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3); // ease-out cubic, matches the site's other spring/ease timings in spirit

  function step(now: number) {
    const t = Math.min(1, (now - start) / duration);
    window.scrollTo(0, startY + delta * ease(t));
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
