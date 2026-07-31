import { describe, expect, it } from 'vitest';
import { buildStoreLifecycleEmail, type LifecycleEmailInput } from '../src/lib/email/store-lifecycle-email.js';

/** These emails exist for one reason: every one of these states has a consequence the seller
 *  cannot see on the screen where they clicked. Two are sharp enough to pin line by line — the
 *  open-order obligation (a seller who asked to close is being told they still owe N buyers, and
 *  that the closure is waiting on exactly that) and the reopening warning (the storefront comes
 *  back, the ad campaigns deliberately do not). If either ever drops silently out of the copy the
 *  mail still sends and still looks fine, which is precisely why they are pinned here.
 */

const base = (over: Partial<LifecycleEmailInput> = {}): LifecycleEmailInput => ({
  to: 'seller@example.com',
  sellerName: 'דנה',
  store: { name: 'חנות הבית' },
  state: 'paused',
  openOrders: 0,
  ...over,
});

/** HTML and plain text both, always — a client that renders only the text part must not be the
 *  reason the obligation was never read. */
function bothParts(input: LifecycleEmailInput): string {
  const mail = buildStoreLifecycleEmail(input)!;
  return `${mail.html}\n${mail.text}`;
}

describe('what the email says', () => {
  it('names the store and the seller in every state', () => {
    for (const state of ['paused', 'closing', 'closed', 'active'] as const) {
      const mail = buildStoreLifecycleEmail(base({ state }))!;
      expect(mail.to).toBe('seller@example.com');
      expect(mail.subject).toContain('חנות הבית');
      expect(mail.html).toContain('דנה');
    }
  });

  it('spells out what pausing actually does — the part the button does not show', () => {
    const body = bothParts(base({ state: 'paused' }));
    expect(body).toContain('לא מקבלת הזמנות חדשות');
    expect(body).toContain('הוסרה מדף הבית');
    expect(body).toContain('קמפיינים');
    expect(body).toContain('שום נתון לא נמחק');
  });
});

describe('reopening', () => {
  // The reason this mail exists at all: reopening is NOT the mirror of pausing. The storefront
  // comes back by itself; the boost campaigns are deliberately left off until a human restarts
  // the spend (ad-campaign-health.ts). A seller who assumes otherwise loses days of advertising
  // with nothing on screen to tell them.
  it('warns that the campaigns did not come back with the store', () => {
    const body = bothParts(base({ state: 'active' }));
    expect(body).toContain('קמפיינים');
    expect(body).toContain('לא חוזרים לבד');
    expect(body).toContain('בלשונית הפרסום');
  });

  it('confirms the store itself is selling and listed again', () => {
    const body = bothParts(base({ state: 'active' }));
    expect(body).toContain('מקבלת הזמנות שוב');
    expect(body).toContain('לחיפוש');
  });

  // The halt bullets describe a store that STOPPED. Sending them on a reopen would say the
  // opposite of what just happened.
  it('never repeats the pause effects', () => {
    const body = bothParts(base({ state: 'active' }));
    expect(body).not.toContain('לא מקבלת הזמנות חדשות');
    expect(body).not.toContain('הוסרה מדף הבית');
  });
});

describe('the open-order obligation', () => {
  it('states the count and the duty when a closure is waiting on orders', () => {
    const body = bothParts(base({ state: 'closing', openOrders: 3 }));
    expect(body).toContain('3 הזמנות פתוחות');
    expect(body).toContain('חובה לסיים את הטיפול בהן');
    // …and that finishing them is all it takes — no second confirmation to come back for.
    expect(body).toContain('תיסגר לבד');
  });

  it('says the orders are unaffected when the seller only paused', () => {
    const body = bothParts(base({ state: 'paused', openOrders: 2 }));
    expect(body).toContain('2 הזמנות פתוחות');
    expect(body).toContain('באחריותך');
    // Pausing must never be described as something the seller has to finish orders BEFORE doing —
    // it is unconditional and immediate, and that is the whole difference from closing.
    expect(body).not.toContain('חובה לסיים את הטיפול בהן');
  });

  it('reads as one order, not "1 הזמנות", for a single one', () => {
    const mail = buildStoreLifecycleEmail(base({ state: 'closing', openOrders: 1 }))!;
    expect(mail.html).toContain('הזמנה פתוחה אחת');
    expect(mail.html).not.toContain('1 הזמנות');
  });

  // A seller with a clean slate must not be sent to go and handle nothing.
  it('says nothing about open orders when there are none', () => {
    const body = bothParts(base({ state: 'closing', openOrders: 0 }));
    expect(body).not.toContain('הזמנות פתוחות');
    expect(body).not.toContain('חובה לסיים');
  });

  it('never asks for order handling in the final closure mail — by then it is done', () => {
    const body = bothParts(base({ state: 'closed', openOrders: 0 }));
    expect(body).not.toContain('חובה לסיים');
    expect(body).toContain('נשמרו במלואם');
  });
});

// The bug this exists to prevent already happened: the closure mail's HTML said "ההזמנות
// וההכנסות נשמרו במלואם" and its plain-text part said nothing at all — the most reassuring line
// in the whole message, missing from what a text-only client shows. Every other test here
// searches the two bodies TOGETHER (bothParts), which is exactly why none of them saw it.
describe('the two bodies say the same things', () => {
  const states = ['paused', 'closing', 'closed', 'active'] as const;

  it.each(states)('carries every bullet of the %s mail into the plain-text part too', (state) => {
    const mail = buildStoreLifecycleEmail(base({ state, openOrders: 2 }))!;
    // Each bullet rendered in HTML must appear verbatim in the text body.
    const bulletsInHtml = [...mail.html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1]!);
    expect(bulletsInHtml.length).toBeGreaterThan(0);
    for (const bullet of bulletsInHtml) {
      // The HTML is escaped; the text is not. Compare on the escaped-free form.
      const plain = bullet.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      expect(mail.text).toContain(plain);
    }
  });

  it.each(states)('carries the closing note of the %s mail into both', (state) => {
    const mail = buildStoreLifecycleEmail(base({ state }))!;
    // The note is the last paragraph; take a distinctive run of it from the HTML and require it
    // in the text. Bold markers are HTML-only, so they are stripped before comparing.
    const paragraphs = [...mail.html.matchAll(/<p style="margin:0 0 12px;">(.*?)<\/p>/g)]
      .map((m) => m[1]!.replace(/<\/?strong>/g, ''));
    const note = paragraphs[paragraphs.length - 1]!;
    expect(note.length).toBeGreaterThan(20);
    expect(mail.text).toContain(note);
  });
});

describe('guards', () => {
  it('builds nothing without an address rather than sending into the void', () => {
    expect(buildStoreLifecycleEmail(base({ to: '' }))).toBeNull();
  });

  it('escapes a store name that contains markup', () => {
    const mail = buildStoreLifecycleEmail(base({ store: { name: '<script>x</script>' } }))!;
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });
});
