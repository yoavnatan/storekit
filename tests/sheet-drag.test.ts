// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachSheetDrag } from '../src/lib/sheet-drag.js';

/** The subtle half of a drag-to-dismiss sheet is not the dragging — it is knowing whose gesture
 *  it is. A pull that starts inside a scrolled list belongs to the list; the same pull once the
 *  list is at its top belongs to the sheet. Get that wrong and either the sheet never opens to
 *  the gesture, or the cart becomes impossible to scroll. These pin the decision.
 */

let sheet: HTMLElement;
let content: HTMLElement;
let handle: HTMLElement;
let dismissed: number;

const SHEET_H = 400;

function touch(el: HTMLElement, type: string, clientY: number, at: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'touches', { value: [{ clientY }] });
  Object.defineProperty(ev, 'timeStamp', { value: at });
  el.dispatchEvent(ev);
  return ev;
}

/** One whole gesture, start → moves → release. Returns the last move event so a test can ask
 *  whether the sheet claimed it (preventDefault) or left it to the scroller. */
function drag(from: HTMLElement, ys: number[], step = 16): Event | null {
  touch(from, 'touchstart', ys[0]!, 0);
  let last: Event | null = null;
  ys.slice(1).forEach((y, i) => { last = touch(from, 'touchmove', y, (i + 1) * step); });
  touch(from, 'touchend', ys[ys.length - 1]!, ys.length * step);
  return last;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="sheet"><div id="handle"></div><div id="content"></div></div>';
  sheet = document.getElementById('sheet')!;
  content = document.getElementById('content')!;
  handle = document.getElementById('handle')!;
  vi.spyOn(sheet, 'offsetHeight', 'get').mockReturnValue(SHEET_H);
  dismissed = 0;
  attachSheetDrag({
    sheet,
    content,
    handles: [handle],
    enabled: () => true,
    onDismiss: () => { dismissed++; },
  });
});

describe('whose gesture is it', () => {
  it('leaves a drag that starts inside a scrolled list to the list', () => {
    content.scrollTop = 120;
    const last = drag(content, [200, 230, 260]);
    expect(last!.defaultPrevented).toBe(false);
    expect(sheet.style.transform).toBe('');
    expect(dismissed).toBe(0);
  });

  it('takes a downward drag once the list is at its top', () => {
    content.scrollTop = 0;
    const last = drag(content, [200, 230, 260]);
    expect(last!.defaultPrevented).toBe(true);
  });

  // Otherwise a pull upward from the top of the list would be swallowed by the sheet and the
  // shopper could never scroll back down through their own cart.
  it('leaves an upward drag from the list to the list, even at the top', () => {
    content.scrollTop = 0;
    const last = drag(content, [300, 270, 240]);
    expect(last!.defaultPrevented).toBe(false);
  });

  it('always takes a drag that starts on the handle', () => {
    content.scrollTop = 500;
    const last = drag(handle, [200, 230, 260]);
    expect(last!.defaultPrevented).toBe(true);
  });

  // Holding the decision is what keeps the sheet attached to the finger: a shopper who overshoots
  // and pulls back up mid-drag is still dragging the sheet, not scrolling the list.
  it('holds the decision for the rest of the gesture', () => {
    content.scrollTop = 0;
    touch(content, 'touchstart', 200, 0);
    touch(content, 'touchmove', 240, 16);
    const back = touch(content, 'touchmove', 210, 32);
    expect(back.defaultPrevented).toBe(true);
  });
});

describe('release', () => {
  it('snaps back after a short, slow pull', () => {
    // 40px of a 400px sheet, unhurried — under both thresholds.
    drag(content, [200, 220, 240], 200);
    expect(dismissed).toBe(0);
    expect(sheet.style.transform).toBe('');
  });

  it('dismisses once pulled past the distance threshold', () => {
    drag(content, [100, 200, 280], 200);
    expect(dismissed).toBe(1);
    expect(sheet.style.transform).toBe('translateY(100%)');
  });

  it('dismisses on a fast flick even from close to the top', () => {
    // ~2.5px/ms over the last stretch — well past the flick threshold, ~50px of travel.
    drag(handle, [200, 210, 250], 16);
    expect(dismissed).toBe(1);
  });

  it('does not dismiss when a drag never started', () => {
    drag(handle, [200, 202]);   // inside the direction slop — a tap, not a drag
    expect(dismissed).toBe(0);
    expect(sheet.style.transform).toBe('');
  });

  it('hands the backdrop back to CSS on release rather than leaving an inline opacity', () => {
    const seen: (number | null)[] = [];
    document.body.innerHTML = '<div id="s2"><div id="c2"></div></div>';
    const s2 = document.getElementById('s2')!;
    vi.spyOn(s2, 'offsetHeight', 'get').mockReturnValue(SHEET_H);
    attachSheetDrag({
      sheet: s2, content: document.getElementById('c2'), handles: [s2],
      enabled: () => true, onDismiss: () => {}, onProgress: (v) => { seen.push(v); },
    });
    drag(s2, [100, 200, 280], 200);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBeNull();
  });
});

describe('enabled()', () => {
  it('ignores the gesture entirely on the desktop layout', () => {
    document.body.innerHTML = '<div id="s3"><div id="c3"></div></div>';
    const s3 = document.getElementById('s3')!;
    vi.spyOn(s3, 'offsetHeight', 'get').mockReturnValue(SHEET_H);
    let closed = 0;
    attachSheetDrag({
      sheet: s3, content: document.getElementById('c3'), handles: [s3],
      enabled: () => false, onDismiss: () => { closed++; },
    });
    const last = drag(s3, [100, 200, 280]);
    expect(last!.defaultPrevented).toBe(false);
    expect(closed).toBe(0);
  });
});
