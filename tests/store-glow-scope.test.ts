/**
 * @vitest-environment jsdom
 *
 * Which element gets the store's colour.
 *
 * `scripts/store-glow.ts` used to answer that with one hard-coded ancestor
 * (`.store-card`), which made the mechanism card-only. It now walks up to
 * `[data-glow-host]`, and three surfaces mark themselves that way: the store
 * card, the spotlight carousel, and the store header's bottom rule. The failure
 * this guards against is silent and ugly — get the ancestor wrong and a card
 * takes the header's colour, or the header takes a card's. Nothing throws; the
 * page is just painted wrong.
 *
 * The colour itself is not exercised here — reading pixels needs a canvas jsdom
 * does not have. The test seeds the module's own sessionStorage memo instead, so
 * `apply()` takes the cached branch and the ONLY thing under test is where the
 * variable lands. That is the part this change actually altered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const HEADER_SRC = 'https://cdn.example.com/header-logo.png';
const CARD_SRC = 'https://cdn.example.com/card-logo.png';
const HEADER_HEX = '#c2620d';
const CARD_HEX = '#158a56';

function seedCache(): void {
  sessionStorage.setItem(
    'sn_store_glow',
    JSON.stringify({ [HEADER_SRC]: HEADER_HEX, [CARD_SRC]: CARD_HEX }),
  );
}

/** A page with both consumers: a store header and a store card. */
function buildDom(): void {
  document.body.innerHTML = `
    <header id="hdr" class="site-header site-header--store" data-glow-host>
      <a class="logo"><img id="hdr-img" data-glow src="${HEADER_SRC}" alt=""></a>
    </header>
    <main>
      <article id="card" class="store-card" data-glow-host>
        <img id="card-img" data-glow src="${CARD_SRC}" alt="">
      </article>
    </main>`;
}

/** The module memoises `inited` per instance, so each test gets a fresh one. */
async function run(): Promise<void> {
  vi.resetModules();
  const { initStoreGlow } = await import('../src/scripts/store-glow.js');
  initStoreGlow();
  // No real network in jsdom: the images never fire `load` on their own, and the
  // script listens for exactly that when an image isn't complete yet.
  document.querySelectorAll('img[data-glow]').forEach((img) => img.dispatchEvent(new Event('load')));
  // initStoreGlow defers its pass (requestIdleCallback, or setTimeout where that
  // is missing — jsdom has no rIC).
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.querySelectorAll('img[data-glow]').forEach((img) => img.dispatchEvent(new Event('load')));
}

describe('store glow scope', () => {
  beforeEach(() => {
    sessionStorage.clear();
    seedCache();
    buildDom();
  });

  it('paints the header from the header logo, and the card from the card logo', async () => {
    await run();
    expect(document.getElementById('hdr')!.style.getPropertyValue('--store-glow')).toBe(HEADER_HEX);
    expect(document.getElementById('card')!.style.getPropertyValue('--store-glow')).toBe(CARD_HEX);
  });

  it('never lets a card colour escape onto the header', async () => {
    await run();
    // The card is not inside the header, so the header must not have taken the
    // card's colour — the bug that a document-wide pass invites.
    expect(document.getElementById('hdr')!.style.getPropertyValue('--store-glow')).not.toBe(CARD_HEX);
  });

  it('leaves an avatar with no host alone rather than colouring something else', async () => {
    // A surface that forgets the attribute gets no colour — never a neighbour's.
    document.getElementById('hdr')!.removeAttribute('data-glow-host');
    await run();
    expect(document.getElementById('card')!.style.getPropertyValue('--store-glow')).toBe(CARD_HEX);
    expect(document.getElementById('hdr')!.style.getPropertyValue('--store-glow')).toBe('');
  });

  it('is idempotent — a second caller on the same page is a no-op, not a re-walk', async () => {
    vi.resetModules();
    const { initStoreGlow } = await import('../src/scripts/store-glow.js');
    const spy = vi.spyOn(document, 'querySelectorAll');
    initStoreGlow();
    initStoreGlow();
    const passes = spy.mock.calls.filter(([sel]) => sel === 'img[data-glow]').length;
    spy.mockRestore();
    expect(passes).toBe(1);
  });
});
