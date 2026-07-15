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
    let top = anchorRect.bottom + 4;
    top = Math.min(top, Math.max(margin, window.innerHeight - portalRect.height - margin));
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

  return { open, close, currentTrigger: () => trigger };
}
