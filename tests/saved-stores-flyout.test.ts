/**
 * The saved-stores flyout in the avatar menu — the four properties that make it a flyout rather
 * than the disclosure it used to be, each of which fails SILENTLY if it is undone.
 *
 * It was built as a disclosure inside the menu, on the reasoning (written into the markup) that a
 * flyout "has nowhere to go at 375px". Measured on 2026-08-05 that was wrong — the menu hugs the
 * header's inline-end edge and leaves ~180px of clear viewport on its inner side — while the cost
 * of the disclosure was real: it grew the menu by its own height, so a shopper with saved stores
 * could push the logout row off the bottom of a phone. Owner asked for the flyout.
 *
 * Nothing here can check what it LOOKS like; what it can check is that the mechanism which makes
 * it safe is still the one in the file. Measured live at 375/320/1280 wide and down to a 180px-tall
 * viewport, in Hebrew and English: the panel stayed fully on screen in every one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const header = readFileSync(join(process.cwd(), 'src/components/Header.astro'), 'utf8');
/** Comments quote the rules they explain — a guard that reads them proves nothing. */
const code = header.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');

/** The panel element's own tag, attributes and all. */
const panelTag = /<div\s[^>]*id="saved-stores-panel"[\s\S]*?>/.exec(code)?.[0] ?? '';

/** A top-level function in the header's module script, closing brace included. */
function body(name: string): string {
  return new RegExp(`function ${name}\\(\\)[\\s\\S]*?\\n {2}\\}`).exec(code)?.[0] ?? '';
}
const place = body('placeSavedPanel');

describe('saved-stores flyout', () => {
  it('is position:fixed — that is the whole reason it cannot grow the avatar menu', () => {
    // In flow (the old `mt-0.5 ps-[0.9rem]` disclosure) its height is the menu's height, and a
    // long saved list pushes the rows below it past the bottom of the screen. Fixed takes it out
    // of the menu's box entirely, so the menu is the same height open or closed.
    expect(panelTag, 'the panel element').not.toBe('');
    expect(panelTag).toMatch(/\bfixed\b/);
    expect(panelTag, 'an in-flow indent means it went back to being a disclosure').not.toMatch(/\bps-\[/);
  });

  it('clamps to the viewport on BOTH axes, and caps its own height', () => {
    // Three separate things, and dropping any one puts it off screen in a case the others miss:
    // max-height keeps a LONG panel inside the screen, the `top` clamp keeps a SHORT one from
    // being pushed past the bottom by a trigger sitting low, and the `left` clamp is what catches
    // a viewport too narrow to fit the panel beside the menu at all.
    expect(place, 'placeSavedPanel()').not.toBe('');
    expect(place, 'no height cap').toMatch(/style\.maxHeight\s*=/);
    expect(place, 'top is not clamped').toMatch(/style\.top[\s\S]*Math\.max[\s\S]*Math\.min/);
    expect(place, 'left is not clamped').toMatch(/style\.left[\s\S]*Math\.max[\s\S]*Math\.min/);
    // Against the viewport, never against the menu it hangs off.
    expect(place).toContain('documentElement.clientWidth');
    expect(place).toContain('documentElement.clientHeight');
  });

  it('measures itself with offsetWidth/Height, not a client rect', () => {
    // It is positioned in the same task it is unhidden in, so its open animation
    // (scale(0.96) translateY(-5px)) is on its first frame — getBoundingClientRect would report
    // the panel 4% smaller and 5px higher than it really is, and both clamps above would be
    // computed from that. The offset pair measures the layout box and ignores transforms.
    expect(place).toMatch(/savedPanel\.offsetWidth/);
    expect(place).toMatch(/savedPanel\.offsetHeight/);
    expect(place, 'the panel must not be measured through a transform').not.toMatch(/savedPanel\.getBoundingClientRect/);
  });

  it('re-measures after the rows land, not only when the row is clicked', () => {
    // The panel opens empty and is filled by a fetch. An empty panel and a six-store one are
    // different heights, and the second is the one that has to clear the bottom of the screen.
    expect(code).toMatch(/loadSavedStores\(\)\.then\(placeSavedPanel\)/);
  });

  it('is closed by the avatar menu closing', () => {
    // It is a fixed-position child, so the menu's fade carries it along visually and it looks
    // shut — but left flagged open it comes back already open, positioned against where the menu
    // used to be.
    const close = body('closeUserMenu');
    expect(close, 'closeUserMenu()').not.toBe('');
    expect(close).toContain('closeSavedPanel()');
  });

  it('the chevron is decided by the side the panel lands on, not by the language', () => {
    // An arrow names a direction ON SCREEN. The side is resolved at open time (whichever side of
    // the menu has room), so the rotation has to come from that same decision — memory
    // project_rtl_arrow_keys, one level up.
    expect(place).toMatch(/savedChev\?\.classList\.toggle\('rotate-180',\s*!toRight\)/);
  });
});
