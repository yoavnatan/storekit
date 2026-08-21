/**
 * Performance invariants that hold for the whole tree, checked on every run.
 *
 * The owner asked (2026-08-21) that performance be checked every session rather than whenever
 * somebody thinks to look — "both during and at close, that we are not loading the servers or the
 * browser". A number measured once and written in a doc is not that: it is true on the afternoon
 * it was measured. These are the two costs that are *structural* — they follow from the shape of
 * the code, so a scan can hold them, and neither one is visible in any manual check because
 * nothing looks wrong on screen either way.
 *
 * ── 1. A poll must not run while nobody is looking ──────────────────────────────────────────
 *
 * Found by this scan on the day it was written: four network polls kept ticking in hidden tabs —
 * the site-wide notification poll (on EVERY page, so every visitor with a forgotten tab), the
 * seller's unread-messages poll, the new-orders poll and the header's notification poll. Browsers
 * throttle background timers to about once a minute rather than stopping them, so the cost is not
 * the 15s the code says: it is a request a minute, per open tab, per person, forever, for an
 * answer nobody can see. Two other modules had already solved it independently and differently,
 * which is why the fix is one helper (`lib/visible-poll.ts`) and this test points at it.
 *
 * ── 2. A scroll-blocking listener must say whether it blocks ────────────────────────────────
 *
 * `scroll` / `wheel` / `touchstart` / `touchmove` handlers run on the main thread, and a
 * non-passive one holds the compositor until it returns — it is the single most reliable way to
 * make a page feel like it is dragging. The tree is already 100% explicit here (30/30 at the time
 * of writing) and that is worth keeping rather than rediscovering: `{ passive: false }` is a
 * legitimate answer when a handler genuinely takes the gesture over (`ui.ts`'s tab strip does,
 * and bails immediately when there is nothing to scroll) — what is not legitimate is silence,
 * because the default differs per event type and per browser, so silence means nobody decided.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = 'src';

/** Event types whose listeners can hold up scrolling. */
const BLOCKING_EVENTS = ['scroll', 'wheel', 'touchstart', 'touchmove', 'mousewheel'];

/** The helper every repeating network poll goes through. */
const POLL_HELPER = 'pollWhileVisible';

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) srcFiles(full, out);
    else if (/\.(ts|astro)$/.test(full)) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * From an index at (or before) a `(`, return the source through its matching `)`.
 * Quote-aware, so a paren inside a string literal cannot end the call early.
 */
function callText(src: string, from: number): string | null {
  const open = src.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

const lineOf = (src: string, index: number): number => src.slice(0, index).split('\n').length;

describe('a repeating poll does not run in a hidden tab', () => {
  it('every setInterval that fetches goes through pollWhileVisible', () => {
    const offenders: string[] = [];
    for (const file of srcFiles(SRC)) {
      // The helper is where the bare timer is allowed to live.
      if (file.endsWith(path.join('lib', 'visible-poll.ts'))) continue;
      const raw = readFileSync(file, 'utf8');
      const code = stripComments(raw);
      for (const m of code.matchAll(/setInterval\s*\(/g)) {
        const call = callText(code, m.index!);
        if (!call) continue;
        // Only network polls are in scope. A setInterval driving a countdown, a clock or an
        // animation costs the server nothing, and stopping it while hidden is a different
        // decision with different UI consequences.
        // `setInterval(name, ms)` — find what `name` does; `setInterval(() => …)` carries its own.
        const fnName = /^\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(call)?.[1];
        const declared = fnName ? code.search(new RegExp(`function\\s+${fnName}\\s*\\(`)) : -1;
        // The opening of the polled function: enough to see a `fetch` and, crucially, enough to
        // see a guard AT THE TOP, which is the only place a hidden-tab check belongs. Deliberately
        // not the whole file — "this file mentions document.hidden somewhere" would let any module
        // that gates one poll leave a second one ungated, which is how the four found today got in.
        const opening = declared >= 0 ? code.slice(declared, declared + 400) : call;
        if (!/\bfetch\s*\(/.test(opening) && !/\bfetch\s*\(/.test(call)) continue;
        // A hand-written `if (document.hidden) return` is the same guarantee, and is:inline blocks
        // cannot import — BaseLayout's site-wide poll is one.
        if (/document\.hidden/.test(opening)) continue;
        offenders.push(`${file}:${lineOf(code, m.index!)}`);
      }
    }
    expect(
      offenders,
      `These poll the network on a timer that keeps running while the tab is hidden. Use
${POLL_HELPER}() from src/lib/visible-poll.ts, or guard the polled function with
\`if (document.hidden) return;\` where an is:inline block cannot import:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('a scroll-blocking listener declares whether it blocks', () => {
  it('every scroll/wheel/touch listener passes an explicit passive option', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of srcFiles(SRC)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const m of code.matchAll(/addEventListener\s*\(\s*(['"])([a-z]+)\1/g)) {
        if (!BLOCKING_EVENTS.includes(m[2]!)) continue;
        checked++;
        const call = callText(code, m.index!);
        // Unparseable means a template literal or nesting this scanner cannot follow. Report it
        // rather than pass it: an unreadable call is exactly where the silent default hides.
        if (!call) { offenders.push(`${file}:${lineOf(code, m.index!)} ${m[2]} (could not parse)`); continue; }
        if (!/passive\s*:/.test(call)) offenders.push(`${file}:${lineOf(code, m.index!)} ${m[2]}`);
      }
    }
    // If this drops to nothing the scan has stopped scanning — a rename or a move, not a cleanup.
    expect(checked, 'no scroll-blocking listeners found at all — the scan is broken').toBeGreaterThan(20);
    expect(
      offenders,
      `Pass { passive: true } (or { passive: false } if the handler really takes the gesture over).
The default differs by event type and by browser, so leaving it out is not a decision:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
