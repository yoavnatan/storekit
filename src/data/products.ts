export interface Product {
  slug: string;
  name: string;
  price: number;
  image: string;
  icon: string;
  badge?: string;
  description: string;
  body: string;
  stock: number;
  featured: boolean;
  tags: string[];
}

export const products: Product[] = [
  {
    slug: 'starter',
    name: 'Starter Plan',
    price: 0,
    image: '/products/plan-starter.svg',
    icon: 'zap',
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
    icon: 'star',
    badge: 'Most popular',
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
    icon: 'briefcase',
    description: 'Advanced features for growing stores — per month.',
    body: 'Everything in Pro, plus: multi-currency support, advanced SEO controls, bulk product import, webhook integrations, and a dedicated onboarding call.',
    stock: 999,
    featured: true,
    tags: ['plan'],
  },
];

export function getAllProducts(): Product[] {
  return products;
}

export function getProductBySlug(slug: string): Product | undefined {
  return products.find((p) => p.slug === slug);
}

export function getFeaturedProducts(count = 6): Product[] {
  return products.filter((p) => p.featured).slice(0, count);
}
