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
    // NOT verified. Their v11 reference (secure.cardcom.solutions/Api/v11/Docs) renders in the
    // browser and returns nothing to a fetch, and the support centre answers 403. The shape is
    // widely known (terminal number + an API user and password) and that is exactly why it must not
    // be typed here from memory. Read it from a browser, or from their own WooCommerce plugin's
    // source the way the couriers were read (`docs/shipping-provider-research.md`).
    fieldsVerified: false,
    source: 'https://secure.cardcom.solutions/Api/v11/Docs (JS-rendered — read it in a browser)',
    fields: [],
  },
  {
    id: 'tranzila',
    name: 'טרנזילה',
    // NOT verified — owner named it 2026-09-07. Their terminal identifier and key pair need reading
    // from Tranzila's own documentation before a seller is asked for anything.
    fieldsVerified: false,
    source: 'https://docs.tranzila.com/ — not yet read',
    fields: [],
  },
  {
    id: 'grow',
    name: 'Grow (משולם)',
    // NOT verified — owner named it 2026-09-07. Grow's own pricing pages contradict each other
    // (memory `project_split_model_payme`), so nothing about them is taken on trust.
    fieldsVerified: false,
    source: 'https://grow.business/ — not yet read',
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
