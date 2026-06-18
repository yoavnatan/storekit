/**
 * PRODUCTS — the catalog.
 *
 * In this demo the "products" are StoreKit plans, so visitors see
 * a real working store and immediately understand what they're buying.
 * Replace these with your own products when you fork for a real store.
 */

export const products = [
  {
    slug: 'starter',
    name: 'Starter Plan',
    price: 0,
    image: '/products/plan-starter.svg',
    description: 'Everything you need to launch your first store — free forever.',
    body: 'Get your store live in minutes. Includes unlimited products, built-in SEO, cart & checkout, and a mobile-ready design. No credit card required.',
    stock: 999,
    featured: true,
    tags: ['plan'],
  },
  {
    slug: 'pro',
    name: 'Pro Plan',
    price: 19,
    image: '/products/plan-pro.svg',
    description: 'Custom domain, analytics, and priority support — per month.',
    body: 'Everything in Starter, plus: custom domain, store analytics dashboard, abandoned cart recovery, priority email support, and early access to new features.',
    stock: 999,
    featured: true,
    tags: ['plan'],
  },
  {
    slug: 'business',
    name: 'Business Plan',
    price: 49,
    image: '/products/plan-business.svg',
    description: 'Advanced features for growing stores — per month.',
    body: 'Everything in Pro, plus: multi-currency support, advanced SEO controls, bulk product import, webhook integrations, and a dedicated onboarding call.',
    stock: 999,
    featured: true,
    tags: ['plan'],
  },
];

/** All products. */
export function getAllProducts() {
  return products;
}

/** Single product by slug, or undefined. */
export function getProductBySlug(slug) {
  return products.find((p) => p.slug === slug);
}

/** Featured products for the homepage, limited to `count`. */
export function getFeaturedProducts(count = 6) {
  return products.filter((p) => p.featured).slice(0, count);
}
