import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two settings that make "live on the real domain, weeks before launch" safe.
 *
 * Every test here is about the state on the day the domain first resolves — which is a state
 * nobody will be in twice, and which no other test in this suite reaches: the whole suite runs with
 * `import.meta.env.PROD === false`, so the branch that closes the shop in production is one nothing
 * else can execute. That is exactly why it needs its own file.
 *
 * The property under test is not "the flag works". It is:
 *   • selling is refused by DEFAULT in production while payments are a mock — with nothing set,
 *     nobody having remembered anything, and no flag involved;
 *   • the override that reopens it is explicit and exact, so it cannot be tripped by a stray value;
 *   • wiring a real provider opens the shop with no configuration change at all.
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  delete process.env.SITE_NOINDEX;
  delete process.env.ALLOW_MOCK_CHECKOUT;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllEnvs();
});

/** Fresh import each time — `import.meta.env.PROD` is read at call time, but the module caches
 *  nothing else, and resetting keeps one test's stubs out of the next one's. */
async function load() {
  return import('../src/lib/site-mode.js');
}

describe('selling, in development', () => {
  it('is open — the mock provider is the point here, and no stranger can reach it', async () => {
    const { checkoutIsOpen, checkoutClosedReason } = await load();
    expect(checkoutIsOpen()).toBe(true);
    expect(checkoutClosedReason()).toBeNull();
  });
});

describe('selling, in production', () => {
  beforeEach(() => vi.stubEnv('PROD', true));

  it('is CLOSED by default while payments are a mock — nothing set, nobody remembering', async () => {
    const { checkoutIsOpen, checkoutClosedReason } = await load();
    expect(checkoutIsOpen()).toBe(false);
    // A reason, not a boolean: three surfaces have to say something true to a person.
    expect(checkoutClosedReason()).toBe('mock-payments');
  });

  it('reopens only for the exact override', async () => {
    process.env.ALLOW_MOCK_CHECKOUT = '1';
    const { checkoutIsOpen } = await load();
    expect(checkoutIsOpen()).toBe(true);
  });

  it('does not reopen for a value that merely looks affirmative', async () => {
    for (const value of ['true', 'yes', 'on', '0', '', ' 1']) {
      vi.resetModules();
      process.env.ALLOW_MOCK_CHECKOUT = value;
      const { checkoutIsOpen } = await load();
      expect(checkoutIsOpen(), `ALLOW_MOCK_CHECKOUT=${JSON.stringify(value)}`).toBe(false);
    }
  });

  /**
   * The property the whole design rests on: the answer comes from the provider OBJECT, so wiring
   * a real gateway opens the shop with no setting touched. If this ever becomes a string or flag
   * comparison, the shop stops opening by itself and someone has to remember — which is the failure
   * the file exists to prevent.
   */
  it('is derived from the provider itself, so a real gateway opens the shop with no config change', async () => {
    const { paymentsAreMock } = await load();
    expect(paymentsAreMock()).toBe(true);

    vi.doMock('../src/lib/payment.js', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/payment.js')>('../src/lib/payment.js');
      return { ...actual, paymentProvider: { async authorize() { return { ok: true }; } } };
    });
    vi.resetModules();
    const real = await load();
    expect(real.paymentsAreMock()).toBe(false);
    expect(real.checkoutIsOpen()).toBe(true);
    vi.doUnmock('../src/lib/payment.js');
  });
});

describe('the closed gate covers the whole class, not one route', () => {
  /**
   * `/api/checkout` is gated, and that is only enough while it is the ONLY way an order comes into
   * existence. A second one — a no-JS form fallback, an admin "create order", a carrier callback —
   * would be open on a server whose whole point is that it cannot sell yet, and it would look
   * completely reasonable in its own diff. (This repo has already shipped exactly that shape once:
   * the dashboard's no-JS fallback POSTs authorized nothing while their `/api/*` twins did.)
   *
   * So the rule is pinned by scan rather than by memory: whoever writes an order or reaches the
   * payment provider must also ask whether the platform is open.
   */
  it('every order-creating and money-taking route asks whether the shop is open', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const offenders = walk(join('src', 'pages'))
      .filter((f) => /\.(ts|astro)$/.test(f))
      .filter((f) => {
        const src = code(readFileSync(f, 'utf8'));
        const sells = /createOrder\(|paymentProvider\.(authorize|capture)\(/.test(src);
        return sells && !src.includes('checkoutClosedReason');
      });
    expect(offenders).toEqual([]);
  });
});

describe('hiding from search', () => {
  it('is off unless explicitly set', async () => {
    const { siteIsHiddenFromSearch } = await load();
    expect(siteIsHiddenFromSearch()).toBe(false);
  });

  it('is on for exactly "1"', async () => {
    process.env.SITE_NOINDEX = '1';
    const { siteIsHiddenFromSearch } = await load();
    expect(siteIsHiddenFromSearch()).toBe(true);
  });

  it('stays off for a value that merely looks affirmative', async () => {
    for (const value of ['true', 'yes', 'on', '0', '']) {
      vi.resetModules();
      process.env.SITE_NOINDEX = value;
      const { siteIsHiddenFromSearch } = await load();
      expect(siteIsHiddenFromSearch(), `SITE_NOINDEX=${JSON.stringify(value)}`).toBe(false);
    }
  });

  /**
   * Read through `serverEnv`, not `import.meta.env`. The difference is not style: `import.meta.env`
   * is frozen at BUILD time, so a switch read from it needs a rebuild and a redeploy to move — and
   * this one has to be flippable on the host, on the day the site is ready, in one line.
   */
  it('is a runtime setting, not a build-time one', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/lib/site-mode.ts', 'utf8'));
    const noindexFn = src.slice(src.indexOf('export function siteIsHiddenFromSearch'));
    expect(noindexFn).toContain('serverEnv(');
    expect(noindexFn).not.toContain('import.meta.env');
  });
});
