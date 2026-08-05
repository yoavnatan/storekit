/**
 * The saved-stores flyout in the avatar menu — the properties that make it a flyout rather than
 * the disclosure it used to be, plus the two marks it must not go back to wearing. Every one of
 * them fails SILENTLY if it is undone: nothing throws, the menu just gets worse.
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

/** The saved-stores row itself. The inner `(?!<button)` matters: without it the match starts at
 *  whatever <button> came earlier in the header and swallows it. */
const rowTag = /<button(?:(?!<button)[\s\S])*?id="saved-stores-toggle"[\s\S]*?<\/button>/.exec(code)?.[0] ?? '';

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

  it('sits second in the menu, right under Home', () => {
    // Owner, 2026-08-05. The rows under it are places you go to deal with your own account; this
    // is the one that keeps a shopper shopping, so it goes above them.
    const menu = /<div class="user-dropdown"[\s\S]*?\n {10}<\/div>/.exec(code)?.[0] ?? '';
    expect(menu, 'the avatar menu').not.toBe('');
    const order = [...menu.matchAll(/href="\/"|id="saved-stores-toggle"|href="\/buyer\/dashboard"/g)].map((m) => m[0]);
    expect(order.slice(0, 3)).toEqual(['href="/"', 'id="saved-stores-toggle"', 'href="/buyer/dashboard"']);
  });

  it('is closed by the avatar menu closing', () => {
    // It is a fixed-position child, so the menu's fade carries it along visually and it looks
    // shut — but left flagged open it comes back already open, positioned against where the menu
    // used to be.
    const close = body('closeUserMenu');
    expect(close, 'closeUserMenu()').not.toBe('');
    expect(close).toContain('closeSavedPanel()');
  });

  it('carries no chevron — there is no side of the row it can point from', () => {
    // The row's trailing edge is the LEFT in Hebrew and the panel opens to the RIGHT, so wherever
    // a chevron sat it pointed back across its own label (owner, 2026-08-05). What says the row is
    // open is the row itself staying lit, the same tell `.user-btn[aria-expanded="true"]` uses.
    expect(rowTag, 'the saved-stores row').not.toBe('');
    expect(rowTag, 'a chevron came back').not.toMatch(/polyline/);
    expect(rowTag).toContain('aria-expanded:');
  });

  it('wears the STAR — the heart in this header means the product wishlist', () => {
    // The heart is the wishlist mark in six other files, one of them the wishlist button ~40px
    // away in this same header; a store is saved with the star on [storeSlug]/index.astro. The
    // row used the heart, which collided with one and contradicted the other.
    expect(rowTag, 'not the store-save star').toContain('12 2 15.09 8.26 22 9.27');
    expect(rowTag, 'the wishlist heart is back on the row').not.toMatch(/5\.5 5\.5 0 0 0-7\.[78]/);
  });

  it('has an empty state built from the site\'s own, not a bare line of text', () => {
    // HomeTabEmpty.astro is what the homepage's "liked" tab uses for exactly this: muted outline
    // mark, one line, one way out. A panel that answers "nothing here" with a grey sentence reads
    // as a list that failed to load.
    const empty = body('savedEmptyHtml');
    expect(empty, 'savedEmptyHtml()').not.toBe('');
    expect(empty, 'no mark').toContain('polygon');
    expect(empty, 'no way out of the empty state').toContain('href="/stores"');
    expect(empty).toContain('strSavedEmpty');
  });
});
