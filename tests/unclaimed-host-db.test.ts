/**
 * A hostname pointed at us that no store claims — against a real Postgres (area audit row 5).
 *
 * The rules being pinned are all claims about ROWS, which is why this reads the database rather than
 * stubbing it: the bug this file was written for is not a wrong branch, it is a query nobody thought
 * to run. A seller owns both spellings of their domain and only one is ever in a record, so when
 * they move away the stored spelling 301s and its twin 404s — the half of their brand that older
 * links and printed material use most, dead, on the exact feature built to stop links dying.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { createStore, rememberPreviousCustomDomain, updateStore } from '../src/lib/stores.js';
import { unclaimedHostRedirect } from '../src/lib/unclaimed-host.js';

const ADDED_AT = '2026-02-01T00:00:00.000Z';
let n = 0;
const fresh = (p: string) => `${p}${n++}-${Date.now().toString(36)}`;

async function seller(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [id, `${id}@example.test`],
  );
  return id;
}

describe('unclaimedHostRedirect', () => {
  it('sends an old hostname to wherever the store lives now, path intact', async () => {
    const store = await createStore(await seller(), { name: 'M', slug: fresh('m') });
    const host = `${fresh('old')}.example.test`;
    await rememberPreviousCustomDomain(store.id, host);

    expect(await unclaimedHostRedirect(host, '/', '')).toBe(`https://dezabin.co.il/${store.slug}`);
    expect(await unclaimedHostRedirect(host, '/blue-widget', ''))
      .toBe(`https://dezabin.co.il/${store.slug}/blue-widget`);
  });

  it('sends the other spelling of a LIVE domain to the spelling that is registered', async () => {
    const store = await createStore(await seller(), { name: 'L', slug: fresh('l') });
    const host = `${fresh('live')}.example.test`;
    await updateStore(store.id, { customDomain: { hostname: host, status: 'active', addedAt: ADDED_AT } });

    expect(await unclaimedHostRedirect(`www.${host}`, '/', '')).toBe(`https://${host}`);
    expect(await unclaimedHostRedirect(`www.${host}`, '/blue-widget', '?x=1'))
      .toBe(`https://${host}/blue-widget?x=1`);
  });

  /** The finding. Both reasons at once — the twin spelling of a hostname the store has MOVED off. */
  it('sends the other spelling of an OLD domain to the store, in one hop', async () => {
    const store = await createStore(await seller(), { name: 'T', slug: fresh('t') });
    const host = `${fresh('moved')}.example.test`;
    await rememberPreviousCustomDomain(store.id, host);

    // Straight to the canonical, NOT to `https://<host>` — that would be a 301 to a 301, and a chain
    // is a thing engines drop. There is nothing at the intermediate hop worth visiting.
    expect(await unclaimedHostRedirect(`www.${host}`, '/', ''))
      .toBe(`https://dezabin.co.il/${store.slug}`);
    expect(await unclaimedHostRedirect(`www.${host}`, '/blue-widget', ''))
      .toBe(`https://dezabin.co.il/${store.slug}/blue-widget`);
  });

  it('follows the store to its NEW domain, from either spelling of the old one', async () => {
    const store = await createStore(await seller(), { name: 'N', slug: fresh('n') });
    const oldHost = `${fresh('was')}.example.test`;
    const newHost = `${fresh('now')}.example.test`;
    await rememberPreviousCustomDomain(store.id, oldHost);
    await updateStore(store.id, { customDomain: { hostname: newHost, status: 'active', addedAt: ADDED_AT } });

    expect(await unclaimedHostRedirect(oldHost, '/blue-widget', '')).toBe(`https://${newHost}/blue-widget`);
    expect(await unclaimedHostRedirect(`www.${oldHost}`, '/blue-widget', '')).toBe(`https://${newHost}/blue-widget`);
  });

  it('percent-encodes a Hebrew path, which is the common one in this catalogue', async () => {
    const store = await createStore(await seller(), { name: 'H', slug: fresh('h') });
    const host = `${fresh('heb')}.example.test`;
    await rememberPreviousCustomDomain(store.id, host);
    // A raw Hebrew segment in a Location header throws a 500 rather than redirecting (url-base.ts).
    for (const h of [host, `www.${host}`]) {
      expect(await unclaimedHostRedirect(h, '/נעל-ריצה', '')).toContain('%D7%A0%D7%A2%D7%9C');
    }
  });

  it('says nothing about a hostname nobody here has ever answered to', async () => {
    expect(await unclaimedHostRedirect(`${fresh('stranger')}.example.test`, '/', '')).toBeNull();
    expect(await unclaimedHostRedirect(`www.${fresh('stranger')}.example.test`, '/', '')).toBeNull();
    // A single label has no twin worth looking up — stripping `www.` would leave a non-public name.
    expect(await unclaimedHostRedirect('www.internal', '/', '')).toBeNull();
  });
});
