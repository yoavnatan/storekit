/**
 * ============================================================
 *  STORE CONFIG — the single file a store owner edits.
 * ============================================================
 *
 * This is the "modular" core of the project. A non-technical owner
 * controls the look, texts, branding, and behaviour of the entire
 * store from here, without touching any component.
 *
 * NOTE: This config is itself a live demo — the site looks and works
 * like a real store so visitors immediately understand what they get.
 */

export const store = {
  /* ---- Identity & SEO basics ---- */
  name: 'StoreKit',
  url: 'https://example.com',
  tagline: 'Launch your store in minutes',
  description: 'StoreKit lets you build a fast, SEO-ready online store in minutes — no code required. Add products, choose your look, and go live.',
  language: 'en',
  direction: 'ltr',
  locale: 'en_US',

  /* ---- Contact / business info ---- */
  business: {
    legalName: 'StoreKit',
    email: 'hello@example.com',
    phone: '',
    address: '',
    currency: 'USD',
    currencySymbol: '$',
  },

  /* ---- Branding / theme — all mapped to CSS variables. ---- */
  theme: {
    primary: '#5b4cf5',
    primaryDark: '#4035d1',
    accent: '#ff6b35',
    bg: '#ffffff',
    surface: '#f8f7ff',
    text: '#1a1523',
    muted: '#6b6580',
    border: '#e8e5f5',
    radius: '14px',
    font: "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
    maxWidth: '1160px',
  },

  /* ---- Logo ---- */
  logo: {
    type: 'text',
    text: 'StoreKit',
    image: '/logo.svg',
  },

  /* ---- Homepage layout ---- */
  homepage: {
    hero: {
      enabled: true,
      title: 'Your store, live in minutes.',
      subtitle: 'StoreKit gives you a fast, beautiful, SEO-ready online store — without writing a line of code. Add products, pick your look, and publish.',
      ctaText: 'See the plans',
      ctaHref: '/products',
      image: '',
    },
    featuredProducts: {
      enabled: true,
      title: 'Choose your plan',
      count: 6,
    },
    sections: ['hero', 'featuredProducts'],
  },

  /* ---- Navigation ---- */
  nav: [
    { label: 'Home', href: '/' },
    { label: 'Plans', href: '/products' },
  ],

  /* ---- Footer ---- */
  footer: {
    note: 'Built with StoreKit — the modular store builder.',
    links: [
      { label: 'Terms', href: '/terms' },
      { label: 'Contact', href: '/contact' },
    ],
  },

  /* ---- Checkout behaviour ---- */
  checkout: {
    freeShippingOver: 0,
    shippingFlat: 0,
    provider: 'stripe',
  },

  /* ---- Social / SEO ---- */
  social: {
    ogImage: '/og-default.png',
    twitter: '',
    facebook: '',
    instagram: '',
  },
};

/** Format a price using the configured currency symbol. */
export function formatPrice(amount) {
  const n = Number(amount || 0);
  return `${store.business.currencySymbol}${n.toLocaleString('en-US')}`;
}
