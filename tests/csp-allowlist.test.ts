/**
 * The security policy cannot be allowed to go stale, and a reminder is not a mechanism.
 *
 * The owner's requirement, verbatim (2026-08-17): *every session from now on must check whether the
 * policy needs updating or is still valid.* A note in a document would satisfy that for about a
 * week. What actually satisfies it is this file, because it runs inside `npm run verify` and
 * **fails the build** the moment browser-side code starts talking to an origin `lib/csp.ts` has
 * never heard of.
 *
 * The failure it is built to prevent is a specific and nasty one: a policy blocks a resource
 * SILENTLY, in a visitor's browser, on a page nobody is watching. Nothing throws here, nothing is
 * logged there, and the symptom is an image that does not appear or a payment frame that stays
 * blank — for that one visitor, on that one browser. So the check has to sit where the code is
 * written, not where the bug would surface.
 *
 * It scans by SHAPE rather than by a file list, for the same reason `money-guards` and
 * `image-optimization` do: a list is a thing a new file is not on.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_ORIGINS, contentSecurityPolicy } from '../src/lib/csp.js';

/**
 * Where BROWSER code lives. `src/lib` is deliberately excluded — it is mostly server modules, and
 * the origins they call (Resend, the Google APIs, Cloudflare) are not the browser's business and
 * must not be dragged into a page policy to make a test pass.
 */
const BROWSER_DIRS = ['src/scripts', 'src/workers', 'src/layouts', 'src/components', 'src/pages'];

/**
 * Origins that appear in browser-side source but that the browser never FETCHES. Each needs a
 * reason, and the reason is the point: an entry added without one is how an allowlist becomes a
 * place to silence this test.
 */
const NOT_FETCHED: Record<string, string> = {
  'https://schema.org': 'A JSON-LD @context value. It is an identifier in a document, never a request.',
};

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    // A `.ts` under `src/pages` is an ENDPOINT by Astro's routing convention — server code, whose
    // outbound calls (Google OAuth, the Merchant API) are the process's business and not the
    // page's. Pulling them in would push server origins into a browser policy, which is how an
    // allowlist stops meaning anything. Only the templates there render markup.
    else if (dir.startsWith('src/pages') ? path.endsWith('.astro') : /\.(ts|astro)$/.test(path)) out.push(path);
  }
  return out;
}

/** Every `https://host` literal in browser-side source, with the file it came from. */
function externalOriginsInSource(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of BROWSER_DIRS) {
    for (const file of walk(dir)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        // Comments are skipped, and the reason is that this file's whole value is its signal. Two
        // of the security comments in `src/pages` explain an attack using `https://evil.example`
        // as the example; listing that in an allowlist to keep the test quiet would teach the next
        // reader that the list is a place to put things you want ignored. It is the opposite.
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*') || code.startsWith('<!--')) continue;
        for (const match of line.matchAll(/https:\/\/[a-zA-Z0-9.-]+/g)) {
          const origin = match[0];
          if (!found.has(origin)) found.set(origin, []);
          const files = found.get(origin)!;
          if (!files.includes(file)) files.push(file);
        }
      }
    }
  }
  return found;
}

/** `https://*.example.com` covers `https://a.example.com`. Everything else is exact. */
function isAllowed(origin: string): boolean {
  return BROWSER_ORIGINS.some((allowed) => {
    if (allowed.origin === origin) return true;
    if (!allowed.origin.includes('*')) return false;
    const suffix = allowed.origin.replace('https://*', '');
    return origin.startsWith('https://') && origin.endsWith(suffix);
  });
}

describe('CSP allowlist', () => {
  it('covers every third party the browser-side code reaches', () => {
    const unlisted: string[] = [];
    for (const [origin, files] of externalOriginsInSource()) {
      if (isAllowed(origin) || origin in NOT_FETCHED) continue;
      unlisted.push(`${origin}  ← ${files.join(', ')}`);
    }
    expect(unlisted, [
      'A third-party origin appears in browser code but is not in the Content-Security-Policy.',
      'The browser will block it SILENTLY — no error here, no error there, just a resource that',
      'never arrives for a real visitor.',
      '',
      'Add it to BROWSER_ORIGINS in src/lib/csp.ts with the directive it needs and one line saying',
      'why, or — if the browser never actually fetches it — to NOT_FETCHED in this file, also with',
      'a reason. Do not widen a directive to make this pass.',
      '',
      ...unlisted,
    ].join('\n')).toEqual([]);
  });

  it('catches browser code that the policy would break even though it names no third party', () => {
    // The owner's second requirement (2026-08-17): a session must find out when the policy breaks
    // ITS OWN work, not only when it adds an unlisted origin. The origin scan above cannot see
    // that — code can be blocked without mentioning anybody.
    //
    // The reachable case here is `unsafe-eval`, which the policy deliberately does not grant.
    // `eval` and `new Function` are the two things that stop working, and they stop working ONLY
    // in the browser, ONLY at the moment that line runs — so a feature can be written, reviewed
    // and merged, and fail the first time a real visitor triggers it.
    const offenders: string[] = [];
    for (const dir of BROWSER_DIRS) {
      for (const file of walk(dir)) {
        for (const [n, line] of readFileSync(file, 'utf8').split('\n').entries()) {
          const code = line.trim();
          if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
          if (/\bnew Function\s*\(/.test(line) || /(^|[^\w.$])eval\s*\(/.test(line)) {
            offenders.push(`${file}:${n + 1}  ${code.slice(0, 80)}`);
          }
        }
      }
    }
    expect(offenders, [
      'Browser code uses eval() or new Function(), which the Content-Security-Policy blocks.',
      "It will throw in a visitor's browser and nowhere else — not here, not in a build.",
      'Rewrite it, or argue for `unsafe-eval` in src/lib/csp.ts and say what forced it.',
      '',
      ...offenders,
    ].join('\n')).toEqual([]);
  });

  it('emits every declared origin into the directive it asked for', () => {
    const policy = contentSecurityPolicy();
    for (const { origin, directives } of BROWSER_ORIGINS) {
      for (const directive of directives) {
        const section = policy.split('; ').find((d) => d.startsWith(`${directive} `));
        expect(section, `${directive} is missing from the policy entirely`).toBeDefined();
        expect(section, `${origin} is declared for ${directive} but does not appear in it`).toContain(origin);
      }
    }
  });

  it('requires a reason on every origin', () => {
    // An allowlist whose entries carry no reason cannot be pruned, so it only ever grows.
    for (const { origin, why } of BROWSER_ORIGINS) {
      expect(why.length, `${origin} has no reason`).toBeGreaterThan(20);
    }
  });

  it('keeps the directives that protect the page itself', () => {
    const policy = contentSecurityPolicy();
    // We are about to embed a third party. That says nothing about who may embed US, and the
    // clickjacking half is the one that gets forgotten.
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");   // an injected <base> re-points every relative URL
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("default-src 'self'");
  });

  it('lets the payment page be framed, because a blank iframe is a checkout that cannot take money', () => {
    const frameSrc = contentSecurityPolicy().split('; ').find((d) => d.startsWith('frame-src ')) ?? '';
    expect(frameSrc).toContain('https://pay.hyp.co.il');
  });

  it('does not let a font arrive from anywhere but us', () => {
    // Heebo is self-hosted and measured (AI_INSTRUCTIONS, Architecture). A font from a third party
    // would mean somebody added a stylesheet that quietly re-introduced the layout shift those
    // measurements exist to prevent.
    expect(contentSecurityPolicy()).toContain("font-src 'self'");
  });
});
