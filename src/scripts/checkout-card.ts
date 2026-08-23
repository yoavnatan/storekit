/**
 * The buyer's card, entered once, for the whole cart.
 *
 * **The card number never touches this origin.** PayMe's Hosted Fields SDK mounts three iframes —
 * number, expiry, CVC — served from their domain, inside our checkout page. The buyer types into
 * them, and `tokenize()` hands back a TOKEN: a string that stands for the card without being it.
 * That token is what `/api/checkout` charges each store with (`lib/payment-split.ts`). Nothing here
 * ever reads a card number, which is what keeps this codebase out of PCI scope, and it is why the
 * three containers below are empty `<div>`s rather than `<input>`s.
 *
 * ── The integration, and where every line of it comes from ──
 * `github.com/PayMeService/payme-jsapi` — their own published example, read 2026-08-23. The guide
 * pages at `payme.stoplight.io` are a JavaScript application that returns a title and no body to any
 * fetch (`docs/payme-sandbox-notes.md`), which is why an earlier session concluded this half could
 * not be written without talking to them. It could; the example repository is plain files.
 *
 *   `PayMe.create(publicKey, { testMode, language, tokenIsPermanent })`
 *   `instance.hostedFields()` → `.create(PayMe.fields.NUMBER | EXPIRATION | CVC)` → `.mount('#id')`
 *   `instance.tokenize(saleData)` → `{ token, card: { cardMask, … } }`
 *
 * **`tokenIsPermanent` is passed explicitly even though their default is already `true`.** A
 * one-time token is the failure that ends a two-store cart with store one paid and store two
 * refused — measured, `Buyer inactive` — and `payment-payme.ts` hard-codes the server half for the
 * same reason. A default that happens to be right is not a guarantee; it is a line in somebody
 * else's changelog waiting to move.
 *
 * **Which merchant's key.** Their example passes a plain UUID, not a `MPL…`-shaped
 * `seller_payme_id`, and `create-seller` returns a separate `seller_public_key` documented as being
 * for Hosted Fields — so it is the public key, and the older note in GO_LIVE §3.1 saying the SDK
 * takes the seller id describes their previous example. ⚠️ That is a READING of two documents, not
 * a measurement: this has never been run in a browser. It is the first thing to check when the
 * fields are watched live, and the failure is loud (`create` rejects), never silent.
 *
 * ── Failing must be visible ──
 * Every path here can leave the buyer unable to pay: their CDN is down, the script is blocked, the
 * fields refuse to mount, tokenising is declined. Row 11 of the area audit is entirely about what
 * that looks like — a button that re-enables and a screen that looks fine — so nothing in this file
 * resolves quietly. `loadCardFields` rejects with a reason the caller shows, and the SDK script gets
 * a DEADLINE, because a `<script>` that never fires either event leaves a promise pending forever
 * and the pay button spinning (`lib/outbound-fetch.ts`'s header states the browser half of that
 * rule).
 */

/** Their loader, from the example repository. */
const SDK_URL = 'https://cdn.payme.io/hf/v1/hostedfields.js';

/** Long enough for a slow phone on a bad connection to fetch ~100KB, short enough that a buyer is
 *  told something is wrong while they still have the patience to try again. The same judgement
 *  `outbound-fetch.ts` makes for a request a human is waiting on. */
const SDK_TIMEOUT_MS = 15_000;

export const CARD_CONTAINERS = {
  number: 'payme-card-number',
  expiry: 'payme-card-expiry',
  cvc: 'payme-card-cvc',
} as const;

/** What `/api/payme/hosted-fields` answers. `active: false` is the ordinary state in development
 *  and in the window before a gateway exists — never an error. */
export interface CardConfig {
  active: boolean;
  publicKey?: string;
  testMode?: boolean;
}

/** Only what this file uses. Typed narrowly on purpose: a wide `any` for a third-party global is
 *  how a renamed method becomes a runtime crash on the payment step instead of a build error. */
interface PayMeGlobal {
  create(apiKey: string, options: { testMode?: boolean; language?: string; tokenIsPermanent?: boolean }): Promise<PayMeInstance>;
  fields: { NUMBER: unknown; EXPIRATION: unknown; CVC: unknown };
}
interface PayMeInstance {
  hostedFields(): { create(field: unknown, options?: Record<string, unknown>): { mount(selector: string): void } };
  tokenize(sale: Record<string, unknown>): Promise<{ token?: string }>;
}

declare global {
  interface Window { PayMe?: PayMeGlobal }
}

export interface CardFields {
  /** Exchange whatever the buyer typed for a token. Rejects on a decline or an incomplete card —
   *  the message is theirs and is safe to show, since it describes the buyer's own input. */
  tokenize(sale: {
    firstName: string; lastName: string; email: string; phone: string;
    amountIls: string; label: string;
  }): Promise<string>;
}

let sdkPromise: Promise<PayMeGlobal> | null = null;

/**
 * Load their script once, with a deadline.
 *
 * Memoised on the PROMISE rather than on a boolean, so two callers racing (the accordion opening
 * twice, a re-render) share one script tag and one outcome. A rejected promise is cleared, because
 * a temporary network failure must not make every later attempt fail instantly with a stale error.
 */
function loadSdk(): Promise<PayMeGlobal> {
  if (window.PayMe) return Promise.resolve(window.PayMe);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<PayMeGlobal>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    // A script that neither loads nor errors is the case the timeout exists for: a CDN that
    // accepted the connection and went quiet fires neither event, and without this the promise
    // never settles and the buyer's button spins with no error and no way out but a reload.
    const timer = window.setTimeout(() => {
      script.remove();
      reject(new Error('payme: the card form did not load in time'));
    }, SDK_TIMEOUT_MS);

    script.onload = () => {
      window.clearTimeout(timer);
      // Loaded and yet unusable: a proxy or an ad blocker can serve a 200 that is not their script.
      // Saying so beats `undefined is not a function` three lines later.
      if (window.PayMe) resolve(window.PayMe);
      else reject(new Error('payme: the card form loaded but did not initialise'));
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('payme: the card form could not be loaded'));
    };
    document.head.appendChild(script);
  }).catch((err: unknown) => {
    sdkPromise = null;   // so a retry is a real retry
    throw err;
  });

  return sdkPromise;
}

/** Ask the server whether cards are live for this cart, and for the key to draw them with. */
export async function fetchCardConfig(storeSlug: string): Promise<CardConfig> {
  try {
    const res = await fetch(`/api/payme/hosted-fields?store=${encodeURIComponent(storeSlug)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { active: false };
    return await res.json() as CardConfig;
  // silent: deliberately, and it is the safe direction. A failure to ASK whether cards are enabled
  // reads as "not enabled", so no card form is drawn and the buyer is not invited to type into
  // fields that cannot tokenise. The failure is not swallowed overall — pressing pay then reaches
  // `/api/checkout`, which refuses with `missing-card` and whose message the submit path shows.
  // Reporting here as well would put an error on screen for a buyer who has not yet done anything
  // and may never open the payment step at all.
  } catch {
    return { active: false };
  }
}

/**
 * Draw the three fields, and hand back the one operation the checkout needs.
 *
 * Mounting is not retried on failure: the containers are already in the DOM, and a second `mount`
 * into an element that has one is their SDK's problem rather than ours. A failure rejects, the
 * caller says so, and the buyer's own reload is the retry.
 */
export async function loadCardFields(config: CardConfig, lang: 'he' | 'en'): Promise<CardFields> {
  if (!config.active || !config.publicKey) throw new Error('payme: cards are not enabled for this cart');

  const PayMe = await loadSdk();
  const instance = await PayMe.create(config.publicKey, {
    testMode: !!config.testMode,
    language: lang,
    // Explicit. See the module header — a default that happens to be right is not a guarantee, and
    // getting this wrong breaks the SECOND store of a cart, which is the hardest failure to notice.
    tokenIsPermanent: true,
  });

  const fields = instance.hostedFields();
  fields.create(PayMe.fields.NUMBER).mount(`#${CARD_CONTAINERS.number}`);
  fields.create(PayMe.fields.EXPIRATION).mount(`#${CARD_CONTAINERS.expiry}`);
  fields.create(PayMe.fields.CVC).mount(`#${CARD_CONTAINERS.cvc}`);

  return {
    async tokenize(sale) {
      const result = await instance.tokenize({
        payerFirstName: sale.firstName,
        payerLastName: sale.lastName,
        payerEmail: sale.email,
        payerPhone: sale.phone,
        total: {
          label: sale.label,
          // Their field, their unit: SHEKELS as a decimal string, which is the opposite of the
          // server's `sale_price` in agorot (`payment-payme.ts`'s header carries the whole trap).
          // The caller formats it from an integer, once, so no division happens here.
          amount: { currency: 'ILS', value: sale.amountIls },
        },
      });
      // A tokenize that resolves without a token is not a success. Treating it as one would send
      // `buyerKey: undefined` to the checkout, which refuses it — a correct outcome reached by the
      // wrong route, with a confusing message.
      if (!result?.token) throw new Error('payme: the card was not accepted');
      return result.token;
    },
  };
}
