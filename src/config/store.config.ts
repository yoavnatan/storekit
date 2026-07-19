interface NavLink {
  label: string;
  href: string;
}

interface AdsConfig {
  googleTagId?: string;
  metaPixelId?: string;
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
}

export const store: PlatformConfig = {
  name: 'ShopNest',
  url: 'https://example.com',
  tagline: 'Your store, open today',
  description: 'ShopNest is an online marketplace where anyone can open a store and start selling in minutes — no code, no complexity.',
  language: 'en',
  direction: 'ltr',
  locale: 'en_US',

  business: {
    legalName: 'ShopNest',
    email: 'hello@example.com',
    phone: '',
    address: '',
    currency: 'ILS',
    currencySymbol: '₪',
  },

  logo: {
    type: 'text',
    text: 'ShopNest',
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
    note: 'ShopNest — the online marketplace for independent sellers.',
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
