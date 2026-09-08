/**
 * @vitest-environment jsdom
 *
 * Taking a deleted list item OFF THE SCREEN — the half the owner actually saw go wrong.
 *
 * Emptying the string made the words disappear and left everything else: the `<li>`, its marker, its
 * spacing (2026-09-08: *"אם אני מוחק שורה או בולט — המקום שלו עדיין נשאר שם, הבולט עצמו נשאר, פשוט
 * ריק"*). The dictionary side of that is fixed in the route, which removes the item from the array
 * rather than blanking it; this is the other side, the open page that is not reloading.
 *
 * A separate file because it needs a DOM and `tests/dev-copy-editor.test.ts` is a node-environment
 * suite reading source text.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { removeOnScreen } from '../src/scripts/dev/copy-editor.js';

const html = (markup: string): void => {
  document.body.innerHTML = markup;
};

describe('removing a deleted line from the open page', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('takes the whole bullet, not just its words', () => {
    html('<ul><li>ראשון</li><li>שני</li><li>שלישי</li></ul>');
    expect(removeOnScreen('שני')).toBe(1);
    expect(document.querySelectorAll('li')).toHaveLength(2);
    expect(document.body.textContent).toBe('ראשוןשלישי');
  });

  it('climbs to the outermost element that holds nothing else', () => {
    // The words are wrapped, and the wrapper is what carries the bullet's padding — stopping at the
    // <span> would leave exactly the empty row this exists to remove.
    html('<ul><li class="row"><span>שני</span></li><li>שלישי</li></ul>');
    expect(removeOnScreen('שני')).toBe(1);
    expect(document.querySelector('.row')).toBeNull();
    expect(document.querySelectorAll('li')).toHaveLength(1);
  });

  it('stops before an ancestor that also holds a sibling', () => {
    // The <ul> would match on a one-item list; removing it would take the list itself. The climb
    // must stop at the item, and here the sibling proves it never went past.
    html('<ul><li>שני</li><li>שלישי</li></ul>');
    removeOnScreen('שני');
    expect(document.querySelector('ul')).not.toBeNull();
    expect(document.querySelector('ul')?.textContent).toBe('שלישי');
  });

  it('matches on the text as it is RENDERED, across the wrapping the browser added', () => {
    html('<ul><li>\n   שני\n   שורות\n  </li></ul>');
    expect(removeOnScreen('שני שורות')).toBe(1);
    expect(document.querySelectorAll('li')).toHaveLength(0);
  });

  it('leaves a paragraph that merely CONTAINS the words', () => {
    // Only an element whose ENTIRE text is the string is the string's own element. A sentence that
    // quotes it is somebody else's content and removing it would delete a paragraph nobody touched.
    html('<p>לפני שני אחרי</p>');
    expect(removeOnScreen('שני')).toBe(0);
    expect(document.querySelector('p')).not.toBeNull();
  });

  it('removes every place the line was showing, not just the first', () => {
    html('<ul><li>שני</li></ul><ul><li>שני</li></ul>');
    expect(removeOnScreen('שני')).toBe(2);
    expect(document.querySelectorAll('li')).toHaveLength(0);
  });

  it('does nothing for an empty string, so a blank save cannot strip the page', () => {
    html('<ul><li>ראשון</li></ul>');
    expect(removeOnScreen('   ')).toBe(0);
    expect(document.querySelectorAll('li')).toHaveLength(1);
  });

  it('never removes body, whatever the page looks like', () => {
    // A document whose entire text is the removed string: the climb has to stop, or the page goes.
    html('שני');
    removeOnScreen('שני');
    expect(document.body).not.toBeNull();
  });
});
