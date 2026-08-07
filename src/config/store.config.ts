interface NavLink {
  label: string;
  href: string;
}

interface AdsConfig {
  googleTagId?: string;
  metaPixelId?: string;
  /** Platform margin taken from a seller-funded BOOST campaign's actual ad spend
   *  (the seller pays for what runs; this % is the platform's cut, the rest buys
   *  real Google/Meta ads — see memory project_boost_billing_model). Disclosed to
   *  the seller as "דמי פלטפורמה". PLACEHOLDER — the real % is not decided yet;
   *  `null` = undecided (no margin applied). When set, remember this is a
   *  reporting/model value only until the real ad + split-payment integration
   *  computes the actual capture (see GO_LIVE_CHECKLIST.md). */
  boostCommissionPercent?: number | null;
}

interface SeoConfig {
  /** IndexNow key — a self-chosen 8-128 hex string the owner generates once.
   *  When set (and the domain is real, not example.com), publishing/updating a
   *  store or product pushes the URL to Bing's IndexNow endpoint so it — and
   *  ChatGPT/Copilot, which retrieve from Bing's index — pick it up within
   *  minutes instead of waiting for a crawl. Also served as the ownership file
   *  at /{key}.txt. Empty = disabled. See GO_LIVE_CHECKLIST.md. */
  indexNowKey?: string;
}

interface PlatformConfig {
  name: string;
  url: string;
  tagline: string;
  description: string;
  language: string;
  direction: string;
  locale: string;
  business: {
    legalName: string;
    email: string;
    phone: string;
    address: string;
    currency: string;
    currencySymbol: string;
  };
  homepage: {
    hero: {
      enabled: boolean;
      title: string;
      subtitle: string;
      ctaText: string;
      ctaHref: string;
    };
    sections: string[];
  };
  nav: NavLink[];
  footer: {
    note: string;
    links: NavLink[];
  };
  checkout: {
    freeShippingOver: number;
    shippingFlat: number;
    provider: string;
    /** NOTE: there is deliberately no `commissionPercent` here. Commission is per-SELLER (it comes
     *  from their pricing tier), so a single platform-wide number would contradict the tier model
     *  the moment two sellers are on different tiers. See src/lib/pricing.ts. */
  };
  social: {
    ogImage: string;
    twitter: string;
    facebook: string;
    instagram: string;
  };
  ads?: AdsConfig;
  seo?: SeoConfig;
}

export const store: PlatformConfig = {
  name: 'Dezabin',
  url: 'https://dezabin.co.il',
  tagline: 'Your store, open today',
  // The platform's own one-line self-description, and it reaches further than it looks: it is the
  // default meta description, the Organization JSON-LD `description`, the OG description, and the
  // opening line of /llms.txt — i.e. the sentence an AI answer engine quotes when asked what
  // Dezabin is. So it follows the positioning rule rather than the convenient phrasing: this used
  // to read "open a store and start selling in minutes — no code, no complexity", which is the
  // store-builder script the owner ruled out on 2026-07-28 (AI_INSTRUCTIONS → Business model) —
  // it invites a comparison with Shopify that a place does not win. Leads with the place instead.
  // Owner's own wording (2026-08-05), and in HEBREW on purpose: the market is Israel and the site
  // is Hebrew-first, so this is the language the engines should quote back to an Israeli asking
  // what Dezabin is. It is NOT the homepage's meta description — that page passes its own
  // (`t.home.browseDesc`), which is what keeps this one free to name the seller-side plumbing.
  // The noun is "מתחם", never "קניון" — see translations.ts `startSelling` for why the word was
  // retired. This string is the reason that rule needs a guard: it lives outside translations.ts,
  // so a wording pass over the UI cannot see it, and it is the copy the engines quote.
  description: 'מתחם חנויות דיגיטלי, כוח של קבוצה: חנות משלך — קונה שנכנס לחנות אחת נחשף לכולן, ולעסק שכבר יש לו חנות זה ערוץ מכירה נוסף בלי מאמץ. סליקה, משלוחים, SEO ופרסום מובנים, וסל אחד לכל החנויות או לכל אחת בנפרד.',
  language: 'he',
  direction: 'rtl',
  locale: 'he_IL',

  business: {
    legalName: 'Dezabin',
    email: 'hello@dezabin.co.il',
    // Owner-supplied 2026-08-06. These are not decoration: `/contact` publishes them, and the
    // first thing Merchant Center and Meta look for before approving a commerce account is who
    // stands behind the site and how to reach them (the "misrepresentation" suspension class).
    // The page skips either one silently while it is blank, which is exactly how they stayed blank.
    phone: '054-6918991',
    address: 'רחוב ברקת 85, שער שומרון, מיקוד 4481000, ישראל',
    currency: 'ILS',
    currencySymbol: '₪',
  },

  homepage: {
    hero: {
      enabled: true,
      title: 'Open your store today.',
      subtitle: 'Open a store of your own, alongside every other store here. Set it up, add products, start selling.',
      ctaText: 'Open your store',
      ctaHref: '/seller/register',
    },
    sections: ['hero'],
  },

  nav: [
    { label: 'Home', href: '/' },
    { label: 'Open a store', href: '/seller/register' },
    { label: 'Log in', href: '/seller/login' },
  ],

  footer: {
    note: 'Dezabin — a home for independent stores.',
    links: [
      { label: 'Terms', href: '/terms' },
      { label: 'Contact', href: '/contact' },
    ],
  },

  checkout: {
    freeShippingOver: 0,
    shippingFlat: 0,
    provider: 'stripe',
  },

  social: {
    ogImage: '/og-default.jpg',
    twitter: '',
    facebook: '',
    instagram: '',
  },

  ads: {
    googleTagId: '',
    metaPixelId: '',
    // TODO(pricing): set the platform's boost ad margin % once decided, then
    // surface the number in the seller boost UI's "דמי פלטפורמה" note. null =
    // undecided. See memory project_business_model_pricing + GO_LIVE_CHECKLIST.md.
    boostCommissionPercent: null,
  },

  seo: {
    // IndexNow submission key. NOT a secret — the protocol requires it to be publicly readable at
    // https://<host>/<key>.txt, which src/pages/[key].txt.ts serves from this value, and that file
    // is the ownership proof. So it belongs in the repo like any other config, and rotating it is
    // just replacing this string.
    // Still inert until the site is on a real domain: indexnow.ts refuses to submit from an
    // example.com host, so this being set costs nothing before launch.
    indexNowKey: '7bb22f21787b9c8d861ef4b4db177ee9',
  },
};

/** Agorot are shown as TWO digits or not at all — never one. A discount lands on prices like
 *  49.5, which `toLocaleString` renders "49.5"; next to a struck-through "55" that reads as a
 *  truncated number rather than a price. A round price keeps no decimals at all, so the common
 *  case stays clean (100 ₪, not 100.00 ₪). */
export function formatPrice(amount: number | string): string {
  const n = Number(amount || 0);
  const hasAgorot = Math.round(n * 100) % 100 !== 0;
  const digits = hasAgorot ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : undefined;
  return `${n.toLocaleString('en-US', digits)} ${store.business.currencySymbol}`;
}

/** Image delivery lives in `src/lib/cdn.ts` — the single place a raw image URL
 *  becomes an optimized one (see the header there for the rule). Re-exported here
 *  because most call sites already import their image helper alongside
 *  `formatPrice` from this config; both spellings hit the same implementation. */
export { cdnSrc, cdnSrcSet, cdnCropSrcSet, cdnBand, cdnThumb, cdnFill, cdnCircle } from '../lib/cdn.js';
