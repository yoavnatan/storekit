// Generic floating dropdown portal — one body-anchored element per instance,
// repositioned via getBoundingClientRect() and clamped to the viewport on
// every open, so it can never render off-screen regardless of where its
// trigger sits (a plain position:absolute anchored to the trigger only works
// when the trigger is guaranteed to sit near that edge, which a toolbar
// button in a wrapping flex row is not). Content is swapped via innerHTML
// per open — this module owns positioning/open/close only, not what's
// rendered inside.
export interface FloatingPortal {
  open(anchor: HTMLElement, minWidth: string, buildHtml: () => string, wire: (portal: HTMLElement) => void): void;
  close(): void;
  currentTrigger(): HTMLElement | null;
}

export function createFloatingPortal(portalId: string): FloatingPortal {
  let trigger: HTMLElement | null = null;

  function getPortal(): HTMLElement {
    let portal = document.getElementById(portalId);
    if (!portal) {
      portal = document.createElement('div');
      portal.id = portalId;
      portal.className = 'toolbar-portal fixed bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-[var(--radius)] shadow-[0_4px_20px_rgba(0,0,0,0.13)] p-[.3rem] z-[300] animate-product-menu-open';
      portal.setAttribute('role', 'menu');
      portal.hidden = true;
      document.body.appendChild(portal);
    }
    return portal;
  }

  function position(portal: HTMLElement, anchor: HTMLElement): void {
    const isRTL = getComputedStyle(document.documentElement).direction === 'rtl';
    const margin = 8;
    const anchorRect = anchor.getBoundingClientRect();
    const portalRect = portal.getBoundingClientRect();
    let left = isRTL ? anchorRect.right - portalRect.width : anchorRect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - portalRect.width - margin));
    // Open below the trigger by default; flip above it when there isn't room
    // left in the viewport, instead of sliding down and clamping flush
    // against the bottom edge (reads as "stuck to the bottom of the screen",
    // CURRENT_TASK.md) — a real order card near the end of a long list
    // rarely has 320px of room below it.
    let top = anchorRect.bottom + 4;
    if (top + portalRect.height > window.innerHeight - margin) {
      top = anchorRect.top - portalRect.height - 4;
    }
    top = Math.max(margin, top);
    portal.style.left = `${left}px`;
    portal.style.top = `${top}px`;
  }

  function close(): void {
    const portal = document.getElementById(portalId);
    if (portal) portal.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    trigger = null;
  }

  function open(anchor: HTMLElement, minWidth: string, buildHtml: () => string, wire: (portal: HTMLElement) => void): void {
    const portal = getPortal();
    portal.style.minWidth = minWidth;
    portal.style.maxHeight = '320px';
    portal.style.overflow = 'auto';
    portal.innerHTML = buildHtml();
    portal.hidden = false;
    position(portal, anchor);
    anchor.setAttribute('aria-expanded', 'true');
    trigger = anchor;
    wire(portal);
  }

  document.addEventListener('click', (e) => {
    const portal = document.getElementById(portalId);
    if (!portal || portal.hidden) return;
    // composedPath(), not target.contains() — a portal click that swaps
    // portal.innerHTML (e.g. re-rendering after a checkbox change) detaches
    // the original e.target from the document mid-bubble, so a containment
    // check done here after that swap wrongly reads as "outside" and closes
    // the portal right after it opens.
    const path = e.composedPath();
    if (path.includes(portal)) return;
    if (trigger && path.includes(trigger)) return;
    close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  // The portal is position:fixed and only positioned once, on open — left
  // alone, it doesn't track the trigger as the page scrolls, so it stays
  // floating in the same screen spot while the trigger (e.g. an order
  // card's status button, in a long scrollable list) scrolls away
  // underneath it. Re-running position() on every scroll keeps it visually
  // pinned to the trigger instead — only an outside click/Escape should
  // close it, not scrolling (CURRENT_TASK.md). Capture phase, since a
  // scrollable container's own scroll doesn't bubble to document; scrolling
  // *inside* the portal itself (its own overflow:auto content) must not
  // move it.
  document.addEventListener('scroll', (e) => {
    const portal = document.getElementById(portalId);
    if (!portal || portal.hidden || !trigger) return;
    if (e.target instanceof Node && portal.contains(e.target)) return;
    position(portal, trigger);
  }, true);

  return { open, close, currentTrigger: () => trigger };
}
