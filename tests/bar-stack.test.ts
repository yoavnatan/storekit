// @vitest-environment jsdom
/**
 * The floating notices stack tight, and the bottom one sits on the bottom edge.
 *
 * Reported by the owner (סשן א׳ §3): *"יש פעמים שיש כמה הודעות אחת מעל השניה… ולפעמים הן מופיעות
 * עם רווח משמעותי אחת מהשניה… זה מאוד לא נוח ומפריע לעבודה."* Each bar used to place itself at a
 * RESERVED offset — bottom-6, bottom-[5.5rem], and bottom-6-or-9.5rem — which is only right when
 * every slot below it is filled. The draft bar stepping over both reserved slots while only the
 * lower one was showing is the gap he saw.
 *
 * So the offsets are computed from what is on screen. The three numbers this pins are the ones a
 * future bar would get wrong: the first visible bar is at the edge, the next starts where that one
 * ended, and a HIDDEN bar occupies nothing at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initDashBarStack, layoutDashBars } from '../src/scripts/dashboard/bar-stack.js';

const IDS = ['dash-unsaved-bar', 'dash-draft-bar', 'dash-stale-bar'];
const HEIGHT = 40;

const bar = (id: string): HTMLElement => document.getElementById(id)!;
const bottomOf = (id: string): string => bar(id).style.bottom;
const show = (id: string): void => bar(id).classList.remove('!hidden');
const hide = (id: string): void => bar(id).classList.add('!hidden');

beforeEach(() => {
  document.body.innerHTML = IDS.map((id) => `<div id="${id}" class="!hidden bottom-6"></div>`).join('');
  // jsdom lays nothing out, so every rect is 0×0 — and a stack of zero-height bars would pass any
  // assertion. Each bar is given the height a real one has.
  for (const id of IDS) {
    bar(id).getBoundingClientRect = () => ({ height: HEIGHT, width: 300, top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) });
  }
  initDashBarStack();
});

describe('the floating bars are packed, not slotted', () => {
  it('puts the only bar on screen at the bottom edge', () => {
    show('dash-draft-bar');
    layoutDashBars();
    expect(bottomOf('dash-draft-bar')).toBe('24px');
    // The two that are away claim no space and carry no offset of their own.
    expect(bottomOf('dash-unsaved-bar')).toBe('');
    expect(bottomOf('dash-stale-bar')).toBe('');
  });

  it('starts the second bar where the first one ended — no reserved gap in between', () => {
    show('dash-unsaved-bar');
    show('dash-draft-bar');
    layoutDashBars();
    expect(bottomOf('dash-unsaved-bar')).toBe('24px');
    expect(bottomOf('dash-draft-bar')).toBe(`${24 + HEIGHT + 12}px`);
  });

  it('closes the gap when a bar in the middle of the stack goes away', () => {
    // The exact shape of the complaint: the top bar had stepped over a slot that then emptied.
    show('dash-unsaved-bar');
    show('dash-draft-bar');
    show('dash-stale-bar');
    layoutDashBars();
    expect(bottomOf('dash-stale-bar')).toBe(`${24 + (HEIGHT + 12) * 2}px`);

    hide('dash-draft-bar');
    layoutDashBars();
    expect(bottomOf('dash-stale-bar')).toBe(`${24 + HEIGHT + 12}px`);
    expect(bottomOf('dash-draft-bar')).toBe('');
  });

  it('relays itself when a bar appears, without that bar having to say so', () => {
    // The three are raised by three unrelated owners, one of them outside the module graph, so the
    // stack observes the `!hidden` toggle rather than being notified.
    show('dash-unsaved-bar');
    layoutDashBars();
    show('dash-stale-bar');
    return Promise.resolve().then(() => {
      expect(bottomOf('dash-unsaved-bar')).toBe('24px');
      expect(bottomOf('dash-stale-bar')).toBe(`${24 + HEIGHT + 12}px`);
    });
  });
});
