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
 * **Scope: `src/scripts/` — the client-script tree.** `.astro` component scripts are not walked
 * here; their failures are covered by the surfaces above and by review. Widening this is a fine
 * thing to do, but it must not be done by widening the marker instead.
 *
 * fileURLToPath, not `.pathname` — this repo's own directory name is Hebrew and `.pathname` hands
 * back the percent-encoded form, which `readdirSync` cannot open.
 */
const SCRIPTS = fileURLToPath(new URL('../src/scripts/', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
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
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
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
    found.push({ file, line: start + 1, snippet: lines[start].trim().slice(0, 100) });
  });
  return found;
}

describe('a failed request is never silent by accident', () => {
  const files = walk(SCRIPTS);

  it('the scan can see the tree it is scanning', () => {
    // A guard that matches nothing passes for the wrong reason. There are dozens of client scripts
    // and most of the dashboard's fetching lives in them.
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((f) => readFileSync(f, 'utf8').includes('fetch(')).length).toBeGreaterThan(10);
  });

  it('every catch around a fetch either reports the failure or says why it does not', () => {
    const all = files.flatMap(offences).map((o) => `${o.file.slice(SCRIPTS.length)}:${o.line}  ${o.snippet}`);
    expect(all).toEqual([]);
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
