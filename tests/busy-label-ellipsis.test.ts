/**
 * A busy label never carries its own ellipsis, because it is always rendered NEXT TO one.
 *
 * The site has a single in-flight vocabulary: a word, then `.dot-pulse` — three animated dots.
 * Two labels also spelled the dots out, so the control read "טוען... •••" — six dots on one
 * button (owner, 2026-08-05: "יש שם כבר שלוש נקודות של הloader אז אין צורך בשלוש נקודות של
 * הטוען"). `savingShort` had always been right; `loadingMore` and `working` had not, which is
 * what makes this a rule worth pinning rather than two typos.
 *
 * Both halves are checked, because either alone rots: the translation strings must stay
 * ellipsis-free, and any label hard-coded straight into a dot-pulse template must too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ELLIPSIS = /(\.\.\.|…)\s*$/;

/** Keys whose value is rendered beside a `.dot-pulse`. Add one here when you add one there. */
const BUSY_KEYS = ['loadingMore', 'working', 'savingShort', 'uploading'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|astro)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('busy labels', () => {
  it('carry no ellipsis of their own in either language', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'i18n', 'translations.ts'), 'utf8');
    const offenders: string[] = [];
    for (const key of BUSY_KEYS) {
      for (const m of src.matchAll(new RegExp(`\\b${key}:\\s*'([^']*)'`, 'g'))) {
        if (ELLIPSIS.test(m[1]!)) offenders.push(`${key}: '${m[1]}'`);
      }
    }
    expect(
      offenders,
      'These render next to a .dot-pulse, which already IS the ellipsis — six dots on one control:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('are not spelled with an ellipsis inline at a dot-pulse call site either', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        // The real markup, not a mention of it — a comment explaining this very rule has to
        // be free to write "..." (this test's own subject matter is the string it forbids).
        const MARKUP = '<span class="dot-pulse"';
        if (!line.includes(MARKUP)) return;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        // The label sits immediately before the opening tag.
        const before = line.split(MARKUP)[0] ?? '';
        if (ELLIPSIS.test(before.replace(/["'`>]+$/, ''))) {
          offenders.push(`${file.slice(process.cwd().length + 1)}:${i + 1}`);
        }
      });
    }
    expect(offenders, `Drop the "..." — the dots next to it are animated:\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});
