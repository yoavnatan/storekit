/**
 * Every call to a server that is not ours goes through `lib/outbound-fetch.ts`.
 *
 * **Why a guard rather than a code review.** The bug this prevents is invisible in the diff that
 * introduces it: `await fetch('https://provider/x')` looks complete and correct, and it behaves
 * perfectly for as long as the provider answers. It only misbehaves during the provider's outage —
 * where Node's `fetch` waits up to 300 seconds for headers, parking the buyer's request with it.
 * Nobody catches that in review, and nobody catches it in staging either, because you cannot
 * reproduce it without an unresponsive third party. So it is caught here, at the shape.
 *
 * **The rule:** a bare `fetch(` may not be handed an ABSOLUTE url. Same-origin calls (`fetch('/api/…')`
 * from a browser script) are untouched — those talk to this server, and this server is the thing
 * that would already be down.
 *
 * Sits alongside the other "one module owns this, and here is the test that says so" guards:
 * `lib/request-body.ts` (no bare `request.json()`), `lib/cdn.ts` (no raw image URLs),
 * `lib/safe-redirect.ts` (no raw redirect targets).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

/**
 * Two files, each for a stated reason — not a list anything may be added to quietly.
 *
 * `outbound-fetch.ts` IS the wrapper; a bare `fetch(` is the point of it.
 *
 * `dashboard/cloudinary.ts` is the seller's image upload, and it is the one third-party call that
 * runs in the BROWSER rather than on our server. Both halves of the reasoning matter. The failure
 * this guard exists to prevent — a hung provider parking a server request for undici's 300-second
 * headers timeout, consuming a slot the site needs — cannot happen there: no server request is
 * held, and the seller can cancel by navigating. And a deadline would actively hurt: the request
 * is a POST of up to 10MB, so its honest duration scales with the file and the seller's
 * connection, and any fixed number would abort real uploads on a bad mobile link while claiming to
 * protect them. `AbortSignal.timeout` bounds the whole request, not the idle time, which is the
 * wrong instrument for a body that large.
 *
 * A NEW third-party call from a browser script still fails this test, which is the intent — the
 * exemption is for this call, not for the directory.
 */
const EXEMPT = new Set(['src/lib/outbound-fetch.ts', 'src/scripts/dashboard/cloudinary.ts']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|astro)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Names of module-level `const X = 'https://…'` endpoints declared in this file, so
 * `fetch(ENDPOINT)` and `` fetch(`${API}/zones/…`) `` are recognised as absolute — which is how
 * every real call site in this codebase is written. A guard that only matched a literal
 * `fetch('https://…')` would have caught none of the four that existed when it was written.
 */
function absoluteUrlConsts(source: string): string[] {
  const names: string[] = [];
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*['"`]https?:\/\//g;
  for (const m of source.matchAll(re)) names.push(m[1]);
  return names;
}

/** The text of the first argument of a `fetch(` call, up to the first comma or closing paren at
 *  depth zero. Good enough for a shape check — this is not a parser and does not need to be. */
function firstArgument(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i).trim();
    } else if (ch === ',' && depth === 1) return source.slice(openParen + 1, i).trim();
  }
  return '';
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = file.slice(process.cwd().length + 1).replaceAll('\\', '/');
    if (EXEMPT.has(rel)) continue;
    const source = readFileSync(file, 'utf8');
    const endpointConsts = absoluteUrlConsts(source);

    // `\bfetch\(` and not `.fetch(`/`outboundFetch(` — a bare, global call only.
    for (const m of source.matchAll(/(^|[^.\w$])fetch\s*\(/g)) {
      const openParen = m.index! + m[0].length - 1;
      const arg = firstArgument(source, openParen);
      const isLiteralAbsolute = /^['"`]https?:\/\//.test(arg);
      const isConstEndpoint = endpointConsts.some(
        (name) => arg === name || arg.startsWith('`${' + name + '}') || arg.startsWith(name + ' +'),
      );
      if (isLiteralAbsolute || isConstEndpoint) {
        const line = source.slice(0, openParen).split('\n').length;
        found.push(`${rel}:${line} — fetch(${arg.slice(0, 60)})`);
      }
    }
  }
  return found;
}

describe('outbound fetch guard', () => {
  it('no source file calls a third party with a bare fetch()', () => {
    expect(offenders()).toEqual([]);
  });

  it('recognises the shapes the real call sites are written in', () => {
    // Guards fail silently when their pattern stops matching, and this one has to understand three
    // spellings before it is worth anything. Proven against the string, not against the tree.
    const sample = [
      "const API = 'https://api.cloudflare.com/client/v4';",
      "const ENDPOINT = 'https://api.resend.com/emails';",
      "await fetch(`${API}/zones/1/custom_hostnames`, { headers });",
      "await fetch(ENDPOINT, { method: 'POST' });",
      "await fetch('https://oauth2.googleapis.com/token', { method: 'POST' });",
      "await fetch('/api/cart/prices', { method: 'POST' });",
    ].join('\n');

    const endpointConsts = absoluteUrlConsts(sample);
    expect(endpointConsts).toEqual(['API', 'ENDPOINT']);

    const flagged: string[] = [];
    for (const m of sample.matchAll(/(^|[^.\w$])fetch\s*\(/g)) {
      const openParen = m.index! + m[0].length - 1;
      const arg = firstArgument(sample, openParen);
      const absolute =
        /^['"`]https?:\/\//.test(arg) ||
        endpointConsts.some((n) => arg === n || arg.startsWith('`${' + n + '}'));
      if (absolute) flagged.push(arg);
    }
    // The three third-party spellings, and NOT the same-origin one.
    expect(flagged).toHaveLength(3);
    expect(flagged.some((a) => a.includes('/api/cart/prices'))).toBe(false);
  });
});
