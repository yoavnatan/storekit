import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The settings title sits flush against the top of the sheet, like every other tab's.
 *
 * `dashboard.css` gets it there by removing the panel's top padding when the title is the first
 * thing in the panel, matched as `.dash-panel:has(> :first-child > .dash-panel-head:first-child)`.
 * The trap is that **a hidden input is still an element**: two of them parked above the head inside
 * the settings form made that selector miss, and the panel kept a band of white above its title on
 * that tab alone (owner, 2026-08-25: *"פתאום יש שם לבן מעל הכותרת, זה לא יושב טוב"*). Nothing in
 * the markup looked wrong, nothing failed, and the CSS comment beside the rule had already written
 * the miss down as intent.
 *
 * So the guard is on the SHAPE the CSS depends on, not on the two inputs that happened to break it:
 * whatever the settings form starts with must be the head. The next `<input type="hidden">`, Astro
 * fragment or wrapper someone adds at the top of that form fails here instead of shipping.
 */
describe('the settings panel title is flush with the top of the sheet', () => {
  const dashboard = readFileSync(new URL('../src/pages/seller/dashboard.astro', import.meta.url), 'utf8');

  /** The settings form, from its opening tag to the head that must follow it. */
  const afterFormOpen = (() => {
    const i = dashboard.indexOf('<form method="POST" action="/api/store"');
    expect(i).toBeGreaterThan(-1);
    return dashboard.slice(i);
  })();

  it('the first element inside the settings form is the panel head', () => {
    // Everything from the end of the <form ...> tag up to the head. Comments and whitespace are
    // fine — they are not elements and the selector does not see them.
    const bodyStart = afterFormOpen.indexOf('>') + 1;
    const headAt = afterFormOpen.indexOf('<div class="dash-panel-head');
    expect(headAt).toBeGreaterThan(-1);

    const before = afterFormOpen.slice(bodyStart, headAt)
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')   // Astro comment expressions
      .replace(/<!--[\s\S]*?-->/g, '');       // HTML comments

    // No tag of any kind may open before the head.
    expect(before).not.toMatch(/<[a-zA-Z]/);
  });

  it('the hidden inputs the form needs are still inside it', () => {
    // Moving them must not have dropped them: without `_action` the endpoint cannot route the save,
    // and without `storeId` it cannot resolve which shop is being written.
    const formEnd = afterFormOpen.indexOf('</form>');
    const form = afterFormOpen.slice(0, formEnd);
    expect(form).toContain('name="_action" value="save-settings"');
    expect(form).toContain('name="storeId"');
  });

  it('the CSS rule this depends on still exists in the shape the guard assumes', () => {
    // If the selector is ever rewritten, this test is measuring nothing and should be revisited
    // rather than left passing over a rule that no longer exists.
    const css = readFileSync(new URL('../src/styles/pages/dashboard.css', import.meta.url), 'utf8');
    expect(css).toContain(':has(> :first-child > .dash-panel-head:first-child)');
  });
});
