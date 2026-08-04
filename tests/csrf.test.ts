// The signed-token layer against cross-site request forgery (src/lib/csrf.ts), plus the two guards
// that keep it from rotting the way every other call-site rule in this repo has:
//
//   1. the check stays in the middleware and nowhere else, and
//   2. a `<form method="POST">` either posts by AJAX or carries the hidden field.
//
// One test here is not about our code at all — it pins `request.clone()`'s tee against the real
// runtime. The middleware reads a form body looking for the token, and the route that runs
// afterwards reads the SAME request's body again. If cloning ever stopped tee-ing, every native
// form POST on the site would arrive empty with nothing in the diff to explain it.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AstroCookies } from 'astro';
import {
  CSRF_FIELD, CSRF_HEADER, csrfRejection, csrfRequired, csrfTokenFromRequest, issueCsrfToken,
  verifyCsrfToken,
} from '../src/lib/csrf.js';

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));

/** Minimal stand-in for AstroCookies — the same shape tests/admin-auth.test.ts uses. */
function fakeCookies(initial: Record<string, string> = {}) {
  const jar = new Map(Object.entries(initial));
  return {
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  } as unknown as AstroCookies;
}

/** A signed seller session cookie, minted the way seller-auth.ts mints one, so the binding under
 *  test is the real thing rather than a string we chose. */
async function sellerCookies(sellerId: string) {
  const { setSellerSession } = await import('../src/lib/seller-auth.js');
  const cookies = fakeCookies();
  setSellerSession(cookies, sellerId);
  return cookies;
}

function formRequest(body: string, extra: HeadersInit = {}): Request {
  return new Request('https://example.test/seller/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra },
    body,
  });
}

describe('minting and verifying a token', () => {
  it('accepts a token it issued for the same caller', () => {
    const cookies = fakeCookies();
    expect(verifyCsrfToken(issueCsrfToken(cookies), cookies)).toBe(true);
  });

  it('rejects nothing at all', () => {
    const cookies = fakeCookies();
    expect(verifyCsrfToken(null, cookies)).toBe(false);
    expect(verifyCsrfToken(undefined, cookies)).toBe(false);
    expect(verifyCsrfToken('', cookies)).toBe(false);
  });

  it('rejects a forged or edited token', () => {
    const cookies = fakeCookies();
    const token = issueCsrfToken(cookies);
    expect(verifyCsrfToken(`${token}x`, cookies)).toBe(false);
    expect(verifyCsrfToken(token.replace('|', '!'), cookies)).toBe(false);
    // The payload swapped for another binding, keeping a signature that was valid for the old one.
    const sig = token.slice(token.lastIndexOf('.'));
    expect(verifyCsrfToken(`s:someone-else|9999999999${sig}`, cookies)).toBe(false);
    expect(verifyCsrfToken('no-signature-at-all', cookies)).toBe(false);
  });

  it('rejects an expired token', () => {
    // Reaching past the public surface on purpose: expiry is a property of the payload, and the
    // only other way to observe it is to wait 180 days.
    const cookies = fakeCookies();
    const token = issueCsrfToken(cookies);
    const expired = token.replace(/\|\d+\./, '|1000000000.');
    expect(verifyCsrfToken(expired, cookies)).toBe(false);
  });

  it('BINDS the token to the session, so one minted elsewhere cannot be replayed', async () => {
    // The whole point of the layer. An unbound token would only prove the sender had visited the
    // site once, which an attacker can do for themselves.
    const attacker = await sellerCookies('11111111-1111-4111-8111-111111111111');
    const victim = await sellerCookies('22222222-2222-4222-8222-222222222222');
    const stolen = issueCsrfToken(attacker);

    expect(verifyCsrfToken(stolen, attacker)).toBe(true);
    expect(verifyCsrfToken(stolen, victim)).toBe(false);
    // And an anonymous token is not usable against a signed-in seller either.
    expect(verifyCsrfToken(issueCsrfToken(fakeCookies()), victim)).toBe(false);
  });

  it('stops honouring a token after the session it was bound to ends', async () => {
    const cookies = await sellerCookies('33333333-3333-4333-8333-333333333333');
    const token = issueCsrfToken(cookies);
    const { clearSellerSession } = await import('../src/lib/seller-auth.js');
    clearSellerSession(cookies);
    expect(verifyCsrfToken(token, cookies)).toBe(false);
  });
});

describe('which requests have to prove themselves', () => {
  it('lets the safe methods through — they must not change state', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
      expect(csrfRequired(method, '/api/store')).toBe(false);
    }
  });

  it('demands a token from every state-changing method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(csrfRequired(method, '/api/store')).toBe(true);
    }
  });

  it('covers page routes, not just /api', () => {
    // /seller/logout is a page-level endpoint, and a forged logout is still a forged request.
    expect(csrfRequired('POST', '/seller/logout')).toBe(true);
    expect(csrfRequired('POST', '/seller/login')).toBe(true);
  });
});

describe('finding the token on a request', () => {
  it('reads the header', async () => {
    const request = new Request('https://example.test/api/store', {
      method: 'POST',
      headers: { [CSRF_HEADER]: 'tok-123' },
    });
    expect(await csrfTokenFromRequest(request)).toBe('tok-123');
  });

  it('reads the hidden field out of a form-encoded body', async () => {
    const body = new URLSearchParams({ email: 'a@b.com', [CSRF_FIELD]: 'tok-form' }).toString();
    expect(await csrfTokenFromRequest(formRequest(body))).toBe('tok-form');
  });

  it('leaves the body readable for the route that runs next', async () => {
    // The clone/tee guarantee the middleware depends on, asserted against the real runtime.
    const body = new URLSearchParams({ email: 'a@b.com', [CSRF_FIELD]: 'tok-form' }).toString();
    const request = formRequest(body);
    await csrfTokenFromRequest(request);
    const form = await request.formData();
    expect(form.get('email')).toBe('a@b.com');
  });

  it('refuses to buffer a body that claims to be huge', async () => {
    const body = new URLSearchParams({ [CSRF_FIELD]: 'tok-form' }).toString();
    const request = formRequest(body, { 'content-length': '5000000' });
    expect(await csrfTokenFromRequest(request)).toBe(null);
  });

  it('refuses one that declares NO length and then keeps sending, without hanging', async () => {
    // Two holes in one case. A chunked body declares nothing, so a content-length check passes it
    // and only the read itself can stop it — that is why the clone goes through request-body.ts
    // rather than `clone.formData()`. And giving up must not `cancel()` the reader: on a tee'd
    // branch that promise never settles while the other branch is live, so the middleware would
    // hang holding the request open. This test times out if either regresses.
    const chunk = new TextEncoder().encode('x'.repeat(8192));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 200_000) { controller.close(); return; }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = new Request('https://example.test/api/store', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: stream,
      // @ts-expect-error — undici requires this for a streaming body; it is not in the DOM lib types.
      duplex: 'half',
    });
    expect(await csrfTokenFromRequest(request)).toBe(null);
    expect(sent).toBeLessThan(200_000);
  });

  it('does not read a multipart body — those are uploads, and they carry the header', async () => {
    const form = new FormData();
    form.set(CSRF_FIELD, 'tok-multipart');
    const request = new Request('https://example.test/api/store', { method: 'POST', body: form });
    expect(await csrfTokenFromRequest(request)).toBe(null);
  });

  it('returns null rather than throwing on a body that is not what it claims', async () => {
    const request = new Request('https://example.test/api/store', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '%%%not-form-encoded%%%',
    });
    expect(await csrfTokenFromRequest(request)).not.toBe('anything-usable');
  });
});

describe('the rejection', () => {
  it('is a 403 and says why', async () => {
    const response = csrfRejection();
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/csrf/i);
  });
});

/** Every .ts/.astro file under src/, so a new one is covered without editing this test. */
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) srcFiles(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.astro')) out.push(full);
  }
  return out;
}

describe('the gate stays in one place', () => {
  it('is enforced by the middleware', () => {
    const middleware = readFileSync(path.join(SRC_ROOT, 'middleware.ts'), 'utf8');
    expect(middleware).toContain('csrfRequired');
    expect(middleware).toContain('verifyCsrfToken');
    expect(middleware).toContain('csrfRejection');
  });

  it('is not re-implemented inside a route', () => {
    // A per-route copy is how safe-redirect and secret-compare each ended up missing from one
    // call site. The verifier belongs to the middleware; a route importing it means the rule has
    // started to spread.
    const offenders = srcFiles(path.join(SRC_ROOT, 'pages'))
      .filter((file) => /\bverifyCsrfToken\b|\bcsrfRequired\b/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps Astro origin checking pinned on, since it is the layer underneath', () => {
    const config = readFileSync(fileURLToPath(new URL('../astro.config.mjs', import.meta.url)), 'utf8');
    expect(config).toMatch(/security:\s*\{\s*checkOrigin:\s*true\s*\}/);
  });

  it('serves the token from BaseLayout and attaches it before any other module runs', () => {
    const layout = readFileSync(path.join(SRC_ROOT, 'layouts', 'BaseLayout.astro'), 'utf8');
    expect(layout).toContain('issueCsrfToken');

    // The ordering IS the mechanism, so it is what gets asserted rather than the mere presence of
    // the import. Bundled `<script>` tags are deferred modules executed in document order, so the
    // wrapper only covers cart-sync and the error reporter — both of which fetch on load — if it
    // is the first of them. dashboard/tab-sync.ts wraps fetch too, as a pure observer; that
    // composes correctly precisely because it initialises later and therefore captures the
    // already-wrapped function. Move this line and that stops being true.
    const bundled = [...layout.matchAll(/<script>\s*import\s[^<]*<\/script>/g)].map((m) => m[0]);
    expect(bundled[0]).toContain('csrf-client');
  });

  it('names the header and the meta tag in exactly one place', () => {
    // The two ends run in different runtimes and cannot import each other — lib/csrf.ts pulls in
    // node:crypto and the database pool — so these strings were written out twice, once per side.
    // A rename on the server would then have turned every mutating request into a silent 403.
    const client = readFileSync(path.join(SRC_ROOT, 'scripts', 'csrf-client.ts'), 'utf8');
    expect(client).toContain("from '../lib/csrf-names.js'");
    expect(client).not.toMatch(/['"`]x-csrf-token['"`]|['"`]X-CSRF-Token['"`]/i);
    expect(client).not.toMatch(/meta\[name="csrf-token"\]/);

    // And nothing else may re-type them either.
    const offenders = srcFiles(SRC_ROOT)
      .filter((file) => !file.endsWith(path.join('lib', 'csrf-names.ts')))
      .filter((file) => /['"`](?:x-csrf-token|_csrf)['"`]/i.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('is never written into a saved draft', () => {
    // FormFallbackGuard snapshots a blocked form into localStorage and offers it back on the next
    // load. A token is a credential, not typing worth preserving — and a draft written before a
    // sign-in carries a token bound to the OTHER identity, so restoring it over the fresh one the
    // server just rendered turns a recovered form into a 403 nobody can explain.
    const guard = readFileSync(path.join(SRC_ROOT, 'components', 'dashboard', 'FormFallbackGuard.astro'), 'utf8');
    expect(guard).toMatch(/SKIP_NAME\s*=\s*\{\s*_csrf:\s*1\s*\}/);
    // Both halves — the write and the restore — must consult it.
    expect(guard.match(/SKIP_NAME\[el\.name\]/g) ?? []).toHaveLength(2);
  });

  it('has no request-sending path that cannot carry a header', () => {
    // sendBeacon cannot set one, so a beacon would need an exemption from the check — a hole
    // opened for convenience on the endpoint easiest to forget about. `fetch(…, {keepalive:true})`
    // survives page teardown just as well and carries the token.
    const offenders = srcFiles(SRC_ROOT)
      .filter((file) => /navigator\.sendBeacon/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });
});

describe('every native form POST carries the field', () => {
  it('leaves no POST form that is neither AJAX nor token-bearing', () => {
    // The rule: a `<form method="POST">` either has `data-unsaved-guard` (dashboard AJAX — the
    // fetch wrapper covers it) or it renders <CsrfField />. Anything else posts to us with no
    // token and gets a 403 that reads as "the button is broken".
    const offenders: string[] = [];
    for (const file of srcFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8');
      const forms = source.match(/<form\b[^>]*>/gi) ?? [];
      for (const tag of forms) {
        if (!/method=["']post["']/i.test(tag)) continue;
        if (/data-unsaved-guard/.test(tag)) continue;
        if (source.includes('<CsrfField')) continue;
        offenders.push(`${path.relative(SRC_ROOT, file)}: ${tag}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
