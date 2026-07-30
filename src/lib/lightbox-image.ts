/**
 * Full-screen (lightbox) image loading — one mechanism for all three viewers:
 * the product page's `#lightbox`, `StoreProductModal`'s `#spm-lightbox` and
 * `ProductQuickView`'s `#co-lightbox`.
 *
 * The problem: enlarging asks the CDN for a 1600px render that nothing on the
 * page has downloaded yet, so the frame sat black until it arrived — on a slow
 * connection, for seconds, with no sign anything was happening.
 *
 * The fix is content-first, not a spinner over a void: paint the gallery-sized
 * image the page ALREADY has in cache (instantly, softened so it reads as
 * "resolving" rather than "our photos are blurry"), then swap the full render
 * in once it has DECODED — same element, no blank frame between the two. The
 * dot-pulse pill (the site's standing in-flight primitive) only appears if the
 * wait passes `LOADER_DELAY_MS`, so an already-cached image opens with no
 * visible loading state at all — a no-op interaction stays invisible.
 *
 * Markup contract: the element wrapping the `<img>` carries `data-lb-frame`
 * (the positioning context the pill centres in) and `data-lb-label` (the
 * translated status text). The `<img>` carries a filter/transform transition.
 */
import { LIGHTBOX_WIDTHS } from './cdn.js';

/** Long enough that a cached open never flashes the pill, short enough to feel responsive. */
const LOADER_DELAY_MS = 180;

/**
 * The soft state. Deliberately gentle: the preview is a real gallery render,
 * often close to the size it's shown at, so a heavy blur would be destroying a
 * good image rather than standing in for a missing one — 10px reads as
 * "resolving" while the subject stays recognisable. The scale is not
 * decoration: `blur()` fades out at the element's edges, and the 3% overscan
 * pushes that falloff past the frame so no translucent rim shows against the
 * black backdrop.
 */
const PREVIEW_CLASSES = ['blur-[10px]', 'scale-[1.03]'];

export interface LightboxImageOptions {
  /** Full-size render to settle on. */
  full: string;
  /** Smaller URL the page already loaded — painted immediately. Omit if there is none. */
  preview?: string;
  /** Alt text for the enlarged image. */
  alt?: string;
  /**
   * Full-size URLs an arrow press away (see `neighbourIndexes`). Fetched only
   * once THIS image has settled, so the speculative bytes never compete with
   * the one the user is currently waiting on.
   */
  neighbours?: string[];
}

interface Pending {
  token: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Per-`<img>` state, so rapid arrow navigation can't let a stale decode win. */
const pending = new WeakMap<HTMLImageElement, Pending>();

function frameOf(img: HTMLImageElement): HTMLElement | null {
  return img.closest<HTMLElement>('[data-lb-frame]') ?? img.parentElement;
}

/**
 * The area the enlarged image gets, whether or not the viewer is open yet.
 *
 * `clientWidth` is 0 while the viewer is hidden (`hidden` attribute / closed
 * `<dialog>`), but every viewer's frame is full-viewport, so the viewport minus
 * that frame's own padding is the same number before and after opening — and
 * `getComputedStyle` still reports padding on a `display:none` element. That's
 * what lets the width be picked (and warmed) BEFORE the user clicks.
 */
function availableBox(frame: HTMLElement | null): { w: number; h: number } {
  if (!frame) return { w: window.innerWidth, h: window.innerHeight };
  const cs = getComputedStyle(frame);
  const padX = parseFloat(cs.paddingInlineStart) + parseFloat(cs.paddingInlineEnd);
  const padY = parseFloat(cs.paddingBlockStart) + parseFloat(cs.paddingBlockEnd);
  return {
    w: (frame.clientWidth || window.innerWidth) - padX,
    h: (frame.clientHeight || window.innerHeight) - padY,
  };
}

/**
 * A short shared ladder on purpose. Every distinct width is a separate Cloudinary
 * derivation, and the FIRST request for one costs ~1.2s of server-side render
 * before a byte moves (measured 2026-07-29; the same URL afterwards is ~0.3s).
 * Deriving per-viewport would hand that cold cost to a different unlucky buyer on
 * every screen size; three rungs mean the whole audience shares — and reuses —
 * the same three renders, which `image-derive.ts` warms at product-save time.
 * Defined in `cdn.ts` so the viewer and the save path cannot drift apart.
 */
const WIDTH_LADDER = LIGHTBOX_WIDTHS;

/**
 * The render width this screen actually needs, capped at 2x DPR.
 *
 * The old flat 1600 was the real cost of enlarging: a phone showing the photo
 * across ~310 CSS px was pulling a 1600px render — five times the pixels it can
 * resolve, and a width nothing else on the page had asked for, so it paid the
 * cold-derivation penalty too. Capped at 2x, a phone lands on w_800, which the
 * gallery underneath has ALREADY downloaded — the enlarge costs nothing and is
 * instant. Beyond 2x the extra pixels are invisible on a photo and only buy
 * download time.
 */
export function lightboxWidth(img: HTMLImageElement | null): number {
  const need = availableBox(img && frameOf(img)).w * Math.min(window.devicePixelRatio || 1, 2);
  return WIDTH_LADDER.find((w) => w >= need) ?? WIDTH_LADDER[WIDTH_LADDER.length - 1];
}

const warmed = new Set<string>();

/**
 * Start the enlarged render early, on a signal the user is heading for it
 * (hovering the image that opens the viewer).
 *
 * This is what the click cannot buy back: the render is requested at the moment
 * of the click today, so the buyer waits out the whole download — and the cold
 * derivation on top of it, if nobody has asked for that width before. Hovering
 * first spends that time while they are still looking at the small image. Low
 * priority so it never competes with what is already on screen, and deduped so
 * moving the mouse back and forth costs one request.
 */
export function warmLightboxImage(url: string): void {
  if (!url || warmed.has(url)) return;
  // Speculative bytes only. Someone who turned Data Saver on, or is on a 2G
  // connection, has said plainly that they'd rather wait for what they asked
  // for than pay for what they might ask for.
  const conn = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData || /^(slow-)?2g$/.test(conn?.effectiveType ?? '')) return;
  warmed.add(url);
  const pre = new Image();
  pre.setAttribute('fetchpriority', 'low');
  pre.decoding = 'async';
  pre.src = url;
}

/**
 * The images an arrow press away from `index` — wrapped, and de-duplicated so a
 * 2-image gallery doesn't ask for the same one twice.
 *
 * ±1 rather than the whole gallery: a viewer settling on image 2 queues image 3,
 * so anyone who actually browses ends up with everything anyway, paced by what
 * they really did. Preloading the lot up front instead bets the full gallery on
 * every open — flat ~150KB at four images (today's maximum), but unbounded, and
 * this platform is built for catalogue sellers who will post ten photos of one
 * jacket. Next before previous: forward is the direction people go.
 */
export function neighbourIndexes(length: number, index: number): number[] {
  if (length < 2) return [];
  const next = (index + 1) % length;
  const prev = (index - 1 + length) % length;
  return next === prev ? [next] : [next, prev];
}

function loaderOf(frame: HTMLElement): HTMLElement {
  const existing = frame.querySelector<HTMLElement>('[data-lb-loader]');
  if (existing) return existing;

  const el = document.createElement('div');
  el.setAttribute('data-lb-loader', '');
  el.setAttribute('role', 'status');
  const label = frame.dataset.lbLabel;
  if (label) el.setAttribute('aria-label', label);
  // Dark scrim, not the white-on-black of the lightbox arrows: this pill sits ON
  // the preview photo, and a white wash disappears the moment that photo is
  // light. Same treatment the PQV close button uses over a product image. The
  // hairline ring is what keeps it readable the other way round — over a dark
  // photo, or over the bare backdrop when there is no preview at all.
  el.className =
    'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[3] pointer-events-none ' +
    'flex items-center justify-center w-[3.25rem] h-[3.25rem] rounded-full ' +
    'bg-black/45 ring-1 ring-white/20 text-white text-[1.35rem] opacity-0 transition-opacity duration-200';
  el.innerHTML =
    '<span class="dot-pulse"><span class="dot-pulse__dot"></span>' +
    '<span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span></span>';
  frame.appendChild(el);
  return el;
}

function showLoader(frame: HTMLElement | null): void {
  if (!frame) return;
  const el = loaderOf(frame);
  el.dataset.lbLoader = 'on';
  // Next frame, so a freshly created node actually transitions in instead of
  // being painted at full opacity straight away — but only if it is still
  // wanted by then: an image that settles inside that one frame would otherwise
  // leave the pill switched on with nothing left to wait for.
  requestAnimationFrame(() => {
    if (el.dataset.lbLoader === 'on') el.classList.replace('opacity-0', 'opacity-100');
  });
}

function hideLoader(frame: HTMLElement | null): void {
  const el = frame?.querySelector<HTMLElement>('[data-lb-loader]');
  if (!el) return;
  el.dataset.lbLoader = '';
  el.classList.replace('opacity-100', 'opacity-0');
}

/**
 * Grow the preview to the box the full render will occupy.
 *
 * Without this the frame visibly pops on settle: the lightbox sizes the `<img>`
 * to its intrinsic width capped at `max-width/max-height:100%`, and a gallery
 * render smaller than the viewport isn't capped at all — so a 600px preview
 * drew a 600px frame that jumped to full-screen the instant the 1600px render
 * arrived. Same source, same aspect ratio, so scaling the preview into the
 * frame lands on exactly the box the full one will settle into.
 */
function fitPreviewToFrame(img: HTMLImageElement, frame: HTMLElement | null): void {
  const { naturalWidth: w, naturalHeight: h } = img;
  if (!frame || !w || !h) return;
  const avail = availableBox(frame);
  const scale = Math.min(avail.w / w, avail.h / h);
  if (!(scale > 1)) return; // already bigger than the frame — `max-*` handles it
  // Unrounded: rounding each axis independently drifts the box a pixel off the
  // one the full render settles into, which is a visible twitch on a photo.
  img.style.width = `${w * scale}px`;
  img.style.height = `${h * scale}px`;
}

function paint(img: HTMLImageElement, url: string, soft: boolean): void {
  if (img.getAttribute('src') !== url) img.src = url;
  if (soft) img.classList.add(...PREVIEW_CLASSES);
  else {
    img.classList.remove(...PREVIEW_CLASSES);
    img.style.width = '';
    img.style.height = '';
  }
}

/**
 * Show `full` in the lightbox `<img>`, going through `preview` while it loads.
 * Safe to call repeatedly (arrow navigation) — the newest call always wins.
 */
export function setLightboxImage(img: HTMLImageElement, opts: LightboxImageOptions): void {
  const frame = frameOf(img);
  const token = (pending.get(img)?.token ?? 0) + 1;
  const prevTimer = pending.get(img)?.timer;
  if (prevTimer) clearTimeout(prevTimer);
  const slot: Pending = { token, timer: null };
  pending.set(img, slot);

  if (opts.alt !== undefined) img.alt = opts.alt;

  const pre = new Image();
  pre.src = opts.full;

  // Already in the browser cache — a re-open, or the srcset variant the gallery
  // behind it happened to pick. Swap straight in: nothing to wait for, so
  // nothing should move.
  if (pre.complete && pre.naturalWidth > 0) {
    paint(img, opts.full, false);
    hideLoader(frame);
    opts.neighbours?.forEach(warmLightboxImage);
    return;
  }

  // Keep whatever is already showing when there's no preview (arrow navigation
  // holds the previous image rather than blanking).
  if (opts.preview && opts.preview !== opts.full) {
    paint(img, opts.preview, true);
    const fit = (): void => {
      if (pending.get(img)?.token === token) fitPreviewToFrame(img, frame);
    };
    if (img.complete && img.naturalWidth) fit();
    else img.addEventListener('load', fit, { once: true });
  }

  slot.timer = setTimeout(() => {
    if (pending.get(img)?.token === token) showLoader(frame);
  }, LOADER_DELAY_MS);

  const settle = (): void => {
    if (pending.get(img)?.token !== token) return; // superseded by a newer image
    if (slot.timer) clearTimeout(slot.timer);
    paint(img, opts.full, false);
    hideLoader(frame);
    opts.neighbours?.forEach(warmLightboxImage);
  };
  // `.catch(settle)` on purpose: a decode failure still swaps the src in so the
  // browser's own broken-image/alt handling takes over instead of a stuck blur.
  pre.decode().then(settle).catch(settle);
}

/** Close handler: drop the soft state and cancel anything still in flight. */
export function resetLightboxImage(img: HTMLImageElement | null): void {
  if (!img) return;
  const slot = pending.get(img);
  if (slot?.timer) clearTimeout(slot.timer);
  pending.set(img, { token: (slot?.token ?? 0) + 1, timer: null });
  img.classList.remove(...PREVIEW_CLASSES);
  img.style.width = '';
  img.style.height = '';
  hideLoader(frameOf(img));
}
