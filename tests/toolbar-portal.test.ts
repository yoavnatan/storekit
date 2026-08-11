// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { createFloatingPortal } from '../src/lib/toolbar-portal.js';

/**
 * One portal instance serves every dropdown in a toolbar — sort + filter on Orders and Sellers,
 * event-type + date window on the money journal — because each instance registers its own
 * document-level click/Escape/scroll listeners and a second set buys nothing for menus that can
 * never be open together.
 *
 * That sharing has one consequence worth a test: moving from one trigger to another never passes
 * through `close()`. The trigger's own click handler runs first and re-opens the portal, so by the
 * time the outside-click listener looks, the portal belongs to the new trigger and it correctly
 * leaves it alone. The state that used to be left behind was the OLD trigger's `aria-expanded`,
 * which is both what a screen reader is told and what the open styling hangs off — two lit pills
 * with one menu between them.
 */
let seq = 0;

function trigger(label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.setAttribute('aria-expanded', 'false');
  document.body.appendChild(btn);
  return btn;
}

const expanded = (el: HTMLElement) => el.getAttribute('aria-expanded');

describe('a portal shared by two triggers', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('hands aria-expanded from the old trigger to the new one', () => {
    const portal = createFloatingPortal(`test-portal-${seq++}`);
    const a = trigger('סוג אירוע');
    const b = trigger('תאריכים');

    portal.open(a, '10rem', () => '<button type="button">א</button>', () => {});
    expect(expanded(a)).toBe('true');
    expect(expanded(b)).toBe('false');

    // No close() in between — this is the exact sequence a click on the second pill produces.
    portal.open(b, '10rem', () => '<button type="button">ב</button>', () => {});
    expect(expanded(a)).toBe('false');
    expect(expanded(b)).toBe('true');
    expect(portal.currentTrigger()).toBe(b);

    portal.close();
    expect(expanded(b)).toBe('false');
    expect(portal.currentTrigger()).toBe(null);
  });

  it('leaves the trigger expanded when the same one re-opens', () => {
    const portal = createFloatingPortal(`test-portal-${seq++}`);
    const a = trigger('סוג אירוע');

    portal.open(a, '10rem', () => '', () => {});
    portal.open(a, '10rem', () => '', () => {});
    expect(expanded(a)).toBe('true');
    expect(portal.currentTrigger()).toBe(a);
  });
});
