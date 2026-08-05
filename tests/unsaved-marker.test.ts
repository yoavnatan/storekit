// @vitest-environment jsdom
/**
 * "Did I save that?" — the on-screen answer, and the reason it exists.
 *
 * Reported 2026-08-05: switching dashboard tabs after editing gave no sign at all that something
 * was pending. Nothing was ever LOST — panels are hidden, not destroyed, so every value is still
 * sitting in the form — but the only signal was `beforeunload`, which speaks once, at the very end,
 * in the browser's own words, about "changes" it cannot name. A warning about losing work is not an
 * answer to "is this saved".
 *
 * So the tab carries a dot while its panel holds unsaved work. What makes that fragile, and what
 * this file pins: the marker is only as honest as the events it hears. Assigning `.value` fires
 * NOTHING — no input, no change, no attribute mutation — so any widget writing a hidden field is
 * invisible unless it announces itself, and a dot that appears for the store image but not for the
 * category picker is worse than no dot at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { announceValueChange, hasUnsavedChanges, initUnsavedGuard } from '../src/scripts/dashboard/unsaved-guard.js';

const DOT = '.dash-tab-unsaved';

/** Two tabs, two panels, one guarded form — the shape the seller dashboard renders. */
function renderDashboard({ settingsHidden = false, collapsed = false } = {}): void {
  document.body.innerHTML = `
    <div class="dash-tabs" role="tablist">
      <button class="dash-tab" role="tab" id="tab-products"></button>
      <button class="dash-tab" role="tab" id="tab-settings"></button>
    </div>
    <div id="dash-panel-products" class="dash-panel" role="tabpanel" aria-labelledby="tab-products"></div>
    <div id="dash-panel-settings" class="dash-panel" role="tabpanel" aria-labelledby="tab-settings" ${settingsHidden ? 'hidden' : ''}>
      <div ${collapsed ? 'hidden' : ''}>
        <form data-unsaved-guard>
          <input name="name" value="Bella">
          <input type="hidden" name="profileImage" id="img" value="">
        </form>
      </div>
    </div>`;
}

/** The baseline is taken on first contact, exactly as a click on any widget button does it. */
function touch(): void {
  document.querySelector('form')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

function setHidden(value: string): void {
  const input = document.getElementById('img') as HTMLInputElement;
  input.value = value;
  announceValueChange(input);
}

describe('the unsaved-changes dot', () => {
  beforeEach(() => {
    renderDashboard();
    initUnsavedGuard();
  });

  it('appears on the tab whose panel holds the edit, and only that one', () => {
    touch();
    setHidden('https://res.cloudinary.com/demo/image/upload/v1/a.png');
    expect(document.querySelector('#tab-settings ' + DOT)).not.toBeNull();
    expect(document.querySelector('#tab-products ' + DOT)).toBeNull();
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('goes away when the value comes back to what it was', () => {
    touch();
    setHidden('https://res.cloudinary.com/demo/image/upload/v1/a.png');
    expect(document.querySelector(DOT)).not.toBeNull();
    setHidden('');
    // Diffing, not "an event fired": editing something and undoing it must leave nothing behind.
    expect(document.querySelector(DOT)).toBeNull();
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('goes away on a successful save', () => {
    touch();
    setHidden('https://res.cloudinary.com/demo/image/upload/v1/a.png');
    window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form: document.querySelector('form') } }));
    expect(document.querySelector(DOT)).toBeNull();
  });

  it('says nothing before the seller has touched the form', () => {
    // No baseline yet, so a value written at init — a widget rendering itself, a field being
    // normalised — cannot raise a dot the seller has no idea what to do with.
    setHidden('https://res.cloudinary.com/demo/image/upload/v1/a.png');
    expect(document.querySelector(DOT)).toBeNull();
  });

  it('keeps the dot while ANOTHER tab is open — that is the whole point', () => {
    touch();
    setHidden('https://res.cloudinary.com/demo/image/upload/v1/a.png');
    document.getElementById('dash-panel-settings')!.hidden = true;
    setHidden('https://res.cloudinary.com/demo/image/upload/v1/b.png');
    expect(document.querySelector('#tab-settings ' + DOT)).not.toBeNull();
  });

  it('ignores a collapsed surface, whose edits are discarded anyway', () => {
    document.body.innerHTML = '';
    renderDashboard({ collapsed: true });
    touch();
    setHidden('https://res.cloudinary.com/demo/image/upload/v1/a.png');
    expect(document.querySelector(DOT)).toBeNull();
  });

  it('carries a name a screen reader can read, since a dot is silent', () => {
    touch();
    setHidden('https://res.cloudinary.com/demo/image/upload/v1/a.png');
    expect(document.querySelector(DOT)!.textContent).toBeTruthy();
    expect(document.querySelector(DOT + ' .sr-only')).not.toBeNull();
  });

  it('does not rebuild the dot on a no-op edit', () => {
    touch();
    setHidden('https://res.cloudinary.com/demo/image/upload/v1/a.png');
    const first = document.querySelector(DOT);
    setHidden('https://res.cloudinary.com/demo/image/upload/v1/a.png');
    // A repaint that changes nothing must not touch the DOM — the same rule the rest of the
    // dashboard follows, and here it also keeps the element identity stable for assistive tech.
    expect(document.querySelector(DOT)).toBe(first);
  });
});

describe('announcing a programmatic value change stays in one place', () => {
  it('nothing hand-rolls the input event', () => {
    // The guard, not the style preference: five widgets write hidden fields, and the one that
    // forgets to announce is a marker that lies rather than an error anybody sees. `unsaved-guard`
    // owns the vocabulary so there is one thing to find and one thing to fix.
    const dir = join(process.cwd(), 'src/scripts');
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        if (entry.name === 'unsaved-guard.ts') continue;
        if (/dispatchEvent\(\s*new Event\(\s*['"]input['"]/.test(readFileSync(p, 'utf8'))) offenders.push(entry.name);
      }
    };
    walk(dir);
    expect(offenders, 'use announceValueChange() from unsaved-guard.ts').toEqual([]);
  });
});
