/**
 * The Content-Security-Policy this site sends, and the list of third parties the BROWSER is
 * allowed to reach.
 *
 * **Why it exists now:** the payment page is going to be embedded in an iframe rather than
 * redirected to (owner, 2026-08-17), and a browser will only frame a third party the page has
 * declared. So the policy is a prerequisite for taking money, not a hardening task that can wait.
 *
 * **Why it is one module and not a string in the middleware.** A CSP fails in the worst way an
 * outward-facing rule can: silently, in someone else's browser, only for the resource nobody
 * remembered. The list of who we let in is therefore DATA — one row per origin, each carrying the
 * directive it needs and the reason it is here — so that `tests/csp-allowlist.test.ts` can scan the
 * browser-side tree and fail the build when code starts talking to an origin this list has never
 * heard of. That is the guarantee the owner actually asked for ("every session must check the
 * policy is still valid"): not a reminder, which decays, but a check that runs on every verify.
 *
 * ── What is deliberately NOT locked down, and the trigger for each ──
 *
 * **`'unsafe-inline'` on scripts.** This site renders inline `<script>` blocks from `BaseLayout`
 * and from a dozen components (`is:inline set:html`), so a policy without it would blank the site
 * on the first request. Removing it means nonces on every inline block — a real change, and one
 * with no value while the ONE thing it would protect against is already covered: `lib/json-script.ts`
 * owns every data-into-script path. Trigger to revisit: an inline block that interpolates anything
 * a request can influence and does not go through that module.
 *
 * **The tag-manager problem, and it is the one that will bite.** GTM's whole purpose is injecting
 * third-party tags decided in Google's UI, which no test here can see. Today that costs nothing —
 * both tag ids are still empty (GO_LIVE §2.5) — so the policy names only the loader. **⚠️ The day
 * GTM goes live, every tag host it pulls has to be added here or the tag silently does nothing.**
 * That is written on the GTM row in GO_LIVE, because it fires long after this file is forgotten.
 */

/** The directives an origin can be needed for. Kept narrow on purpose: an origin that needs four
 *  of these is a third party running the page, and that should be an argument, not a config line. */
export type CspDirective = 'script-src' | 'img-src' | 'connect-src' | 'frame-src';

export interface ExternalOrigin {
  /** Scheme + host, exactly as it must appear in the header. */
  origin: string;
  directives: readonly CspDirective[];
  /** Why the browser reaches it. One line, and it is what a future reader judges removal by. */
  why: string;
}

/**
 * Every origin the BROWSER touches. Server-side calls (Resend, the Google APIs, Cloudflare,
 * IndexNow) are deliberately absent — a CSP governs the page, not the process, and listing them
 * here would teach the next reader that this file is an inventory of integrations. It is not.
 */
export const BROWSER_ORIGINS: readonly ExternalOrigin[] = [
  { origin: 'https://res.cloudinary.com', directives: ['img-src'], why: 'Every product and store image is delivered through the CDN (lib/cdn.ts).' },
  { origin: 'https://api.cloudinary.com', directives: ['connect-src'], why: 'The dashboard uploads straight from the browser to the unsigned preset.' },
  { origin: 'https://www.googletagmanager.com', directives: ['script-src', 'img-src', 'connect-src', 'frame-src'], why: 'GTM loader + its no-JS iframe. See the tag-manager warning in this header.' },
  { origin: 'https://connect.facebook.net', directives: ['script-src'], why: 'The Meta Pixel loader.' },
  { origin: 'https://www.facebook.com', directives: ['img-src', 'connect-src'], why: 'The Pixel’s no-JS tracking image and its event beacons.' },
  { origin: 'https://pay.hyp.co.il', directives: ['frame-src', 'connect-src'], why: 'The embedded payment page (lib/payment-hyp.ts). Without this the checkout iframe is blank.' },
  { origin: 'https://*.creditguard.co.il', directives: ['frame-src', 'connect-src'], why: 'Hyp Enterprise serves the same payment page from this domain; declared now so the two integration modes do not differ by a header nobody would think to change.' },
  // ── PayMe Hosted Fields (the split model, `lib/payment-payme.ts`) ──
  // The buyer's card number is typed into IFRAMES served by PayMe, inside our own page, so the
  // number never touches this origin and never reaches our server. That is the whole reason this
  // codebase is out of PCI scope, and it is why three directives are needed rather than one: the
  // loader is a script, each field is a frame, and tokenising is a request from inside them.
  //
  // ✅ **MEASURED IN A REAL BROWSER, 2026-08-23 — and the guess was wrong.** This block used to say
  // the field origin was unmeasured and that declaring all three API hosts covered it. It did not:
  // the SDK frames **`https://hf.payme.io`**, a fourth host that appeared in none of their
  // documents, and Chrome refused it with
  // `Framing 'https://hf.payme.io/' violates ... frame-src`. Three empty rectangles, no card entry,
  // and the only trace anywhere was a console line — exactly the silent failure the old comment
  // was afraid of, arriving from the direction it did not look.
  //
  // That is the whole argument for driving the thing in a browser rather than reasoning about it:
  // every host here was defensible and the set was still incomplete. The three API hosts stay
  // declared — `connect-src` really does reach them to tokenise — and `hf.payme.io` is the one the
  // fields themselves come from.
  { origin: 'https://hf.payme.io', directives: ['frame-src', 'connect-src'], why: 'Where the card/expiry/CVC field iframes are actually served from — measured in a browser, 2026-08-23. Without it the fields are blocked and the buyer cannot type a card.' },
  { origin: 'https://cdn.payme.io', directives: ['script-src', 'frame-src', 'connect-src'], why: 'The Hosted Fields loader script.' },
  { origin: 'https://sandbox.payme.io', directives: ['frame-src', 'connect-src'], why: 'Hosted Fields tokenises against the API host; this is the staging one.' },
  { origin: 'https://live.payme.io', directives: ['frame-src', 'connect-src'], why: 'The same, in production. Both are declared so the environment switch is a variable and not a header change.' },
];

function originsFor(directive: CspDirective): string[] {
  return BROWSER_ORIGINS.filter((o) => o.directives.includes(directive)).map((o) => o.origin);
}

/**
 * The policy, assembled from the list above.
 *
 * The directives with no third party in them are the ones carrying most of the value here, and
 * they cost nothing because nothing legitimate uses them:
 *   · `frame-ancestors 'none'` — nobody may frame US. This is the clickjacking defence, and it is
 *     the half of the iframe story that is easy to forget: we are about to embed someone, which
 *     says nothing about who may embed us.
 *   · `object-src 'none'` — no plugins, ever.
 *   · `base-uri 'self'` — an injected `<base>` can silently re-point every relative URL on the page.
 *   · `form-action 'self'` — a form on our page may only post to us. The payment form lives inside
 *     Hyp's iframe, which is its own document and unaffected.
 */
export function contentSecurityPolicy(): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // `blob:` is the background-removal worker; `data:` is inline SVG and canvas output.
    'img-src': ["'self'", 'data:', 'blob:', ...originsFor('img-src')],
    'script-src': ["'self'", "'unsafe-inline'", ...originsFor('script-src')],
    // Tailwind and the component styles compile to files, but Astro still emits inline style
    // attributes, and a style attribute is not a script — the risk profile is not comparable.
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'"],   // Heebo is self-hosted; a font arriving from anywhere else is a bug.
    'connect-src': ["'self'", ...originsFor('connect-src')],
    'frame-src': ["'self'", ...originsFor('frame-src')],
    'worker-src': ["'self'", 'blob:'],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };
  return Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}
