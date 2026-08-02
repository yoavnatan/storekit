/**
 * @vitest-environment jsdom
 *
 * The onboarding checklist's "add your first product" row does two things: switch to the Products
 * tab, and open the add-product form that tab keeps collapsed. The second half is a string —
 * `data-goto-open="toggle-add-form"` — pointing at an id in another file, which is exactly the
 * kind of link that breaks silently. Renaming the toggle, or dropping `data-goto-open` from
 * initGotoPanelLinks(), leaves a seller on the right tab staring at a toolbar, with no error
 * anywhere. Both halves are pinned here: the behaviour against the shipped handler, and the ids
 * against the markup that has to contain them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initGotoPanelLinks } from '../src/scripts/dashboard/ui.js';

// From cwd, not import.meta.url — under jsdom that URL is an http: one and can't be resolved to a path.
const CHECKLIST = resolve(process.cwd(), 'src/components/dashboard/OnboardingChecklist.astro');
const DASHBOARD = resolve(process.cwd(), 'src/pages/seller/dashboard.astro');

describe('data-goto-open — the checklist opens the control, not just the tab', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button role="tab" data-panel="products" id="tab-products"></button>
      <button data-goto-panel="products" data-goto-open="toggle-add-form" id="step"></button>
      <button data-goto-panel="settings" id="plain-step"></button>
      <button id="toggle-add-form"></button>`;
  });

  it('clicks the named control after switching tabs', () => {
    const tab = vi.fn();
    const toggle = vi.fn();
    document.getElementById('tab-products')!.addEventListener('click', tab);
    document.getElementById('toggle-add-form')!.addEventListener('click', toggle);
    initGotoPanelLinks();

    document.getElementById('step')!.click();
    expect(tab).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('leaves a step with nothing to open exactly as it was — a tab switch and no more', () => {
    const toggle = vi.fn();
    document.getElementById('toggle-add-form')!.addEventListener('click', toggle);
    initGotoPanelLinks();

    document.getElementById('plain-step')!.click();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('does not throw when the named control is absent from the page', () => {
    document.getElementById('toggle-add-form')!.remove();
    initGotoPanelLinks();
    expect(() => document.getElementById('step')!.click()).not.toThrow();
  });
});

describe('the ids the markup points at still exist', () => {
  /** Every `data-goto-open="…"` value written anywhere in the two files that use it. */
  function targets(file: string): string[] {
    return [...readFileSync(file, 'utf8').matchAll(/data-goto-open="([^"]+)"/g)].map((m) => m[1]!);
  }

  it('the checklist names a control the dashboard actually renders', () => {
    const dashboard = readFileSync(DASHBOARD, 'utf8');
    const named = [...targets(CHECKLIST), ...targets(DASHBOARD)];
    // The checklist writes its value through STEP_OPENS, so it is the map that has to be read.
    const fromMap = [...readFileSync(CHECKLIST, 'utf8').matchAll(/product:\s*'([^']+)'/g)].map((m) => m[1]!);
    const all = [...new Set([...named, ...fromMap])];
    expect(all.length).toBeGreaterThan(0);
    for (const id of all) expect(dashboard).toContain(`id="${id}"`);
  });

  it('the empty-products block still carries a way into the form', () => {
    const dashboard = readFileSync(DASHBOARD, 'utf8');
    // `hidden` on this block is driven by products.ts#applyPagination, which finds it by id.
    expect(dashboard).toContain('id="empty-products"');
    expect(targets(DASHBOARD)).toContain('toggle-add-form');
  });
});
