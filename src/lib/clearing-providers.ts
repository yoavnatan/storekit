/**
 * Which clearing providers a seller can connect his OWN account to, and exactly what each one asks
 * him to paste.
 *
 * ── The model this belongs to ──
 * The platform does not clear the seller's sales. He keeps his own account at his own provider, the
 * buyer's money goes straight into it, and we only ever bill him our monthly fee on our own
 * terminal. `docs/pivot-saas.md` has the whole shape and what it costs.
 *
 * ── Why a registry rather than a branch per provider ──
 * There are a dozen providers in Israel and the owner named four in one sentence (Tranzila, Grow,
 * Hyp, "עוד רבים"). Adding one has to be adding DATA — an entry here, plus one adapter file that
 * speaks its HTTP — or the fifth provider is a rewrite of the settings screen. Nothing outside this
 * file may name a provider in a condition.
 *
 * ── `fieldsVerified`, and why a provider ships without it ──
 * A field list guessed from memory is worse than a missing provider: the seller pastes what he was
 * asked for, the checkout fails on his first real buyer, and he cannot tell whether he typed it
 * wrong or we did. So an entry is only offered to sellers once its fields come from the vendor's
 * own documentation, quoted in the comment beside it (`feedback_verify_before_recommending`). The
 * rest are listed as coming, which is also what tells the next session which page to go read.
 *
 * Nothing here is a commercial recommendation. Whether a provider is a good deal for the seller is
 * his business with them; this file only knows how to talk to them.
 */

/** One thing the seller has to copy across. `secret: true` means it is encrypted at rest
 *  (`secret-box.ts`) and never rendered back into the page. */
export interface ClearingField {
  name: string;
  /** Hebrew, and it must match what the seller sees in HIS provider's screen — not our idea of a
   *  good name for it. He is looking for this string in another tab. */
  label: string;
  secret: boolean;
  /** One line under the field: where in that provider's interface this value lives. */
  help: string;
}

export interface ClearingProvider {
  id: string;
  /** As the provider writes it, including Hebrew where that is what a seller recognises. */
  name: string;
  /** Offered to sellers only when true — see the header. */
  fieldsVerified: boolean;
  /** The page the fields were read from, so the next reader checks the same source. */
  source: string;
  fields: ClearingField[];
}

export const CLEARING_PROVIDERS: ClearingProvider[] = [
  {
    id: 'hyp',
    name: 'Hyp / יעד שריג',
    // Verified by a live call, not by reading: the published demo terminal answered a real signed
    // payment URL on 2026-08-13 (memory `project_provider_sandbox_access`), and the parameter names
    // below are the ones that call carried. Their docs are at developers.hyp.co.il.
    fieldsVerified: true,
    source: 'https://developers.hyp.co.il/ + live call to icom.yaad.net/p/ (2026-08-13)',
    fields: [
      { name: 'masof', label: 'מספר מסוף (Masof)', secret: false, help: 'מופיע בחשבון שלך ב-Hyp, בדרך כלל מספר בן 10 ספרות.' },
      { name: 'apiKey', label: 'מפתח API', secret: true, help: 'בממשק Hyp: הגדרות ← מפתחות API.' },
      { name: 'passp', label: 'סיסמת API (PassP)', secret: true, help: 'נקבעת על ידך באותו מסך של מפתחות ה-API.' },
    ],
  },
  {
    id: 'payplus',
    name: 'PayPlus',
    // Verified 2026-09-07 from PayPlus's own reference: creating a payment page takes
    // `payment_page_uid` in the body and `api-key` + `secret-key` in the headers.
    fieldsVerified: true,
    source: 'https://docs.payplus.co.il/reference/website-or-app',
    fields: [
      { name: 'paymentPageUid', label: 'מזהה דף תשלום (Page UID)', secret: false, help: 'בממשק PayPlus, במסך דפי התשלום.' },
      { name: 'apiKey', label: 'API Key', secret: true, help: 'בממשק PayPlus: הגדרות ← מפתחות API.' },
      { name: 'secretKey', label: 'Secret Key', secret: true, help: 'מוצג פעם אחת כשמייצרים את המפתח — אם אבד, מייצרים חדש.' },
    ],
  },
  {
    id: 'cardcom',
    name: 'קארדקום',
    // Verified 2026-09-07 from Cardcom's OWN WooCommerce plugin, read the way the couriers were read
    // (`docs/shipping-provider-research.md`) — their v11 reference renders in a browser and returns
    // nothing to a fetch, and their support centre answers 403. Three settings in
    // `woo-cardcom-payment-gateway` 3.5.1.0: `terminalnumber` ("The company' Terminal Number"),
    // `username` ("The company API User Name") and `apipass` ("API User Password... Required for
    // cancel/refund API to function"), which the file then sends as `TerminalNumber`, `ApiName` /
    // `UserName` and `ApiPassword`. That is the wire format rather than a marketing page, which is
    // the whole reason this route was taken.
    fieldsVerified: true,
    source: 'wordpress.org plugin woo-cardcom-payment-gateway 3.5.1.0 — cardcom.php settings + IsLowProfileCodeDealOneOK',
    fields: [
      { name: 'terminalNumber', label: 'מספר מסוף', secret: false, help: 'מספר המסוף של העסק שלך בקארדקום.' },
      { name: 'apiName', label: 'שם משתמש API', secret: false, help: 'לא שם המשתמש לכניסה למערכת — נוצר במסך מפתחות ה-API.' },
      { name: 'apiPassword', label: 'סיסמת API', secret: true, help: 'נדרשת גם לביטול ולזיכוי, לא רק לחיוב.' },
    ],
  },
  {
    id: 'tranzila',
    name: 'טרנזילה',
    // Verified 2026-09-07 from their authentication page: the seller supplies an application key
    // and a secret, and every request carries `X-tranzila-api-app-key` plus an access token our
    // adapter computes as hash_hmac('sha256', app key, secret + request-time + nonce). The secret
    // never leaves our server, which is why only these two are asked for.
    //
    // A transaction ALSO carries the terminal, and that was checked rather than assumed: their
    // handshake endpoint (`POST /v2/handshake/create`, `docs/payments-and-billing/handshake-v2/
    // createhandshakev2`) takes `terminal_name` as a required parameter. The keys authenticate the
    // account; the terminal says which of its terminals the money lands in, so a seller with two
    // would otherwise be charging into whichever one we guessed.
    fieldsVerified: true,
    source: 'https://docs.tranzila.com/docs/payments-and-billing/authentication + .../handshake-v2/createhandshakev2',
    fields: [
      { name: 'terminalName', label: 'שם מסוף (terminal_name)', secret: false, help: 'שם המסוף שלך בטרנזילה, מה שמופיע גם בכתובת הכניסה לממשק.' },
      { name: 'appKey', label: 'Application Key', secret: false, help: 'טרנזילה מנפיקים אותו בממשק הניהול שלך.' },
      { name: 'secretKey', label: 'Secret Key', secret: true, help: 'מונפק יחד עם ה-Application Key ולא מוצג שוב.' },
    ],
  },
  {
    id: 'grow',
    name: 'Grow (משולם)',
    // Verified 2026-09-07 from developers.grow.business: *"Each business has its own unique
    // identifiers (userId + pageCode)"*, and *"The x-api-key header is mandatory and must be
    // included in every request."*
    fieldsVerified: true,
    source: 'https://developers.grow.business/reference/create-payment-link',
    fields: [
      { name: 'userId', label: 'User ID', secret: false, help: 'מזהה העסק שלך אצל Grow.' },
      { name: 'pageCode', label: 'Page Code', secret: false, help: 'קוד דף התשלום. יכולים להיות כמה, אחד לאשראי ואחד לביט.' },
      { name: 'apiKey', label: 'API Key', secret: true, help: 'נשלח בכל בקשה. אם אין לך, מבקשים מהתמיכה של Grow.' },
    ],
  },
  {
    id: 'upay',
    name: 'uPay',
    // ── Asked for by the owner (2026-09-08), and it is the first entry that CANNOT be verified from
    // outside — which is exactly the case this flag exists for. ──
    //
    // Every other provider here was settled by reading the vendor: PayPlus and Grow publish a
    // reference, Tranzila publishes an authentication page, and Cardcom's fields came out of their
    // own WooCommerce plugin when their docs answered nothing. uPay publishes no developer
    // documentation at all. Checked 2026-09-08: `upay.co.il/mdrykym` is a marketing guides index
    // with no API section, no `docs.`/`developers.` host answers, and no public integration (plugin,
    // SDK, repo) exists for the ISRAELI uPay — every "upay" package on GitHub and wordpress.org is a
    // different company in Kuwait, Bangladesh or crypto. Their reseller check-box.co.il states the
    // reason plainly: *"מסמך API – תוספת חד פעמית של 250 ש"ח עבור הקמה"*. The document is sold, not
    // published.
    //
    // So the fields are NOT guessed. `feedback_verify_before_recommending`, and the header above:
    // a field list from memory is worse than a missing provider, because the seller pastes what he
    // was asked for and his first real buyer is the one who finds out. `fieldsVerified: false` keeps
    // it out of `connectableProviders()` and makes `/api/seller/own-clearing` refuse it outright.
    //
    // **To finish it:** buy or request the API document (03-8008729 / their contact form), then fill
    // `fields` from it and quote the wire names here the way the four above do. That is a purchase
    // decision, so it is the owner's — it is in GO_LIVE_CHECKLIST §3.1 rather than left here alone.
    fieldsVerified: false,
    source: 'no public developer documentation — checked upay.co.il 2026-09-08; the API document is a paid, support-issued PDF',
    fields: [],
  },
];

/** The providers a seller may pick today. Everything else is listed as coming, never offered. */
export function connectableProviders(): ClearingProvider[] {
  return CLEARING_PROVIDERS.filter((p) => p.fieldsVerified);
}

export function clearingProvider(id: string | null | undefined): ClearingProvider | null {
  return CLEARING_PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * The names a provider's credential object may hold, and nothing else.
 *
 * The form posts whatever the browser sends, and the row is a JSON blob, so without this an
 * attacker — or a renamed field — writes arbitrary keys into a seller's credentials. Unknown keys
 * are dropped rather than rejected: a provider that adds a fourth field should not lock every
 * seller out of saving the three he already has.
 */
export function pickCredentials(provider: ClearingProvider, input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of provider.fields) {
    const value = input[field.name];
    if (typeof value === 'string' && value.trim()) out[field.name] = value.trim();
  }
  return out;
}

/** Which required fields are still empty — what the settings screen reports back, and what decides
 *  whether a store can take money at all. */
export function missingCredentials(provider: ClearingProvider, saved: Record<string, string>): string[] {
  return provider.fields.filter((f) => !saved[f.name]).map((f) => f.name);
}
