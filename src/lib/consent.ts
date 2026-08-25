/**
 * Cookie preferences — the ONE definition of what may run, read by the server that decides whether
 * to emit a tag and by the browser that records a change.
 *
 * **The model is the ISRAELI one, and the first version of this file was the European one.**
 * (Owner, 2026-08-25: *"צריך להתאים לחוקים ולנוהג המקובל בישראל, לא באירופה"*, then *"נכון על כל
 * הסשן"* and *"הלכת רחוק מדי"*. Memory `feedback_israeli_law_not_european`.)
 *
 * **The law, checked rather than assumed** (`docs/legal-privacy-accessibility.md` §4): Israeli law
 * contains **no express cookie-banner duty and no opt-in requirement**. What binds is the §11
 * notification duty and consent *מדעת* — and, given clear disclosure in the privacy policy,
 * **consent may be implied from the visitor's conduct**. The Authority's 2020 opt-in document is a
 * *draft* that was never finalised. The Israeli practice follows: cookies run from the first visit,
 * a notice says so, and the policy carries the detail. That is what this implements.
 *
 * **The three things that make implied consent lawful rather than merely customary. None is
 * optional, and the third is the one under pressure:**
 *
 * 1. **A visitor who has expressed no preference is treated as permitting.** That is what implied
 *    consent IS, and it is why `effectiveConsent` is a separate function from `parseConsent`. Do
 *    not collapse them: one answers *"has anybody decided?"*, which is what shows the notice; the
 *    other answers *"what may run right now?"*, which is what the server gates on. Reading `null`
 *    as denied silently turns the site back into opt-in — and it would fail silently, because the
 *    only symptom is seller dashboards reporting zeroes with nothing saying why.
 * 2. **The disclosure has to actually be published.** `/privacy` names every category, every
 *    recipient and every retention window, because consent is only implied from conduct when what
 *    is being implied was written down first. That page and this file are one decision.
 * 3. **Turning it off has to be POSSIBLE, and it is deliberately not PROMINENT.** The owner asked
 *    that switching cookies off not be made easy, and the notice bar accordingly carries no reject
 *    button and no settings button — it informs and closes. The control lives one level in, in the
 *    cookies clause of `/privacy`, which the footer links from every page. **That is the floor, and
 *    it does not move.** An opt-out that cannot be reached at all is what makes conduct-based
 *    consent indefensible, and it would convert a lawful arrangement into the one thing the §11
 *    duty is actually enforced on. Not prominent, always reachable.
 *
 * **Google Consent Mode is signalled either way.** GTM is a CONTAINER firing both analytics and
 * advertising tags, so a visitor who switched advertising off and left measurement on needs that
 * answer at Google's own gate and not only at ours — otherwise the setting is a lie the moment a
 * remarketing tag is added to the container.
 *
 * **`CONSENT_VERSION` is how a person is shown the notice again.** Bump it when the CATEGORIES
 * change or a new recipient appears in one. Never for a wording change: re-notifying someone about
 * the same thing is how a notice becomes furniture people dismiss without reading.
 */

/** Categories a visitor can switch off. "Essential" is not here on purpose: a cookie the site
 *  cannot work without (session, cart, CSRF, language) is not a preference, and offering it as one
 *  invites a person to break the site and blame it. `/privacy` lists them so the claim is
 *  auditable. */
export type ConsentCategory = 'analytics' | 'ads';

export const CONSENT_CATEGORIES: readonly ConsentCategory[] = ['analytics', 'ads'];

/** Bump ONLY when the categories or their recipients change — see the header. */
export const CONSENT_VERSION = 1;

export const CONSENT_COOKIE = 'sn_consent';

/** Twelve months — how long a recorded preference is honoured, and how long the notice stays
 *  dismissed. Long enough not to nag a returning shopper, short enough that a year-old preference
 *  is re-stated rather than assumed to still hold. */
export const CONSENT_COOKIE_DAYS = 365;

export interface Consent {
  analytics: boolean;
  ads: boolean;
}

/**
 * `v<version>.a<0|1>.d<0|1>` — small, readable in devtools, and versioned in the VALUE rather than
 * in the cookie name, so bumping the version does not leave the old cookie behind on every browser
 * that ever visited.
 */
export function serializeConsent(c: Consent): string {
  return `v${CONSENT_VERSION}.a${c.analytics ? 1 : 0}.d${c.ads ? 1 : 0}`;
}

/**
 * The RECORDED preference, or `null` for "this visitor has never been shown the notice".
 *
 * `null` is not "denied" — see `effectiveConsent`. It is only what decides whether the notice bar
 * appears. Anything unrecognised or from a previous version is also `null`, which shows the notice
 * again; that is the safe direction for a NOTICE, and it is the opposite of the safe direction for
 * a gate, which is why the two questions are two functions.
 *
 * Written to be handed a raw cookie value straight out of a request, so it must not throw on any
 * string at all.
 */
export function parseConsent(raw: string | undefined | null): Consent | null {
  if (!raw) return null;
  const m = /^v(\d+)\.a([01])\.d([01])$/.exec(raw.trim());
  if (!m || Number(m[1]) !== CONSENT_VERSION) return null;
  return { analytics: m[2] === '1', ads: m[3] === '1' };
}

/** Everything on — and also what "nobody has said otherwise" means (see `effectiveConsent`). */
export const CONSENT_ALL: Consent = { analytics: true, ads: true };
/** Everything non-essential off. Only ever reached from the control on `/privacy`. */
export const CONSENT_NONE: Consent = { analytics: false, ads: false };

/**
 * What may run right now — the recorded preference, or ALL when nobody has expressed one.
 *
 * **This one line is where the Israeli model lives.** Every caller that gates a tag goes through
 * here; `mayLoad*` below do it for you.
 */
export function effectiveConsent(c: Consent | null): Consent {
  return c ?? CONSENT_ALL;
}

/**
 * May GTM load at all? Either category, because the container serves both — and once it is loaded,
 * Consent Mode is what keeps a switched-off half from firing.
 */
export function mayLoadTagManager(c: Consent | null): boolean {
  const e = effectiveConsent(c);
  return e.analytics || e.ads;
}

/** May the Meta pixel load? Advertising only — it has no analytics-only mode we use. */
export function mayLoadAdPixel(c: Consent | null): boolean {
  return effectiveConsent(c).ads;
}

/**
 * The Google Consent Mode v2 signal for a preference.
 *
 * Through `effectiveConsent`, so an undecided visitor signals `granted` and Google's gate agrees
 * with ours. Signalling `denied` while the loader still runs is the worst of both worlds: the tag
 * loads, costs the page its weight, and records nothing.
 *
 * `granted`/`denied` are Google's own literals and are not ours to abbreviate.
 */
export function consentModeSignal(c: Consent | null): Record<string, 'granted' | 'denied'> {
  const e = effectiveConsent(c);
  const analytics = e.analytics ? 'granted' : 'denied';
  const ads = e.ads ? 'granted' : 'denied';
  return {
    analytics_storage: analytics,
    ad_storage: ads,
    ad_user_data: ads,
    ad_personalization: ads,
  };
}
