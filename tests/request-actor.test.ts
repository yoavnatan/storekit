import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRequestActor } from '../src/lib/request-actor.js';

/**
 * "Who was this request, and which store was it about" — one answer, one module.
 *
 * The rule existed twice: `error-log.ts` resolved it for the automatic error list, and the visitor
 * reports resolved it again for the list that renders directly ABOVE that one on the admin's Alerts
 * tab. Both were correct on the day they were written, which is exactly the shape this repo has
 * been bitten by before (`safe-redirect`, `email-address`, `secret-compare`): a rule in two modules
 * is right until one of them learns something.
 *
 * The tree scan below is the durable half — the behaviour cases only pin what the module does
 * today, while the grep is what stops a third copy from being written next month.
 */

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('nothing hand-rolls the actor rule', () => {
  it('leaves "a seller is an account that owns a store" to lib/request-actor.ts', () => {
    // The discriminator is the CONCLUSION, not the queries: plenty of modules legitimately call
    // `getStoreBySellerId`, and only this rule turns its result into a person's role.
    const offenders = walk('src')
      .filter((f) => /\.(ts|astro)$/.test(f))
      .filter((f) => !f.endsWith(join('lib', 'request-actor.ts')))
      .filter((f) => /\?\s*'seller'\s*:\s*'buyer'|\?\s*"seller"\s*:\s*"buyer"/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps the two readers pointed at it', () => {
    // Named explicitly, because the grep above passes just as happily for a file that stopped
    // resolving an actor at all — which would be a silently unattributed admin list, not a fix.
    for (const reader of [join('src', 'lib', 'error-log.ts'), join('src', 'lib', 'user-reports.ts')]) {
      expect(readFileSync(reader, 'utf8'), `${reader} no longer uses the shared resolver`)
        .toContain('resolveRequestActor');
    }
  });
});

const noCookies = { get: () => undefined } as never;

describe('what it resolves from a path', () => {
  it('finds nothing on a route that is not a store, and does not throw on one that is empty', async () => {
    expect(await resolveRequestActor('/checkout', noCookies)).toEqual({});
    expect(await resolveRequestActor('', noCookies)).toEqual({});
    expect(await resolveRequestActor('/', noCookies)).toEqual({});
  });

  it('leaves the role unset for a visitor with no session', async () => {
    // The absence is the point: "we could not tell" and "nobody was signed in" are the same
    // observation from here, and `user-reports.ts` is what turns that into `guest`.
    const actor = await resolveRequestActor('/search?q=נעליים', noCookies);
    expect(actor.actorRole).toBeUndefined();
    expect(actor.actorId).toBeUndefined();
  });

  it('reads a percent-encoded Hebrew slug back as the slug it is', async () => {
    // Slugs carry Hebrew (url-base.ts) and a path that has been through `safeRedirectPath` arrives
    // encoded — so without the decode, every report filed from a Hebrew store page would lose the
    // one attribution that matters most.
    const encoded = `/${encodeURIComponent('חנות-לא-קיימת')}/x`;
    // Unknown store either way; what is asserted is that it does not throw on the decode and
    // resolves to nothing rather than to a garbled slug.
    expect(await resolveRequestActor(encoded, noCookies)).toEqual({});
    // A malformed escape must not throw — it is a path from a request.
    expect(await resolveRequestActor('/%E0%A4%A', noCookies)).toEqual({});
  });
});
