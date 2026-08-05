// @vitest-environment jsdom
/**
 * "Did I save that?" — the on-screen answer, and the reason it is a sentence.
 *
 * Reported 2026-08-05: switching dashboard tabs after editing gave no sign at all that something was
 * pending. Nothing was ever LOST — panels are hidden, not destroyed, so every value is still sitting
 * in the form — but the only signal was `beforeunload`, which speaks once, at the very end, in the
 * browser's own words, about "changes" it cannot name.
 *
 * A dot on the tab was built first and rejected by the owner: the site already uses that dot for
 * unread messages, so it read as "something is waiting for you", and a seller who has never met an
 * editor's unsaved-document convention has no way to learn what a second dot means. So the notice
 * names the section in words, and this file pins the two things that make it honest — that it names
 * the RIGHT section, and that it hears every way a value can change. Assigning `.value` fires
 * NOTHING (no input, no change, no attribute mutation), so a widget writing a hidden field is
 * invisible unless it announces itself; a notice that appears for the store image but not for the
 * category picker would be worse than none.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { announceValueChange, hasUnsavedChanges, initUnsavedGuard } from '../src/scripts/dashboard/unsaved-guard.js';

const bar = () => document.getElementById('dash-unsaved-bar')!;
const msg = () => document.getElementById('dash-unsaved-msg')!.textContent ?? '';
const shown = () => !bar().classList.contains('!hidden');

/** Two tabs, two panels, a guarded form in each — the shape the seller dashboard renders. */
function renderDashboard({ settingsHidden = false, collapsed = false } = {}): void {
  document.body.innerHTML = `
    <script type="application/json" id="i18n-data">${JSON.stringify({
      dashboard: {
        unsavedNotice: 'יש שינויים שלא שמרת ב{section}',
        unsavedNoticeMany: 'יש שינויים שלא שמרת ביותר ממקום אחד',
      },
    })}</script>
    <div class="dash-tabs" role="tablist">
      <button class="dash-tab" role="tab" id="tab-products"><svg></svg>מוצרים</button>
      <button class="dash-tab" role="tab" id="tab-settings"><svg></svg>הגדרות</button>
    </div>
    <div id="dash-panel-products" class="dash-panel" role="tabpanel" aria-labelledby="tab-products">
      <form data-unsaved-guard id="prod-form"><input name="sku" value="A1"></form>
    </div>
    <div id="dash-panel-settings" class="dash-panel" role="tabpanel" aria-labelledby="tab-settings" ${settingsHidden ? 'hidden' : ''}>
      <div ${collapsed ? 'hidden' : ''}>
        <form data-unsaved-guard id="set-form">
          <input name="name" value="Bella">
          <input type="hidden" name="profileImage" id="img" value="">
          <button type="submit">שמור</button>
        </form>
      </div>
    </div>
    <div id="dash-unsaved-bar" class="!hidden"><span id="dash-unsaved-msg"></span><button id="dash-unsaved-go"></button></div>`;
}

/** The baseline is taken on first contact, exactly as a click on any widget button does it. */
function touch(formId: string): void {
  document.getElementById(formId)!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

function setHidden(value: string): void {
  const input = document.getElementById('img') as HTMLInputElement;
  input.value = value;
  announceValueChange(input);
}

const A = 'https://res.cloudinary.com/demo/image/upload/v1/a.png';

describe('the unsaved-changes notice', () => {
  beforeEach(() => {
    renderDashboard();
    initUnsavedGuard();
  });

  it('names the section the edit is actually in', () => {
    touch('set-form');
    setHidden(A);
    expect(shown()).toBe(true);
    expect(msg()).toBe('יש שינויים שלא שמרת בהגדרות');
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('takes the section name from the tab, so it cannot drift from the tab', () => {
    document.getElementById('tab-settings')!.append('  (חנות)');
    touch('set-form');
    setHidden(A);
    expect(msg()).toContain('(חנות)');
  });

  it('stops naming one section once two are unsaved', () => {
    touch('set-form');
    setHidden(A);
    touch('prod-form');
    const sku = document.querySelector<HTMLInputElement>('[name="sku"]')!;
    sku.value = 'B2';
    sku.dispatchEvent(new Event('input', { bubbles: true }));
    expect(msg()).toBe('יש שינויים שלא שמרת ביותר ממקום אחד');
  });

  it('goes away when the value comes back to what it was', () => {
    touch('set-form');
    setHidden(A);
    expect(shown()).toBe(true);
    setHidden('');
    // Diffing, not "an event fired": editing something and undoing it must leave nothing behind.
    expect(shown()).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('goes away on a successful save', () => {
    touch('set-form');
    setHidden(A);
    window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form: document.getElementById('set-form') } }));
    expect(shown()).toBe(false);
  });

  it('says nothing before the seller has touched the form', () => {
    // No baseline yet, so a value written at init — a widget rendering itself, a field being
    // normalised — cannot raise a notice the seller has no idea what to do with.
    setHidden(A);
    expect(shown()).toBe(false);
  });

  it('stays up while ANOTHER tab is open — that is the whole point', () => {
    touch('set-form');
    setHidden(A);
    document.getElementById('dash-panel-settings')!.hidden = true;
    setHidden(A + '?2');
    expect(shown()).toBe(true);
    expect(msg()).toContain('הגדרות');
  });

  it('ignores a collapsed surface, whose edits are discarded anyway', () => {
    renderDashboard({ collapsed: true });
    initUnsavedGuard();
    touch('set-form');
    setHidden(A);
    expect(shown()).toBe(false);
  });

  it('does not rewrite the live region when nothing changed', () => {
    touch('set-form');
    setHidden(A);
    const before = msg();
    setHidden(A);
    // aria-live="polite" re-announces an identical sentence if it is re-assigned, so a no-op edit
    // must not touch it.
    expect(msg()).toBe(before);
  });

  it('sends the seller to the section and focuses the save button, without pressing it', () => {
    touch('set-form');
    setHidden(A);
    let switched = false;
    document.getElementById('tab-settings')!.addEventListener('click', () => { switched = true; });
    let submitted = false;
    document.getElementById('set-form')!.addEventListener('submit', () => { submitted = true; });
    document.getElementById('dash-unsaved-go')!.click();
    expect(switched).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('#set-form [type="submit"]'));
    expect(submitted).toBe(false);
  });
});

describe('announcing a programmatic value change stays in one place', () => {
  it('nothing hand-rolls the input event', () => {
    // The guard, not a style preference: five widgets write hidden fields, and the one that forgets
    // to announce is a notice that lies rather than an error anybody sees. `unsaved-guard` owns the
    // vocabulary so there is one thing to find and one thing to fix.
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        if (!entry.name.endsWith('.ts') || entry.name === 'unsaved-guard.ts') continue;
        if (/dispatchEvent\(\s*new Event\(\s*['"]input['"]/.test(readFileSync(p, 'utf8'))) offenders.push(entry.name);
      }
    };
    walk(join(process.cwd(), 'src/scripts'));
    expect(offenders, 'use announceValueChange() from unsaved-guard.ts').toEqual([]);
  });
});
