/**
 * The alert row's context line, and the two claims its old label made that stopped being true.
 *
 * `resolutionHint` used to hold one thing: a sentence suggesting what to do. On 2026-08-05 it
 * started also carrying the attempted cart from `/api/checkout` ("בעגלה: כיסא ×2"), which is not
 * advice, and the same day the critical-error mail began sending it — so a label reading
 * "הצעת פתרון (טרם נשלחת אוטומטית)" was wrong in both halves at once.
 *
 * Asserted against the component source because this is a wording contract between two surfaces
 * that a person compares by eye: the mail says "הקשר:" and the row must say the same word about the
 * same field. Nothing else can catch that — both render correctly while disagreeing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const panel = readFileSync(join(process.cwd(), 'src/components/admin/AdminAlertsPanel.astro'), 'utf8');
const copyText = readFileSync(join(process.cwd(), 'src/lib/error-reference.ts'), 'utf8');

describe('the context line in the Alerts tab', () => {
  it('is labelled with the same word the alert mail uses', () => {
    expect(panel).toContain('<strong>הקשר:</strong>');
    // The shared copy block — the text the mail sends and the row's copy button produces — uses the
    // same word, so the three places a person meets this field agree.
    expect(copyText).toContain('`הקשר: ');
  });

  // The two assertions below match the RENDERED label rather than the file, so the comment above it
  // stays free to quote the old wording — the history of why it changed is worth keeping next to it,
  // and a test that forbade naming the old string would forbid explaining the fix.
  it('no longer claims the field is only a suggested fix', () => {
    // It carries the attempted cart now. Calling that "הצעת פתרון" tells the reader to act on a
    // list of products.
    expect(panel).not.toContain('<strong>הצעת פתרון');
  });

  it('no longer claims the field is never sent anywhere', () => {
    // It is sent — that is the whole critical-error mail. A stale parenthetical is worse than no
    // parenthetical: it is a promise about behaviour, and it was false the moment the mail shipped.
    expect(panel).not.toContain('טרם נשלחת אוטומטית):</strong>');
  });

  it('opens the details row when the mail linked straight to one entry', () => {
    // Clicking an alert link and then being told to click again for the context is the same "here
    // is a code, now go find it" friction the deep link removed one step earlier.
    expect(panel).toContain('hidden={!entryRef}');
    expect(panel).toContain("aria-expanded={entryRef ? 'true' : 'false'}");
  });
});
