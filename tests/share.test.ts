/**
 * Share links — what a shopper forwards.
 *
 * A share link fails QUIETLY: the button opens, the network opens, and the message simply arrives
 * with the title missing, the URL pasted twice, or a Hebrew slug mangled into a 404. Nothing on
 * our side reports any of it. So the assertions here are on the exact string each network
 * receives, and the two properties that decide whether the link works at all — it is absolute,
 * and it is the STORE's canonical (the seller's own domain when there is one).
 */
import { describe, expect, it } from 'vitest';
import { SHARE_CHANNELS, shareChannelUrl, shareMessage } from '../src/lib/share.js';
import { productCanonicalUrl, storeCanonicalUrl } from '../src/lib/custom-domain.js';

const CONTENT = { url: 'https://dezabin.co.il/acme', title: 'Acme' };

/** The store shapes these two helpers read — nothing else on a Store matters to them. */
const plainStore = { slug: 'acme', customDomain: undefined };
const domainStore = {
  slug: 'acme',
  customDomain: { hostname: 'acme.co.il', status: 'active' as const, addedAt: '' },
};

describe('shareMessage', () => {
  it('puts the URL on its own line', () => {
    // Not cosmetic: a client only auto-links a URL that ends at whitespace, so a title glued to
    // the link is a message that arrives as plain text with no preview card.
    expect(shareMessage(CONTENT)).toBe('Acme\nhttps://dezabin.co.il/acme');
  });
});

describe('shareChannelUrl', () => {
  it('gives WhatsApp one blob that CONTAINS the url', () => {
    const url = shareChannelUrl('whatsapp', CONTENT);
    expect(url.startsWith('https://wa.me/?text=')).toBe(true);
    expect(decodeURIComponent(url.split('text=')[1]!)).toBe('Acme\nhttps://dezabin.co.il/acme');
  });

  it('gives Facebook the url alone — it reads the page for the rest', () => {
    expect(shareChannelUrl('facebook', CONTENT)).toBe(
      'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fdezabin.co.il%2Facme',
    );
  });

  it('gives Telegram the two SEPARATELY, so the url is not sent twice', () => {
    const url = shareChannelUrl('telegram', CONTENT);
    expect(url).toBe('https://t.me/share/url?url=https%3A%2F%2Fdezabin.co.il%2Facme&text=Acme');
    expect(decodeURIComponent(url.split('text=')[1]!)).not.toContain('http');
  });

  it('splits email into subject and body', () => {
    const url = shareChannelUrl('email', CONTENT);
    expect(url.startsWith('mailto:?subject=Acme&body=')).toBe(true);
    expect(decodeURIComponent(url.split('body=')[1]!)).toContain('https://dezabin.co.il/acme');
  });

  it('never emits a raw space or newline — every channel is a URL', () => {
    const content = { url: 'https://dezabin.co.il/acme', title: 'Acme Tools · Tel Aviv' };
    for (const channel of SHARE_CHANNELS) {
      expect(shareChannelUrl(channel, content)).not.toMatch(/\s/);
    }
  });
});

describe('what gets shared', () => {
  it('is the platform canonical for an ordinary store', () => {
    const url = storeCanonicalUrl(plainStore);
    expect(url.startsWith('https://')).toBe(true);
    expect(shareChannelUrl('facebook', { url, title: 'Acme' })).toContain(encodeURIComponent(url));
  });

  it("is the SELLER'S OWN domain once they have one — the point of the feature", () => {
    const url = storeCanonicalUrl(domainStore);
    expect(url).toBe('https://acme.co.il');
    expect(decodeURIComponent(shareChannelUrl('whatsapp', { url, title: 'Acme' }))).toContain('https://acme.co.il');
  });

  it('keeps a Hebrew product slug intact through the extra encoding layer', () => {
    // The canonical percent-encodes the Hebrew segment (url-base.ts#urlSegment); the share link
    // then encodes THAT as a query parameter. Double-encoded is correct — the network decodes one
    // layer before opening it — and the round trip is what proves the shopper lands on the product
    // rather than on a 404.
    const canonical = productCanonicalUrl(plainStore, 'כיסא-עץ');
    expect(canonical).toContain('%D7%9B');
    const shared = shareChannelUrl('telegram', { url: canonical, title: 'כיסא' });
    expect(shared).toContain('%25D7%259B');
    // `searchParams.get` performs exactly the one decode the network itself performs.
    expect(new URL(shared).searchParams.get('url')).toBe(canonical);
    expect(decodeURIComponent(canonical)).toContain('כיסא-עץ');
  });
});
