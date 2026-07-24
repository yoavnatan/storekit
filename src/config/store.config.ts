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
  logo: {
    type: string;
    text: string;
    image: string;
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
    /** Platform commission taken from each sale via the split-payment provider
     *  (seller's net = revenue − this %). Reporting/analytics only today — the
     *  real deduction happens at the processor once split payment is wired
     *  (see AI_INSTRUCTIONS.md → Payment architecture). */
    commissionPercent: number;
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
  url: 'https://dezabin.com',
  tagline: 'Your store, open today',
  description: 'Dezabin is an online marketplace where anyone can open a store and start selling in minutes — no code, no complexity.',
  language: 'he',
  direction: 'rtl',
  locale: 'he_IL',

  business: {
    legalName: 'Dezabin',
    email: 'hello@dezabin.com',
    phone: '',
    address: '',
    currency: 'ILS',
    currencySymbol: '₪',
  },

  logo: {
    type: 'text',
    text: 'Dezabin',
    image: '/logo.svg',
  },

  homepage: {
    hero: {
      enabled: true,
      title: 'Open your store today.',
      subtitle: 'Join our marketplace — set up your store, add products, and start selling. Free to start, no code needed.',
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
    note: 'Dezabin — the online marketplace for independent sellers.',
    links: [
      { label: 'Terms', href: '/terms' },
      { label: 'Contact', href: '/contact' },
    ],
  },

  checkout: {
    freeShippingOver: 0,
    shippingFlat: 0,
    provider: 'stripe',
    commissionPercent: 10,
  },

  social: {
    ogImage: '/og-default.png',
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
    // Generate a key (e.g. a random 32-char hex) and paste it here at go-live to
    // enable active IndexNow submission. Empty = disabled. See GO_LIVE_CHECKLIST.md.
    indexNowKey: '',
  },
};

export function formatPrice(amount: number | string): string {
  const n = Number(amount || 0);
  return `${n.toLocaleString('en-US')} ${store.business.currencySymbol}`;
}

export function cdnSrc(url: string, w = 400): string {
  const m = url.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/);
  if (!m || !m[2]) return url;
  if (m[2].startsWith('f_') || m[2].startsWith('q_') || m[2].startsWith('c_') || m[2].startsWith('w_')) return url;
  return `${m[1]}f_auto,q_auto,w_${w}/${m[2]}`;
}
