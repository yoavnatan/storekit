// Site-wide hover label for icon-only controls.
//
// An icon-only button already states its meaning in `aria-label`, so a screen
// reader is fine — a sighted mouse user gets nothing but the glyph, and there
// are ~100 such controls across the header, drawers, modals, dashboard and
// admin. Placing a tooltip per surface is the version of this that rots: the
// next icon button ships without one and nobody notices. So this binds ONE
// delegated listener that reads the control's own `aria-label` at hover time.
// Nothing to remember when adding an icon button — give it the aria-label
// accessibility already requires and the hover label follows.
//
// Reuses the shared floating tooltip (tooltip.ts); it does not build a second
// tooltip mechanism.
import { showTooltip, hideTooltip, mountTooltipIn } from './tooltip.js';

// Deliberately unhurried: sweeping the cursor across a toolbar should show
// nothing at all, only resting on one control should.
const OPEN_DELAY = 450;

let timer: number | undefined;
let current: HTMLElement | null = null;
// The control a timer is counting down for. Tracked separately from `current` because "nothing is
// showing" and "nothing is on its way" are different states, and conflating them is what let a
// tooltip open after the pointer had already left (see the mouseover handler).
let pending: HTMLElement | null = null;

/** Drop whitespace and the punctuation that only ever JOINS parts — so an accessible name reads
 *  the same as the words it was built from, wherever the layout put them. An accessible name is
 *  routinely one string ("Name — ₪120") over what the eye sees as two elements, and the gap
 *  between them is a line break, an em-dash or both, none of which the shopper reads as content.
 *  Only separators are dropped: everything that carries meaning survives, so "Sort by price" still
 *  does not match a column header that says "Price". */
function squash(s: string): string {
  // ‎‏؜ are the bidi marks an RTL string picks up around a price or a Latin word.
  return s.replace(/[\s‎‏؜–—·•|,:;-]+/gu, '');
}

/** The icon control under `target`, or null if this isn't one. */
function candidate(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>('button, a, summary, [role="button"]');
  if (!el) return null;
  // `data-tooltip` is the explicit opt-in mechanism (InfoTip, the charts) and
  // binds its own handlers; `title` is the browser's own tooltip. Either one
  // already labels this control — ours would be the second one.
  if (el.dataset.tooltip !== undefined) return null;
  if (el.hasAttribute('title')) return null;
  // An open menu/dropdown needs no label: the thing it opened is on screen, and
  // the panel is often rendered INSIDE the trigger — so hovering into the menu
  // resolves back up to the trigger and re-showed its tooltip over the open
  // menu (the header's avatar button did exactly that).
  if (el.getAttribute('aria-expanded') === 'true') return null;
  // Only squash() normalizes from here on — the tooltip itself renders the raw attribute.
  const label = el.getAttribute('aria-label');
  if (!label) return null;
  // Only icon-bearing controls: this exists for a glyph whose meaning isn't
  // written anywhere. Icons here are always inline SVG (or an <img>).
  if (!el.querySelector('svg, img')) return null;
  // ...and only when the whole label is ALREADY ON SCREEN.
  //
  // `innerText`, not `textContent`: textContent is layout-blind, and the dashboard toolbars keep
  // their label span in the DOM and hide it with CSS at mobile widths — so the buttons that go
  // icon-only are exactly the ones textContent claimed were labelled. Same for the store product
  // card's add-to-cart and its display:none qty readout. innerText costs a layout read, on one
  // element, once per hover. (jsdom has no innerText, hence the fallback.)
  //
  // And only `text.includes(label)`, never the reverse: a sort button shows "Price" while its
  // label is "Sort by price", and that extra word is the whole reason the tooltip is wanted. The
  // reverse direction would have suppressed it. A count badge nested in the button (header bell,
  // cart) is harmless for the same reason — "23" does not contain "open cart".
  //
  // Compared through squash() (below), and against the CARD the control sits in, not only the
  // control itself — two ways the same words on screen used to slip past a plain comparison:
  //   · The homepage tile is one <a> labelled "Name — ₪120" while the name and the price are two
  //     separate spans, so the em-dash and the line break between them made a literal `includes`
  //     false and the tile's own caption floated over it.
  //   · The store product card's photo is a role="button" labelled with the product name, and the
  //     name is printed right below the picture — outside the button, inside the card.
  const key = squash(label);
  if (!key) return null; // a label of nothing but punctuation labels nothing
  if (squash((el as HTMLElement).innerText ?? el.textContent ?? '').includes(key)) return null;
  const card = el.closest<HTMLElement>('li, article, tr');
  if (card && card !== el && squash(card.innerText ?? card.textContent ?? '').includes(key)) return null;
  return el;
}

/** A dialog opened with showModal() paints in the top layer — a body-anchored
 *  tooltip would sit behind it. Same reason tooltip.ts exports mountTooltipIn. */
function hostFor(el: HTMLElement): HTMLElement {
  const dlg = el.closest('dialog');
  try {
    if (dlg?.matches(':modal')) return dlg;
  } catch {
    // :modal unsupported — fall through to <body>, worst case the tooltip is
    // hidden behind the dialog rather than misplaced.
  }
  return document.body;
}

/** Take down a tooltip that is currently showing, leaving any pending one alone. */
function hide(): void {
  if (!current) return;
  current = null;
  hideTooltip();
}

/** Hide, and abandon a tooltip that was about to open. */
function cancel(): void {
  window.clearTimeout(timer);
  pending = null;
  hide();
}

function open(el: HTMLElement): void {
  pending = null;
  if (!el.isConnected) return;
  // A `:hover` re-check was tried here as belt and braces and removed: jsdom never reports :hover,
  // so it made the whole module untestable, and if the pointer state is ever read wrong the
  // tooltip silently never appears. Correct cancellation is the fix; this is not a second one.
  current = el;
  mountTooltipIn(hostFor(el));
  showTooltip(el, el.getAttribute('aria-label') ?? '');
}

export function initIconTooltips(): void {
  // Hover-only affordance. On touch there is no hover and `mouseover` fires on
  // tap, so a tooltip would flash over the very thing that was just tapped.
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  // Delegated rather than per-element: most of these controls are rebuilt via
  // innerHTML (cart drawer rows, order cards, product tables), so per-element
  // binding would need a re-init call at every one of those call sites.
  document.addEventListener('mouseover', (e) => {
    const el = candidate(e.target);
    // Only a genuine "nothing changed" may return early. `el === current` alone also matched
    // null === null — the pointer leaving a control for ordinary page, with that control's
    // tooltip still counting down — so the timer survived and the label appeared 450ms later
    // with the cursor long gone (reported on the notifications bell: hover, flick away, tooltip).
    if (el && (el === current || el === pending)) return;
    if (!el && !current && !pending) return;
    cancel();
    if (el) {
      pending = el;
      timer = window.setTimeout(() => open(el), OPEN_DELAY);
    }
  });
  document.addEventListener('mouseleave', cancel);

  // Keyboard users get it too, but only on a real keyboard focus ring —
  // :focus-visible is false for a mouse click, where a tooltip on the button
  // just pressed is noise.
  document.addEventListener('focusin', (e) => {
    const el = candidate(e.target);
    if (!el || !el.matches(':focus-visible')) return;
    cancel();
    open(el);
  });
  document.addEventListener('focusout', cancel);

  // A click means the user has acted — and it often removes the anchor outright
  // (close buttons, drawer rows), so nothing should be left floating.
  document.addEventListener('click', cancel, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancel(); });
  // A shown tooltip is position:fixed against a snapshot of the anchor's rect,
  // so scrolling strands it — but only `hide`, never `cancel`: capture-phase
  // scroll fires for every nested scroller including a self-animating carousel,
  // and cancelling there swallowed the tooltip of any control sitting next to
  // one (measured on the homepage spotlight). A pending tooltip is unaffected
  // because open() reads the rect when it fires, not when it was scheduled.
  document.addEventListener('scroll', hide, { capture: true, passive: true });
}
