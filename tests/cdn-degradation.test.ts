/**
 * **A Cloudinary outage must be a bad-looking afternoon, never a closed mall.**
 *
 * `lib/cdn.ts` is the one place a raw image URL becomes a delivery URL, and it survives an outage
 * for a single reason: it is pure string manipulation. Regex, template, return. It opens no socket,
 * nothing in it is `async`, and no page waits on the CDN before deciding what to render — so with
 * Cloudinary unreachable a shopper gets broken `<img>`s on a page whose prices, stock, variants,
 * cart and pay button all still work.
 *
 * **This file exists because that property is one plausible edit away from being false.** The
 * tempting improvement is a probe: ask whether a derivation exists, fall back to the original if it
 * does not, warm it before rendering. Each of those is defensible on its own and each makes the CDN
 * a dependency of the HTML — at which point a Cloudinary incident takes the whole platform off the
 * air, during someone else's outage, on a path nobody tested because it only misbehaves then.
 *
 * The assertions are therefore about SHAPE, not about output — `image-optimization.test.ts` already
 * owns whether the URLs are right.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cdn from '../src/lib/cdn.js';

const source = readFileSync(join(process.cwd(), 'src/lib/cdn.ts'), 'utf8');

/** Strip block and line comments — the header above deliberately DISCUSSES fetching and awaiting,
 *  and a guard that failed on its own explanation would be a guard whose fix is deleting the
 *  explanation. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('cdn.ts cannot reach the network', () => {
  it('calls nothing that opens a socket', () => {
    const network = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bnavigator\.sendBeacon\b/, /from\s+['"]node:(https?|net|dns)['"]/];
    expect(network.filter((re) => re.test(code)).map(String)).toEqual([]);
  });

  it('declares no async function and awaits nothing', () => {
    // An `async` export here would mean a caller `await`ing it, and a caller awaiting it is a page
    // that can be made to wait. The shape is the thing being fixed in place, not the current body.
    expect(/\basync\b/.test(code)).toBe(false);
    expect(/\bawait\b/.test(code)).toBe(false);
  });

  it('exports only synchronous functions — no exported value returns a promise', () => {
    for (const [name, value] of Object.entries(cdn)) {
      if (typeof value !== 'function') continue;
      expect(value.constructor.name, `${name} must not be async`).toBe('Function');
    }
  });
});

describe('with the CDN unreachable, a page still knows what to render', () => {
  // The functions cannot tell whether Cloudinary is up — that is the point. What is asserted here is
  // that each returns a usable string synchronously for the inputs a product page actually holds,
  // so nothing downstream is ever handed `undefined`, a promise, or a throw to handle.
  const upload = 'https://res.cloudinary.com/demo/image/upload/v1/sample.jpg';
  const foreign = 'https://cdn.example.com/photo.jpg';
  const relative = '/images/local.png';

  for (const url of [upload, foreign, relative, '']) {
    it(`returns a string for ${url || '(empty)'} without waiting on anything`, () => {
      expect(typeof cdn.cdnSrc(url, 400)).toBe('string');
      expect(typeof cdn.cdnThumb(url, 80, 80)).toBe('string');
      expect(typeof cdn.cdnBand(url, 800, 3)).toBe('string');
      expect(typeof cdn.cdnSrcSet(url, [200, 400])).toBe('string');
    });
  }

  it('hands a URL back unchanged rather than inventing one it cannot serve', () => {
    // The honest failure. A relative path has no Cloudinary equivalent, and returning a delivery URL
    // for it would turn a working local image into a broken remote one — an outage this file caused.
    expect(cdn.cdnSrc(relative, 400)).toBe(relative);
  });
});

describe('the skeleton does not outlive a failed image', () => {
  it('clears on error as well as on load', () => {
    // A shimmer that only listens for `load` becomes a permanent grey box over content the shopper
    // could otherwise read — the placeholder turning a missing image into a missing product.
    const skeleton = readFileSync(join(process.cwd(), 'src/lib/img-skeleton.ts'), 'utf8');
    expect(skeleton).toMatch(/addEventListener\(\s*'error'/);
  });
});
