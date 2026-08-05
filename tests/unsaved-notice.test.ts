// @vitest-environment jsdom
/**
 * "Did I save that?" — the on-screen answer, and the way back.
 *
 * Reported 2026-08-05: switching dashboard tabs after editing gave no sign at all that something was
 * pending. Nothing was ever LOST — panels are hidden, not destroyed, so every value is still sitting
 * in the form — but the only signal was `beforeunload`, which speaks once, at the very end, in the
 * browser's own words, about "changes" it cannot name.
 *
 * Three decisions the owner made while it was built, all pinned here because each is easy to undo by
 * accident:
 *  1. A dot on the tab was rejected — the messages tab already owns that corner dot for unread
 *     messages, and a seller who has never met an editor's unsaved-document convention cannot learn
 *     what a second one means. So the notice is a SENTENCE naming the section.
 *  2. It appears only for a section the seller CANNOT see. Standing in the panel, looking at the
 *     form and its save button, the bar would be telling them what is already in front of them.
 *  3. There is a way back: "discard changes" beside save, offered only while there is something to
 *     discard, and it returns the form to what was last SAVED — not to how the page loaded.
 *
 * And the mechanism the whole thing rests on: assigning `.value` fires NOTHING (no input, no change,
 * no attribute mutation), so a widget writing a hidden field is invisible unless it announces itself.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  announceValueChange,
  discardChanges,
  hasUnsavedChanges,
  initUnsavedGuard,
} from '../src/scripts/dashboard/unsaved-guard.js';

const bar = () => document.getElementById('dash-unsaved-bar')!;
const msg = () => document.getElementById('dash-unsaved-msg')!.textContent ?? '';
const shown = () => !bar().classList.contains('!hidden');
const discardBtn = () => document.getElementById('discard-btn') as HTMLButtonElement;
const setForm = () => document.getElementById('set-form') as HTMLFormElement;
const setPanel = (name: 'products' | 'settings') => {
  for (const p of document.querySelectorAll<HTMLElement>('.dash-panel')) p.hidden = p.id !== `dash-panel-${name}`;
  document.getElementById(`dash-panel-${name}`)!.dispatchEvent(new CustomEvent('dashtab:show', { bubbles: true }));
};

/** Two tabs, two panels, a guarded form in each — the shape the seller dashboard renders. */
function renderDashboard({ collapsed = false } = {}): void {
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
    <div id="dash-panel-settings" class="dash-panel" role="tabpanel" aria-labelledby="tab-settings" hidden>
      <div ${collapsed ? 'hidden' : ''}>
        <button type="button" form="set-form" data-discard id="discard-btn" disabled>בטל</button>
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

/** An edit in Settings while the seller is standing somewhere else. */
function editSettingsFromElsewhere(): void {
  touch('set-form');
  setHidden(A);
}

describe('the unsaved-changes notice', () => {
  beforeEach(() => {
    renderDashboard();
    initUnsavedGuard();
  });

  it('names the section the edit is actually in', () => {
    editSettingsFromElsewhere();
    expect(shown()).toBe(true);
    expect(msg()).toBe('יש שינויים שלא שמרת בהגדרות');
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('says nothing while the seller is standing IN that section', () => {
    setPanel('settings');
    editSettingsFromElsewhere();
    // The form and its save button are on screen; a bar naming this section would be telling them
    // what they are already looking at.
    expect(shown()).toBe(false);
    // …but the work IS unsaved, and `beforeunload` must still know that.
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('appears the moment the seller walks away, and clears when they walk back', () => {
    setPanel('settings');
    editSettingsFromElsewhere();
    expect(shown()).toBe(false);
    setPanel('products');        // a tab switch fires no input event — `dashtab:show` is the trigger
    expect(shown()).toBe(true);
    setPanel('settings');
    expect(shown()).toBe(false);
  });

  it('takes the section name from the tab, so it cannot drift from the tab', () => {
    document.getElementById('tab-settings')!.append('  (חנות)');
    editSettingsFromElsewhere();
    expect(msg()).toContain('(חנות)');
  });

  it('stops naming one section once two are out of sight and unsaved', () => {
    for (const p of document.querySelectorAll<HTMLElement>('.dash-panel')) p.hidden = true;
    editSettingsFromElsewhere();
    touch('prod-form');
    const sku = document.querySelector<HTMLInputElement>('[name="sku"]')!;
    sku.value = 'B2';
    sku.dispatchEvent(new Event('input', { bubbles: true }));
    expect(msg()).toBe('יש שינויים שלא שמרת ביותר ממקום אחד');
  });

  it('goes away when the value comes back to what it was', () => {
    editSettingsFromElsewhere();
    expect(shown()).toBe(true);
    setHidden('');
    // Diffing, not "an event fired": editing something and undoing it must leave nothing behind.
    expect(shown()).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('goes away on a successful save', () => {
    editSettingsFromElsewhere();
    window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form: setForm() } }));
    expect(shown()).toBe(false);
  });

  it('says nothing before the seller has touched the form', () => {
    // No baseline yet, so a value written at init — a widget rendering itself, a field being
    // normalised — cannot raise a notice the seller has no idea what to do with.
    setHidden(A);
    expect(shown()).toBe(false);
  });

  it('ignores a collapsed surface, whose edits are discarded anyway', () => {
    renderDashboard({ collapsed: true });
    initUnsavedGuard();
    editSettingsFromElsewhere();
    expect(shown()).toBe(false);
  });

  it('does not rewrite the live region when nothing changed', () => {
    editSettingsFromElsewhere();
    const before = msg();
    setHidden(A);
    // aria-live="polite" re-announces an identical sentence if it is re-assigned, so a no-op edit
    // must not touch it.
    expect(msg()).toBe(before);
  });

  it('sends the seller to the section and focuses the save button, without pressing it', () => {
    editSettingsFromElsewhere();
    let submitted = false;
    setForm().addEventListener('submit', () => { submitted = true; });
    // Stands in for DashTabsBoot's own delegated handler, panel switch included.
    document.getElementById('tab-settings')!.addEventListener('click', () => setPanel('settings'));
    document.getElementById('dash-unsaved-go')!.click();
    expect(document.activeElement).toBe(document.querySelector('#set-form [type="submit"]'));
    expect(submitted).toBe(false);
    // Having arrived, the notice has nothing left to tell them.
    expect(shown()).toBe(false);
  });
});

describe('the way back', () => {
  beforeEach(() => {
    renderDashboard();
    initUnsavedGuard();
  });

  it('offers itself only while there is something to discard', () => {
    expect(discardBtn().disabled).toBe(true);
    editSettingsFromElsewhere();
    expect(discardBtn().disabled).toBe(false);
    setHidden('');
    expect(discardBtn().disabled).toBe(true);
  });

  it('puts every field back, including the ones no widget re-renders', () => {
    editSettingsFromElsewhere();
    const name = document.querySelector<HTMLInputElement>('[name="name"]')!;
    name.value = 'Changed';
    discardChanges(setForm());
    expect(name.value).toBe('Bella');
    expect((document.getElementById('img') as HTMLInputElement).value).toBe('');
    expect(hasUnsavedChanges()).toBe(false);
    expect(shown()).toBe(false);
  });

  it('comes back to the last SAVE, not to how the page loaded', () => {
    // The trap this pins: `reset()` restores `defaultValue`, which is the server-rendered value. A
    // save that leaves the form on screen has to re-point those defaults, or "discard" silently
    // undoes work saved minutes ago — and the next save then writes the stale values back.
    const name = document.querySelector<HTMLInputElement>('[name="name"]')!;
    touch('set-form');
    name.value = 'Saved once';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form: setForm() } }));

    name.value = 'And then this';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    discardChanges(setForm());
    expect(name.value).toBe('Saved once');
  });

  it('tells the widgets that paint from a field to repaint', () => {
    editSettingsFromElsewhere();
    let repainted = 0;
    setForm().addEventListener('dash:fieldsrewritten', () => { repainted++; });
    discardChanges(setForm());
    // Fired AFTER the values are restored — the native `reset` event fires before, and a widget
    // reading the field there would repaint the value it is about to lose.
    expect(repainted).toBe(1);
  });

  it('says "thrown away on purpose" separately, so a stored draft can be deleted', () => {
    // Two statements, not one: FormFallbackGuard deletes its recovery draft on `dash:discarded`,
    // and it must NOT do that when the same rewrite is a draft being restored.
    editSettingsFromElsewhere();
    const seen: string[] = [];
    setForm().addEventListener('dash:fieldsrewritten', () => seen.push('rewritten'));
    setForm().addEventListener('dash:discarded', () => seen.push('discarded'));
    discardChanges(setForm());
    expect(seen).toEqual(['rewritten', 'discarded']);
  });
});

describe('announcing a programmatic value change stays in one place', () => {
  it('nothing hand-rolls the input event', () => {
    // The guard, not a style preference: six widgets write hidden fields, and the one that forgets
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
