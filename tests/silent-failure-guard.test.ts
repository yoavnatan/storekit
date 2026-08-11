import { describe, expect, it } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A request that fails must either SAY SO or say why it doesn't have to.
 *
 * The 2026-08-10 audit walked every `fetch` in the app. Sixteen call sites already handled failure
 * well; eleven did not, and they were not eleven oversights but one habit — `catch { /* ignore *&#47; }`
 * or `if (!res.ok) return`, written while getting the happy path right and never revisited. From
 * the user's side each one is the same event: a reply that never sent, an order status that never
 * saved, a note that vanished, a filter that changed nothing, a list that came back empty and
 * claimed the shelf was bare. The button re-enables, the screen looks idle and correct, and the
 * person carries on believing it worked.
 *
 * **Silence is sometimes right, and this test does not ban it.** A background poll, a telemetry
 * beacon, a prefetch, an enrichment that leaves the previous answer standing — none of those has a
 * person waiting on it, and a toast for one is noise that teaches people to ignore toasts. What
 * this bans is silence that was never DECIDED. A `catch` around a `fetch` that says nothing to the
 * user must carry the marker `silent:` and a reason, on the catch or just above it.
 *
 * That is the same shape as the CSS-conversion rule's "say so in the session summary when you skip
 * one": the exemption is free, hiding it is not.
 *
 * **Scope: every file that ships JS to a browser.** `src/scripts/**` is the client-script tree;
 * `.astro` files under components/pages/layouts carry client `<script>` blocks and a great deal of
 * this app's fetching lives in them — the header's polls, the store grid, checkout, the buyer
 * dashboard. The first version of this test covered only `src/scripts/` and said so in this header,
 * which is precisely the shape of exemption that rots: the owner asked "is there anywhere else",
 * and the answer was the half the test had excused itself from. Only the FRONTMATTER of a `.astro`
 * file is skipped, because that is server code and its failures are the API layer's business.
 *
 * fileURLToPath, not `.pathname` — this repo's own directory name is Hebrew and `.pathname` hands
 * back the percent-encoded form, which `readdirSync` cannot open.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const CLIENT_ROOTS = ['scripts', 'components', 'pages', 'layouts'].map((d) => join(SRC, d));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') || name.endsWith('.astro')) out.push(p);
  }
  return out;
}

/** The half of a file that runs in the browser. For `.ts` that is all of it; for `.astro` it is
 *  everything after the frontmatter fence, since the frontmatter runs on the server. Returned with
 *  the line offset so a reported line number still points at the real file. */
function clientHalf(file: string): { lines: string[]; offset: number } {
  const text = readFileSync(file, 'utf8');
  if (!file.endsWith('.astro')) return { lines: text.split('\n'), offset: 0 };
  const first = text.indexOf('---');
  const end = first === 0 ? text.indexOf('\n---', 3) : -1;
  if (end < 0) return { lines: text.split('\n'), offset: 0 };
  return { lines: text.slice(end).split('\n'), offset: text.slice(0, end).split('\n').length - 1 };
}

/** Anything that puts the failure in front of a person, or hands it to someone who will. */
const SPEAKS = /showActionFailedToast|showErrorToast|showToast|showStatus|toastError|reportClientError|\bthrow\b|innerHTML|textContent|\.hidden\s*=|classList\.(remove|add)|location\.href|fail\(|paint\(/;

/** The deliberate-silence marker. `silent:` and then a reason, in a comment. */
const MARKER = /silent:/i;

interface Offence { file: string; line: number; snippet: string }

/**
 * Every `catch` that (a) sits inside a function whose body also calls `fetch(`, and (b) neither
 * speaks nor is marked. The enclosing-function test is what keeps this off the `getI18n()`
 * `JSON.parse` catches that open half these files — those are in functions that fetch nothing.
 */
function offences(file: string): Offence[] {
  const { lines, offset } = clientHalf(file);
  const found: Offence[] = [];

  lines.forEach((line, i) => {
    if (!/\bcatch\s*(\([^)]*\))?\s*\{/.test(line)) return;
    // The catch body: from the brace that OPENS it to the matching close, capped so a malformed
    // file cannot walk the whole document. Counting must start at that brace and not at the start
    // of the line — `} catch {` closes the `try` first, and a naive counter reads that as the
    // block already being balanced, cuts the body off at line one, and then reports every
    // multi-line catch on the file as silent. (It did exactly that on first run.)
    const start = i;
    const openAt = lines[i].indexOf('{', lines[i].indexOf('catch'));
    let depth = 0;
    let end = i;
    for (let k = i; k < Math.min(lines.length, i + 40); k++) {
      const from = k === i ? openAt : 0;
      for (const ch of lines[k].slice(from)) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      end = k;
      if (depth <= 0) break;
    }
    const body = lines.slice(start, end + 1).join('\n');
    if (SPEAKS.test(body)) return;
    // The marker may sit in the catch or in the comment lines immediately above the `try`/`catch`.
    const context = lines.slice(Math.max(0, start - 6), end + 1).join('\n');
    if (MARKER.test(context)) return;
    // Does the enclosing scope actually make a request? Looking back to the nearest `function`,
    // arrow-function opener or `try`, and forward to the catch — a request in the same breath.
    const before = lines.slice(Math.max(0, start - 60), start).join('\n');
    const scope = before.slice(before.lastIndexOf('function ') >= 0 ? before.lastIndexOf('function ') : 0);
    if (!/fetch\s*\(/.test(scope)) return;
    found.push({ file, line: offset + start + 1, snippet: lines[start].trim().slice(0, 100) });
  });
  return found;
}

describe('a failed request is never silent by accident', () => {
  const files = CLIENT_ROOTS.flatMap((d) => walk(d));

  it('the scan can see the tree it is scanning', () => {
    // A guard that matches nothing passes for the wrong reason. Both halves have to be in view:
    // the client-script tree AND the .astro files that carry their own <script> blocks.
    const fetching = files.filter((f) => readFileSync(f, 'utf8').includes('fetch('));
    expect(files.length).toBeGreaterThan(60);
    expect(fetching.filter((f) => f.endsWith('.ts')).length).toBeGreaterThan(10);
    expect(fetching.filter((f) => f.endsWith('.astro')).length).toBeGreaterThan(3);
  });

  it('every catch around a fetch either reports the failure or says why it does not', () => {
    const all = files.flatMap(offences).map((o) => `${o.file.slice(SRC.length)}:${o.line}  ${o.snippet}`);
    expect(all).toEqual([]);
  });

  it('a confirmed action that throws is reported, not swallowed by the dialog closing', () => {
    /*
     * `ConfirmModal.astro` is the funnel every destructive action on this site goes through —
     * delete a product, delete a category, delete a coupon, cancel an order, close a store, clear
     * the alert log, delete a campaign. It ran `try { await action() } finally { …close() }` with
     * NO catch, so an `onConfirm` whose fetch was dropped closed the dialog and restored the
     * button exactly as a success does. The action had not happened; the only trace was an
     * unhandled rejection. That is the worst shape a failure can take, because the user has
     * already decided and therefore does not check.
     *
     * Asserted on the source rather than driven in jsdom: the component's script is a bundled
     * Astro island with no import surface, and what has to hold is one structural fact.
     */
    const modal = readFileSync(fileURLToPath(new URL('../src/components/ConfirmModal.astro', import.meta.url)), 'utf8');
    const block = modal.slice(modal.indexOf('await action()'));
    // The tokens `} catch {` / `} finally {`, not the bare words: the catch's own comment
    // explains what the missing `finally`-only version used to do, and matching the word found
    // that sentence instead of the clause.
    const catchIdx = block.indexOf('} catch {');
    const finallyIdx = block.indexOf('} finally {');
    expect(catchIdx, 'ConfirmModal must catch a throwing onConfirm').toBeGreaterThan(-1);
    expect(catchIdx, 'the catch must come before the finally that closes the dialog').toBeLessThan(finallyIdx);
    expect(block.slice(catchIdx, finallyIdx)).toMatch(/showActionFailedToast/);
  });

  it('the one wording for a failed action lives in one place', () => {
    // Six surfaces had each hand-written their own Hebrew sentence for the same event before the
    // audit. New code reaches for the shared one; the remaining literals are older, more specific
    // messages that say more than "that didn't go through" and are left alone deliberately.
    const toast = readFileSync(fileURLToPath(new URL('../src/lib/toast.ts', import.meta.url)), 'utf8');
    expect(toast).toMatch(/export function showActionFailedToast/);
    // It must read its copy from the i18n island, not carry an English literal that would appear
    // inside a Hebrew UI (tests/i18n-island-scope.test.ts is the same class).
    expect(toast).toMatch(/i18n-data/);
  });
});
