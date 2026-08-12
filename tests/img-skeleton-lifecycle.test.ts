// @vitest-environment jsdom
/**
 * The two ways the shimmer can LIE about what the browser is doing. Both were live on the store
 * page's "טען עוד" (owner, 2026-08-12: "it loads, but there are still images with a skeleton on
 * them"), and neither is visible by reading the markup — only by asking what state the <img> was
 * in at the moment the module looked at it.
 *
 * 1. A FAILED image shimmered forever. `complete` is true for a broken image too — the browser is
 *    finished with it — but the old test was `complete && naturalWidth > 0`, which a failure fails,
 *    so the module concluded "still in flight", attached load/error listeners to an image whose
 *    `error` had already fired, and nothing could ever remove the class again. Measured on
 *    /megamart with three product images made to fail: two tiles still animating over an empty box
 *    after six idle seconds.
 *
 * 2. A NOT-YET-REQUESTED image shimmered before anything was on the wire. The module starts the
 *    shimmer when a tile comes within SHIMMER_START_MARGIN, but `loading="lazy"` leaves the fetch
 *    on the browser's own schedule — a distance that moves with connection speed and is not this
 *    margin. Right after a "load more", four on-screen cards were animating with `currentSrc` still
 *    empty. The fix makes the claim true rather than guessing it: starting the shimmer also
 *    promotes the image to eager, so the two begin as one event.
 *
 * lib/img-skeleton.ts's header carries the rest of this module's history (why the shimmer is a
 * backdrop and never a cover). tests/skeleton-ssr-class.test.ts guards the markup side.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSkeletonOnLoad, initImageSkeletons, SKELETON_ATTR } from '../src/lib/img-skeleton.js';

/** Minimal IntersectionObserver that reports every observed element as intersecting on demand. */
class FakeIO {
  static readonly instances: FakeIO[] = [];
  targets: Element[] = [];
  constructor(private cb: IntersectionObserverCallback) { FakeIO.instances.push(this); }
  observe(el: Element): void { this.targets.push(el); }
  unobserve(el: Element): void { this.targets = this.targets.filter((t) => t !== el); }
  disconnect(): void { this.targets = []; }
  /** Fire the callback for everything currently observed, as the browser would on scroll. */
  intersectAll(): void {
    const entries = this.targets.map((target) => ({ target, isIntersecting: true } as IntersectionObserverEntry));
    this.cb(entries, this as unknown as IntersectionObserver);
  }
}

/** jsdom never loads images, so `complete`/`naturalWidth` are ours to state outright. */
function setImageState(img: HTMLImageElement, complete: boolean, naturalWidth: number): void {
  Object.defineProperty(img, 'complete', { value: complete, configurable: true });
  Object.defineProperty(img, 'naturalWidth', { value: naturalWidth, configurable: true });
}

function wrapWith(html: string): HTMLElement {
  document.body.innerHTML = `<div class="card-wrap" ${SKELETON_ATTR}>${html}</div>`;
  return document.querySelector<HTMLElement>('.card-wrap')!;
}

beforeEach(() => {
  FakeIO.instances.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeIO);
});

describe('clearSkeletonOnLoad', () => {
  it('settles a shimmer on an image that ALREADY failed, instead of waiting for an event that cannot come', () => {
    const wrap = wrapWith('<img src="https://example.test/gone.webp" />');
    const img = wrap.querySelector('img')!;
    setImageState(img, true, 0); // finished — and failed
    wrap.classList.add('is-loading');

    clearSkeletonOnLoad(img, '.card-wrap');

    expect(wrap.classList.contains('is-loading')).toBe(false);
  });

  it('still waits for a genuinely in-flight image', () => {
    const wrap = wrapWith('<img src="https://example.test/slow.webp" />');
    const img = wrap.querySelector('img')!;
    setImageState(img, false, 0);
    wrap.classList.add('is-loading');

    clearSkeletonOnLoad(img, '.card-wrap');
    expect(wrap.classList.contains('is-loading')).toBe(true);

    img.dispatchEvent(new Event('load'));
    expect(wrap.classList.contains('is-loading')).toBe(false);
  });
});

describe('initImageSkeletons', () => {
  it('never shimmers over an image the browser has already finished with — loaded OR failed', () => {
    for (const [complete, naturalWidth] of [[true, 400], [true, 0]] as const) {
      const wrap = wrapWith('<img src="https://example.test/x.webp" loading="lazy" />');
      setImageState(wrap.querySelector('img')!, complete, naturalWidth);

      initImageSkeletons('.card-wrap');
      FakeIO.instances.at(-1)!.intersectAll();

      expect(wrap.classList.contains('is-loading')).toBe(false);
    }
  });

  it('starts the fetch at the same moment as the shimmer, so the tile is never animating over nothing', () => {
    const wrap = wrapWith('<img src="https://example.test/x.webp" loading="lazy" />');
    const img = wrap.querySelector('img')!;
    setImageState(img, false, 0); // lazy, deferred — not requested yet

    initImageSkeletons('.card-wrap');
    expect(img.getAttribute('loading')).toBe('lazy'); // off-screen: nothing promoted, nothing shimmering
    expect(wrap.classList.contains('is-loading')).toBe(false);

    FakeIO.instances.at(-1)!.intersectAll();

    expect(wrap.classList.contains('is-loading')).toBe(true);
    expect(img.getAttribute('loading')).toBe('eager');
  });

  it('leaves an eager image\'s loading attribute alone', () => {
    const wrap = wrapWith('<img src="https://example.test/x.webp" loading="eager" />');
    setImageState(wrap.querySelector('img')!, false, 0);

    initImageSkeletons('.card-wrap');
    FakeIO.instances.at(-1)!.intersectAll();

    expect(wrap.querySelector('img')!.getAttribute('loading')).toBe('eager');
  });

  it('consumes the marker, so a second sweep cannot observe the same wrap twice', () => {
    const wrap = wrapWith('<img src="https://example.test/x.webp" loading="lazy" />');
    setImageState(wrap.querySelector('img')!, false, 0);

    initImageSkeletons('.card-wrap');
    expect(wrap.hasAttribute(SKELETON_ATTR)).toBe(false);

    initImageSkeletons('.card-wrap');
    expect(FakeIO.instances).toHaveLength(1);
  });
});
