import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIContext } from 'astro';

type TestDiscount = { type: 'percent' | 'amount'; value: number; startsAt?: string; endsAt?: string };
// `variants` is part of the fixture because the route now RESOLVES a buyer's selection against it
// (lib/variant-combo.ts#resolveSelection): a selection is only valid if the product declares those
// dimensions and options, so a test that sends one has to be a product that has them. `widget`
// deliberately keeps none — it is the plain-product path that most tests here exercise.
const PRODUCTS: Record<string, { id: string; slug: string; name: string; price: number; images?: string[]; stock: number; blocked?: boolean; hidden?: boolean; discount?: TestDiscount; variants?: { name: string; options: string[] }[] }> = {
  widget: { id: 'p1', slug: 'widget', name: 'Widget', price: 50, images: ['w.png'], stock: 100 },
  tee:    { id: 'p3', slug: 'tee', name: 'Tee', price: 50, images: ['t.png'], stock: 100,
            variants: [{ name: 'color', options: ['red', 'blue'] }] },
  hoodie: { id: 'p4', slug: 'hoodie', name: 'Hoodie', price: 50, images: ['h.png'], stock: 100,
            variants: [{ name: 'Size', options: ['S', 'L'] }, { name: 'Color', options: ['Red', 'Blue'] }] },
};

type StockAdjustResult = { ok: boolean; before: number; after: number };
// Default mirrors the real decrementStock's before/after semantics off the PRODUCTS fixture,
// so most tests don't need to stub a return value just to get the low-stock math right.
const decrementStock = vi.fn(async (id: string, qty: number, _selectedVariants?: Record<string, string>): Promise<StockAdjustResult> => {
  const before = Object.values(PRODUCTS).find((p) => p.id === id)?.stock ?? 0;
  return { ok: true, before, after: before - qty };
});
const restockProduct = vi.fn(async (_id: string, _qty: number, _selectedVariants?: Record<string, string>): Promise<StockAdjustResult> => ({ ok: true, before: 0, after: 0 }));

/** A store that is on the site. `store-status.ts` reads a missing `publishedAt` as "built and never
 *  published", which is not sellable — so every fixture here that is meant to take an order says so. */
const LIVE = '2026-01-01T00:00:00.000Z';

const STORES: Record<string, { id: string; slug: string; name: string; sellerId: string; address?: string; shipping?: { selfPickup?: boolean }; blocked?: boolean; pausedAt?: string; closePendingAt?: string; closedAt?: string; publishedAt?: string; demo?: boolean; previousSlugs?: string[]; sale?: { active: boolean; title: string; percent?: number } }> = {
  'test-store': {
    id: 's1',
    slug: 'test-store',
    // A live store, which is what every case in this suite is about. Stated rather than assumed:
    // `store-status.ts` reads a missing `publishedAt` as "built and never published", so a fixture
    // that omits it is a shop that cannot sell — and the whole suite would fail on the one field
    // nobody meant to test.
    publishedAt: LIVE,
    name: 'Test Store',
    sellerId: 'seller-1',
    address: 'Herzl 1, Tel Aviv', // present so self-pickup is offerable
    shipping: { selfPickup: true },
  },
};

const createOrder = vi.fn((input: Record<string, unknown>) => ({ id: 'order-1', ...input }));
const updateOrder = vi.fn(async (_id: string, _patch: Record<string, unknown>) => ({ id: 'order-1' }));
const createNotification = vi.fn();
const getSellerSession = vi.fn(() => null as string | null);
// Seller accounts keyed by address. The real column is `citext`, so the lookup is
// case-insensitive — mirrored here, because case is exactly how a half-done guard gets walked past.
const SELLER_ACCOUNTS: Record<string, { id: string; email: string }> = {};
const getSellerByEmail = vi.fn(async (email: string) => SELLER_ACCOUNTS[email.trim().toLowerCase()] ?? null);
const removeCartLines = vi.fn(async (_id: string, _lines: unknown) => {});
const logError = vi.fn();

// Only the fs-backed LOOKUPS are stubbed. The lifecycle predicates come from the real
// store-status.js (pure, no fs) rather than being re-implemented here: `isStoreVisible: !blocked`
// used to be a copy of the rule, and the moment "may this store sell" grew past `blocked` — a
// seller pause, a pending closure — the copy went on answering the old question and this suite
// would have kept passing while checkout let a closed store take money.
vi.mock('../src/lib/stores.js', async () => {
  const status = await import('../src/lib/store-status.js');
  return {
    ...status,
    getStoreBySlug: (slug: string) => STORES[slug] ?? null,
    getStoreBySlugOrPrevious: (slug: string) =>
      STORES[slug] ?? Object.values(STORES).find((s) => s.previousSlugs?.includes(slug)) ?? null,
    isStoreVisible: status.isStoreReachable,
  };
});
vi.mock('../src/lib/store-products.js', () => ({
  getProductBySlug: (_storeId: string, slug: string) => PRODUCTS[slug] ?? null,
  decrementStock: (id: string, qty: number, selectedVariants?: Record<string, string>) => decrementStock(id, qty, selectedVariants),
  restockProduct: (id: string, qty: number, selectedVariants?: Record<string, string>) => restockProduct(id, qty, selectedVariants),
  isProductVisible: (product: { blocked?: boolean; hidden?: boolean }) => !product.blocked && !product.hidden,
  LOW_STOCK_THRESHOLD: 3,
}));
// `updateOrder` is mocked alongside `createOrder` because the checkout writes the order rows as
// 'pending' and flips them to 'paid' only after the capture succeeds (lib/payment.ts's header says
// why). A mock missing it made the whole POST throw, which is the mock lying about the endpoint
// rather than the endpoint being wrong.
vi.mock('../src/lib/orders.js', () => ({
  createOrder: (input: Record<string, unknown>) => createOrder(input),
  updateOrder: (id: string, patch: Record<string, unknown>) => updateOrder(id, patch),
}));
// `async` on purpose, not incidentally: checkout attaches a `.catch()` to this call so a failed
// notification cannot fail a purchase that is already committed, and a mock returning `undefined`
// would make that line throw here while working in production — the mock testing the mock again.
vi.mock('../src/lib/notifications.js', () => ({
  createNotification: async (input: Record<string, unknown>) => createNotification(input),
}));
vi.mock('../src/lib/seller-auth.js', () => ({
  getSellerSession: () => getSellerSession(),
  getSellerByEmail: (email: string) => getSellerByEmail(email),
  // The checkout looks the seller up after capture to plan the buyer's tax invoice, which is owed
  // by the SELLER under the agent model. Stubbed rather than left out: an absent export throws a
  // TypeError at the call site, and the point of the guard around that call is that the purchase
  // survives it — a test that only ever exercises the throwing path never sees the working one.
  getSellerById: async (id: string) => ({ id, name: 'S', email: 's@example.com', passwordHash: '', createdAt: '', businessType: 'licensed' }),
}));
// `async` for the same reason as the notifications mock above: checkout awaits this now, and a
// mock that is not a promise tests a contract that does not exist.
vi.mock('../src/lib/user-carts.js', () => ({
  removeCartLines: (id: string, lines: unknown) => removeCartLines(id, lines),
}));
// Without this mock, the "order creation fails" test below performed a real
// fs.writeFileSync into the actual dev data/error-log.json on every test run
// — polluting the admin dashboard's error log with a fake "disk write failed"
// entry that looked like a real production incident.
// `async` for the same reason as the notifications mock above (DB_MIGRATION_PLAN.md §8, analytics):
// logError is a query now, and a synchronous mock of an async function tests a contract that does
// not exist.
vi.mock('../src/lib/error-log.js', () => ({ logError: async (entry: Record<string, unknown>) => logError(entry) }));

// The idempotency ledger and the money log both fs.writeFileSync into the real dev `data/`
// directory (same reasoning as error-log below), and the ledger is additionally STATEFUL across
// requests — a leftover `complete` record would replay a later test's checkout instead of running
// it. Replaced with an in-memory ledger that keeps the real claim/replay/release semantics, so the
// endpoint's duplicate-submit branches stay exercised rather than stubbed away.
const ledger = new Map<string, { status: 'pending' | 'complete'; owner?: string; checkoutRef?: string; orderIds?: string[] }>();
vi.mock('../src/lib/checkout-idempotency.js', () => ({
  isValidIdempotencyKey: (key: unknown): boolean => typeof key === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(key),
  // Mirrors the real ownership rule too — a mock that ignored `owner` would let a route that
  // forgot to pass it, or that fell through on a conflict, pass every test here.
  checkoutOwner: (buyerEmail: string): string => `owner:${buyerEmail.trim().toLowerCase()}`,
  claimCheckout: async (key: string, owner: string) => {
    const existing = ledger.get(key);
    if (existing?.status === 'complete') {
      if (existing.owner && existing.owner !== owner) return { status: 'conflict' };
      return { status: 'replay', record: { key, ...existing } };
    }
    if (existing?.status === 'pending') return { status: 'in_progress' };
    ledger.set(key, { status: 'pending', owner });
    return { status: 'claimed' };
  },
  completeCheckout: async (key: string, checkoutRef: string, orderIds: string[], owner: string) => {
    ledger.set(key, { status: 'complete', owner, checkoutRef, orderIds });
  },
  releaseCheckout: async (key: string) => {
    if (ledger.get(key)?.status === 'pending') ledger.delete(key);
  },
}));
vi.mock('../src/lib/money-events.js', () => ({
  recordMoneyEvent: async (event: Record<string, unknown>) => event,
}));

// Same reasoning as error-log above: the funnel-capture side effect isn't what these tests
// exercise, and this file mocks its way to a fully in-memory endpoint. **The stub is `async`
// because the real function is** — a synchronous mock of an async function tests a contract that
// does not exist, and the last module to move found 13 tests failing on `undefined.catch` in code
// that works in production (DB_MIGRATION_PLAN.md §8, `messages`). What the real one does with a
// purchase that names one product twice is pinned in `analytics-db.test.ts`, at the layer that
// owns the statement.
vi.mock('../src/lib/analytics.js', () => ({ recordAnalyticsEvent: async () => {} }));

const { POST } = await import('../src/pages/api/checkout.js');

// Every request carries its own key: the endpoint refuses a submit without one (400), and two
// requests sharing a key are a deliberate duplicate — which is a different test, not the default.
// Spread last so a test that WANTS to replay a key can pass its own.
let keySeq = 0;
function makeContext(body: unknown): APIContext {
  const request = new Request('http://localhost/api/checkout', {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey: `test-key-${String(++keySeq).padStart(8, '0')}`, ...(body as Record<string, unknown>) }),
  });
  const cookies = { get: () => undefined } as unknown as APIContext['cookies'];
  return { request, cookies } as APIContext;
}

const validBuyer = {
  buyerName: 'Dana',
  buyerEmail: 'dana@example.com',
  buyerPhone: '0500000000',
  buyerAddress: { city: 'Tel Aviv', street: 'Rothschild 1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  ledger.clear();
  getSellerSession.mockReturnValue(null);
  // Emptied per test: an account left behind would silently 403 every later checkout.
  for (const key of Object.keys(SELLER_ACCOUNTS)) delete SELLER_ACCOUNTS[key];
});

describe('POST /api/checkout — server-side price re-validation', () => {
  it('ignores a client-sent price and charges the real server-side product price instead', async () => {
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1, price: 1 }],
    }));
    expect(res.status).toBe(201);
    const order = createOrder.mock.calls[0]![0] as { totalAgorot: number; storeSubtotals: Record<string, { subtotalAgorot: number }> };
    // real price (50) + default platform courier rate (30), never the spoofed price of 1
    expect(order.storeSubtotals['test-store']!.subtotalAgorot).toBe(5_000);
    expect(order.totalAgorot).toBe(8_000);
  });

  // A discount is a price the SERVER decides, exactly like the base price: the buyer is charged
  // the marked-down figure whether or not the client knew about it, and a sale that has ended
  // between page load and submit charges full price again.
  it('charges the discounted price when the product is marked down, without the client sending it', async () => {
    PRODUCTS.widget!.discount = { type: 'percent', value: 20 };
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 2, price: 50 }],
      }));
      expect(res.status).toBe(201);
      const order = createOrder.mock.calls[0]![0] as { totalAgorot: number; items: { priceAgorot: number }[]; storeSubtotals: Record<string, { subtotalAgorot: number }> };
      expect(order.items[0]!.priceAgorot).toBe(4_000);
      expect(order.storeSubtotals['test-store']!.subtotalAgorot).toBe(8_000);
      expect(order.totalAgorot).toBe(11_000); // 80 ₪ + 30 ₪ courier
    } finally {
      delete PRODUCTS.widget!.discount;
    }
  });

  it('ignores a discount whose date window has already closed — full price is charged', async () => {
    PRODUCTS.widget!.discount = { type: 'percent', value: 50, startsAt: '2020-01-01', endsAt: '2020-01-31' };
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      const order = createOrder.mock.calls[0]![0] as { storeSubtotals: Record<string, { subtotalAgorot: number }> };
      expect(order.storeSubtotals['test-store']!.subtotalAgorot).toBe(5_000);
    } finally {
      delete PRODUCTS.widget!.discount;
    }
  });

  it('applies the STORE-wide sale to a product with no discount of its own', async () => {
    STORES['test-store']!.sale = { active: true, title: 'End of season', percent: 10 };
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      const order = createOrder.mock.calls[0]![0] as { storeSubtotals: Record<string, { subtotalAgorot: number }> };
      expect(order.storeSubtotals['test-store']!.subtotalAgorot).toBe(4_500);
    } finally {
      delete STORES['test-store']!.sale;
    }
  });

  it('never stacks, and charges the better of the two — here the store sale beats the product\'s own', async () => {
    PRODUCTS.widget!.discount = { type: 'amount', value: 5 };            // 50 → 45
    STORES['test-store']!.sale = { active: true, title: 'End of season', percent: 50 }; // 50 → 25
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      const order = createOrder.mock.calls[0]![0] as { storeSubtotals: Record<string, { subtotalAgorot: number }> };
      // 25 — not 45 (the banner promised 50% off, so the buyer can't be charged more than that)
      // and not 22.5 (the two discounts are never added together).
      expect(order.storeSubtotals['test-store']!.subtotalAgorot).toBe(2_500);
    } finally {
      delete PRODUCTS.widget!.discount;
      delete STORES['test-store']!.sale;
    }
  });

  it('SEO-safe rename: a cart item sent with the store\'s OLD slug still checks out (resolves via previousSlugs, records the current slug)', async () => {
    STORES['test-store']!.previousSlugs = ['old-slug'];
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'old-slug', productSlug: 'widget', qty: 1 }], // buyer's cart predates the rename
      }));
      expect(res.status).toBe(201); // purchase succeeds — not a 400 "store not found"
      const order = createOrder.mock.calls[0]![0] as { storeSubtotals: Record<string, { subtotalAgorot: number }>; items: { storeSlug: string }[] };
      // subtotals + order items key off the CURRENT slug, never the stale one
      expect(order.storeSubtotals['test-store']!.subtotalAgorot).toBe(5_000);
      expect(order.storeSubtotals['old-slug']).toBeUndefined();
      expect(order.items[0]!.storeSlug).toBe('test-store');
    } finally {
      delete STORES['test-store']!.previousSlugs;
    }
  });

  it('charges no shipping for self-pickup (store offers it) and records the method', async () => {
    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      deliveryMethods: { 'test-store': 'pickup' },
    }));
    const order = createOrder.mock.calls[0]![0] as { totalAgorot: number; shippingAgorot: number; storeSubtotals: Record<string, { deliveryMethod?: string }> };
    expect(order.shippingAgorot).toBe(0);
    expect(order.totalAgorot).toBe(5_000);
    expect(order.storeSubtotals['test-store']!.deliveryMethod).toBe('pickup');
  });

  it('re-validates the delivery method: a spoofed/unavailable value falls back to the paid courier rate, never zeroing shipping', async () => {
    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      deliveryMethods: { 'test-store': 'free_lol' }, // not a real method
    }));
    const order = createOrder.mock.calls[0]![0] as { shippingAgorot: number; storeSubtotals: Record<string, { deliveryMethod?: string }> };
    expect(order.shippingAgorot).toBe(3_000);
    expect(order.storeSubtotals['test-store']!.deliveryMethod).toBe('courier');
  });

  it('does not offer self-pickup when the store has no address, even if the flag is set', async () => {
    STORES['test-store']!.address = undefined;
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
        deliveryMethods: { 'test-store': 'pickup' }, // unavailable without an address
      }));
      const order = createOrder.mock.calls[0]![0] as { shippingAgorot: number };
      expect(order.shippingAgorot).toBe(3_000); // falls back to courier
    } finally {
      STORES['test-store']!.address = 'Herzl 1, Tel Aviv';
    }
  });

  it('rejects an unknown product instead of trusting client-supplied item data', async () => {
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'does-not-exist', qty: 1 }],
    }));
    expect(res.status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('rejects checkout for an admin-blocked store instead of trusting the item as purchasable', async () => {
    STORES['test-store']!.blocked = true;
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      delete STORES['test-store']!.blocked;
    }
  });

  // The seller's own halt is a MONEY gate, not a UI state: a shopper whose cart was filled before
  // the pause — or who calls this route directly — must not be able to buy from a store that has
  // stopped selling. Each state gets its own case rather than one loop, because they reach the
  // gate by different flags and a single shared assertion would hide one of them going stale.
  it('rejects checkout from a store its seller paused', async () => {
    STORES['test-store']!.pausedAt = '2026-07-31T10:00:00.000Z';
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      delete STORES['test-store']!.pausedAt;
    }
  });

  it('rejects checkout from a store waiting to close', async () => {
    STORES['test-store']!.closePendingAt = '2026-07-31T10:00:00.000Z';
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      delete STORES['test-store']!.closePendingAt;
    }
  });

  it('rejects checkout from a closed store', async () => {
    STORES['test-store']!.closedAt = '2026-07-31T10:00:00.000Z';
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      delete STORES['test-store']!.closedAt;
    }
  });

  it('refuses checkout from a showcase (demo) store — server-side, not by hiding a button', async () => {
    // The cart deliberately WORKS for a demo store; only this irreversible step is
    // refused, and it has to be refused here because the cart is client state and
    // this endpoint is directly callable (see lib/demo-stores.ts).
    STORES['test-store']!.demo = true;
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'demo-store' });
      expect(createOrder).not.toHaveBeenCalled();
      // Refused BEFORE any stock is touched — the guard is a pre-pass, so there is
      // nothing to roll back and no window where a demo "sale" moved inventory.
      expect(decrementStock).not.toHaveBeenCalled();
      expect(restockProduct).not.toHaveBeenCalled();
    } finally {
      delete STORES['test-store']!.demo;
    }
  });

  it('refuses the WHOLE cart when only one of its stores is a showcase store', async () => {
    // Otherwise a mixed cart would silently part-charge, and the demo items would
    // land in a real order.
    STORES['demo-store'] = { id: 's2', slug: 'demo-store', name: 'Showcase', sellerId: 'seller-2', demo: true };
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [
          { storeSlug: 'test-store', productSlug: 'widget', qty: 1 },
          { storeSlug: 'demo-store', productSlug: 'widget', qty: 1 },
        ],
      }));
      expect(res.status).toBe(403);
      expect(createOrder).not.toHaveBeenCalled();
      expect(decrementStock).not.toHaveBeenCalled();
    } finally {
      delete STORES['demo-store'];
    }
  });

  it('refuses checkout when the logged-in seller owns the store he is buying from', async () => {
    // A seller browsing his own storefront sees live buy buttons. Completing the purchase
    // would create a real order — stock, commission, mail, the units behind the
    // popular/bestseller ad label, and the first sale that starts his monthly fee. The
    // storefront also refuses it client-side, but this endpoint is the guarantee.
    getSellerSession.mockReturnValue('seller-1'); // STORES['test-store'].sellerId
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'own-store' });
    expect(createOrder).not.toHaveBeenCalled();
    // Pre-pass, like the demo guard — no stock moved, so nothing to roll back.
    expect(decrementStock).not.toHaveBeenCalled();
    expect(restockProduct).not.toHaveBeenCalled();
  });

  it('refuses a SIGNED-OUT seller buying from his own store, matched on the email he typed', async () => {
    // The likeliest version of the problem, and the one the session guard could never see: a
    // seller testing his own checkout does it from a phone or a private window. He is the person
    // for whom an accidental first sale is most expensive — under the pricing model it starts his
    // monthly fee — and he is signed out at exactly that moment.
    SELLER_ACCOUNTS[validBuyer.buyerEmail] = { id: 'seller-1', email: validBuyer.buyerEmail };
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'own-store' });
    expect(createOrder).not.toHaveBeenCalled();
    expect(decrementStock).not.toHaveBeenCalled();
  });

  it('matches that address case-insensitively', async () => {
    // `A@x.com` vs `a@x.com` is the whole bypass, and it costs one lowercase to close.
    SELLER_ACCOUNTS[validBuyer.buyerEmail] = { id: 'seller-1', email: validBuyer.buyerEmail };
    const res = await POST(makeContext({
      ...validBuyer,
      buyerEmail: validBuyer.buyerEmail.toUpperCase(),
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(res.status).toBe(403);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("still lets a seller buy from somebody ELSE's store", async () => {
    // The rule is about his own store, not about sellers shopping. Getting this wrong would turn
    // every registered business on the platform into someone who cannot buy anything here.
    STORES['other-store'] = { id: 's4', slug: 'other-store', name: 'Other', sellerId: 'seller-9', publishedAt: LIVE };
    SELLER_ACCOUNTS[validBuyer.buyerEmail] = { id: 'seller-1', email: validBuyer.buyerEmail };
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'other-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(201);
      expect(createOrder).toHaveBeenCalled();
    } finally {
      delete STORES['other-store'];
    }
  });

  it('lets an ordinary guest through — the lookup finds no account', async () => {
    // The common case, asserted so the guard cannot quietly become "nobody may check out".
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(res.status).toBe(201);
    expect(createOrder).toHaveBeenCalled();
  });

  it('refuses the WHOLE cart when only one of its stores belongs to the logged-in seller', async () => {
    // Otherwise the self-dealt item would ride along inside an otherwise legitimate order.
    STORES['other-store'] = { id: 's3', slug: 'other-store', name: 'Other', sellerId: 'seller-9', publishedAt: LIVE };
    getSellerSession.mockReturnValue('seller-1');
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [
          { storeSlug: 'other-store', productSlug: 'widget', qty: 1 },
          { storeSlug: 'test-store', productSlug: 'widget', qty: 1 },
        ],
      }));
      expect(res.status).toBe(403);
      expect(createOrder).not.toHaveBeenCalled();
      expect(decrementStock).not.toHaveBeenCalled();
    } finally {
      delete STORES['other-store'];
    }
  });

  it('lets a logged-in seller buy from a store he does NOT own', async () => {
    // The block is self-dealing, not "sellers may not shop" — a seller is a buyer
    // everywhere else in the mall.
    STORES['other-store'] = { id: 's3', slug: 'other-store', name: 'Other', sellerId: 'seller-9', publishedAt: LIVE };
    getSellerSession.mockReturnValue('seller-1');
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'other-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(201);
      expect(createOrder).toHaveBeenCalled();
    } finally {
      delete STORES['other-store'];
    }
  });

  it('rejects checkout for an admin-blocked product even when its store is fine', async () => {
    PRODUCTS.widget!.blocked = true;
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      delete PRODUCTS.widget!.blocked;
    }
  });

  it('rejects checkout for a seller-hidden product (the take-down switch keeps it off checkout too)', async () => {
    PRODUCTS.widget!.hidden = true;
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      delete PRODUCTS.widget!.hidden;
    }
  });

  it('rolls back stock already reserved for an earlier item when a later item turns out to be blocked', async () => {
    PRODUCTS.gadget = { id: 'p2', slug: 'gadget', name: 'Gadget', price: 10, stock: 100, blocked: true };
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [
          { storeSlug: 'test-store', productSlug: 'widget', qty: 1 },
          { storeSlug: 'test-store', productSlug: 'gadget', qty: 1 },
        ],
      }));
      expect(res.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
      // widget (the first, valid item) already had stock reserved before the
      // second item's blocked-check failed — that reservation must be undone.
      expect(restockProduct).toHaveBeenCalledWith('p1', 1, undefined);
    } finally {
      delete PRODUCTS.gadget;
    }
  });

  it('rejects checkout with an empty cart', async () => {
    const res = await POST(makeContext({ ...validBuyer, items: [] }));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid buyer email', async () => {
    const res = await POST(makeContext({
      ...validBuyer,
      buyerEmail: 'not-an-email',
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(res.status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('rejects a zero or negative quantity instead of silently clamping it', async () => {
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 0 }],
    }));
    expect(res.status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('notifies the correct seller for the store that owns the order', async () => {
    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'seller-1', type: 'new_order' })
    );
  });

  it('decrements stock for each purchased item by its checkout qty', async () => {
    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 3 }],
    }));
    expect(decrementStock).toHaveBeenCalledWith('p1', 3, undefined);
  });

  it('rejects checkout and creates no order when stock is insufficient', async () => {
    decrementStock.mockResolvedValueOnce({ ok: false, before: 1, after: 1 });
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(res.status).toBe(409);
    expect(createOrder).not.toHaveBeenCalled();
  });

  // The buyer's page can only correct itself — clamp the quantity, drop a sold-out line, name the
  // product — from these fields. Without them the refusal degrades to a generic "try again" that
  // walks the buyer into the identical refusal forever, so the payload's shape is the contract.
  it('reports WHICH line ran out and how many units are really left, as a machine-readable code', async () => {
    decrementStock.mockResolvedValueOnce({ ok: false, before: 2, after: 2 });
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 5 }],
    }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'out-of-stock',
      outOfStock: { storeSlug: 'test-store', productSlug: 'widget', productName: 'Widget', available: 2 },
    });
  });

  it('names the exact variant combo that ran out, so a multi-variant line is corrected and not the whole product', async () => {
    decrementStock.mockResolvedValueOnce({ ok: false, before: 0, after: 0 });
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'tee', qty: 1, selectedVariants: { color: 'red' } }],
    }));
    const body = await res.json() as { outOfStock: { available: number; selectedVariants?: Record<string, string> } };
    expect(body.outOfStock.selectedVariants).toEqual({ color: 'red' });
    expect(body.outOfStock.available).toBe(0);
  });

  /**
   * The route half of the 2026-08-12 area-audit finding. A selection the product does not declare
   * used to reach `decrementStock`, where "no bucket matched" legitimately means "sell from the
   * shared pool" — and on a product whose combos are all counted, that pool is the SUM of every
   * bucket. So the invented selection bought against the total. **Nothing may be decremented on
   * the way to finding that out**, which is why each case asserts the mock was never called.
   */
  describe('a variant selection the product does not declare', () => {
    const cases: [string, unknown, string][] = [
      ['an option that does not exist',        { color: 'purple' }, 'tee'],
      ['a dimension that does not exist',      { material: 'wool' }, 'tee'],
      ['only some of the dimensions',          { Size: 'L' }, 'hoodie'],
      ['no selection at all on a variant product', undefined, 'tee'],
      ['a selection on a product with none',   { color: 'red' }, 'widget'],
      ['a value that is not a string',         { color: ['red'] }, 'tee'],
    ];
    for (const [name, selectedVariants, productSlug] of cases) {
      it(`is refused, and nothing is decremented: ${name}`, async () => {
        const res = await POST(makeContext({
          ...validBuyer,
          items: [{ storeSlug: 'test-store', productSlug, qty: 1, ...(selectedVariants ? { selectedVariants } : {}) }],
        }));
        expect(res.status).toBe(400);
        expect(await res.json() as Record<string, unknown>).toMatchObject({ error: 'variant-mismatch' });
        expect(decrementStock).not.toHaveBeenCalled();
      });
    }

    it('the buyer\'s spelling is replaced by the product\'s, so one combo cannot mint two keys', async () => {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'tee', qty: 1, selectedVariants: { color: ' red ' } }],
      }));
      expect(decrementStock).toHaveBeenCalledWith('p3', 1, { color: 'red' });
    });
  });

  it('notifies the seller once stock crosses the low-stock threshold', async () => {
    PRODUCTS.widget!.stock = 5; // 5 - 3 = 2, at/below LOW_STOCK_THRESHOLD (3)
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 3 }],
      }));
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'seller-1', type: 'low_stock', relatedId: 'p1' })
      );
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('separately notifies the seller when a purchase fully depletes stock', async () => {
    PRODUCTS.widget!.stock = 2;
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 2 }],
      }));
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'seller-1', type: 'out_of_stock', relatedId: 'p1' })
      );
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('names the specific variant combo in the alert body, not just the product', async () => {
    PRODUCTS.hoodie!.stock = 5;
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'hoodie', qty: 3, selectedVariants: { Size: 'L', Color: 'Red' } }],
      }));
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'low_stock', body: expect.stringContaining('Size: L, Color: Red') })
      );
    } finally {
      PRODUCTS.hoodie!.stock = 100;
    }
  });

  it('leaves the alert body as just the product name when no variant was selected', async () => {
    PRODUCTS.widget!.stock = 5;
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 3 }],
      }));
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'low_stock', body: expect.stringContaining('"Widget"') })
      );
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('fires only the more severe out-of-stock alert (not also low-stock) when a single order does both in one shot', async () => {
    PRODUCTS.widget!.stock = 5; // 5 -> 0: crosses the low-stock threshold AND fully depletes
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 5 }],
      }));
      expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'out_of_stock' }));
      expect(createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'low_stock' }));
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('does not send an out-of-stock alert for a purchase that leaves some stock remaining', async () => {
    PRODUCTS.widget!.stock = 5;
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'out_of_stock' }));
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('does not send a low-stock alert for a purchase that stays above the threshold', async () => {
    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }], // 100 -> 99
    }));
    expect(createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'low_stock' }));
  });

  it('does not re-notify on a purchase that was already at/below the threshold before this order', async () => {
    PRODUCTS.widget!.stock = 2; // already below threshold — no new crossing
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'low_stock' }));
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('does not send a low-stock alert when the order that would trigger it fails to commit', async () => {
    PRODUCTS.widget!.stock = 5;
    createOrder.mockImplementationOnce(() => { throw new Error('disk write failed'); });
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 3 }],
      }));
      expect(createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'low_stock' }));
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('rolls back stock already reserved for earlier items when a later item is out of stock', async () => {
    PRODUCTS.gadget = { id: 'p2', slug: 'gadget', name: 'Gadget', price: 10, stock: 100 };
    try {
      decrementStock
        .mockResolvedValueOnce({ ok: true, before: 100, after: 99 })
        .mockResolvedValueOnce({ ok: false, before: 100, after: 100 });
      const res = await POST(makeContext({
        ...validBuyer,
        items: [
          { storeSlug: 'test-store', productSlug: 'widget', qty: 1 },
          { storeSlug: 'test-store', productSlug: 'gadget', qty: 1 },
        ],
      }));
      expect(res.status).toBe(409);
      expect(restockProduct).toHaveBeenCalledWith('p1', 1, undefined);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      delete PRODUCTS.gadget;
    }
  });

  it('rolls back all reserved stock and returns 500 if order creation fails after stock was already reserved', async () => {
    createOrder.mockImplementationOnce(() => { throw new Error('disk write failed'); });
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 2 }],
    }));
    expect(res.status).toBe(500);
    expect(restockProduct).toHaveBeenCalledWith('p1', 2, undefined);
  });

  it('for a signed-in buyer, stamps buyerId and deletes only the purchased LINES from their cart', async () => {
    getSellerSession.mockReturnValue('buyer-1');

    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));

    const order = createOrder.mock.calls[0]![0] as { buyerId?: string };
    expect(order.buyerId).toBe('buyer-1');
    // The buyer's other state is not an argument any more, which is the whole change: the shape
    // this replaced had to read the cart, rebuild it, and hand back the wishlist and saved stores
    // with it — and the field it forgot to hand back (`recentStores`) was emptied by every purchase.
    expect(removeCartLines).toHaveBeenCalledWith('buyer-1', [{ storeSlug: 'test-store', cartKey: 'widget' }]);
  });

  it('names the variant line, not the bare product slug, when the purchase carried variants', async () => {
    getSellerSession.mockReturnValue('buyer-1');
    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'tee', qty: 1, selectedVariants: { color: 'red' } }],
    }));
    const [, lines] = removeCartLines.mock.calls.at(-1)!;
    // makeCartKey's format — a delete keyed by the bare slug would leave the bought line in the
    // cart and, worse, would match a DIFFERENT line of the same product in another variant.
    expect((lines as { cartKey: string }[])[0]!.cartKey).toBe('tee__color=red');
  });

  it('does not touch the cart for a guest', async () => {
    getSellerSession.mockReturnValue(null);
    await POST(makeContext({ ...validBuyer, items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }] }));
    expect(removeCartLines).not.toHaveBeenCalled();
  });

  it('still returns the order when clearing the cart fails, and LOGS why', async () => {
    getSellerSession.mockReturnValue('buyer-1');
    removeCartLines.mockRejectedValueOnce(new Error('connection terminated'));

    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));

    // A post-commit step that throws must not tell the buyer their paid order failed — but the
    // answer is the outer handler's `if (committed) return 201`, NOT a `.catch()` at this call.
    // A local catch would produce the same status and destroy the only record that it happened;
    // the error log's hint names this exact step for whoever reads it.
    expect(res.status).toBe(201);
    expect(removeCartLines).toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({
      route: '/api/checkout',
      resolutionHint: expect.stringContaining('ההזמנה נוצרה והתשלום עבר'),
    }));
  });
});

describe('a declined payment leaves nothing behind', () => {
  // Until the mock provider learned to decline (MOCK_DECLINE_MARKER in lib/payment.ts)
  // this entire branch had never executed outside a unit test — the provider approved
  // every charge, so the rollback ran only in production, on the worst day, untried.
  const declineBuyer = { ...validBuyer, buyerEmail: 'dana+decline@example.com' };

  it('refuses the checkout with the gateway\'s reason', async () => {
    const res = await POST(makeContext({
      ...declineBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 2 }],
    }));
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error?: string }).error).toMatch(/נדחה/);
  });

  it('creates no order at all', async () => {
    // The rule the reports depend on: a failed charge must not leave a row that any
    // revenue sum could later pick up.
    await POST(makeContext({
      ...declineBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 2 }],
    }));
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('returns every reserved unit to stock', async () => {
    // Stock is decremented item-by-item as the cart validates, BEFORE the charge.
    // A decline that skipped this would quietly remove inventory that was never sold.
    await POST(makeContext({
      ...declineBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 2 }],
    }));
    expect(restockProduct).toHaveBeenCalledWith('p1', 2, undefined);
  });

  it('releases the idempotency claim so the buyer can retry immediately', async () => {
    // A declined card is the one case where the buyer SHOULD press pay again. Holding
    // the claim would make our own double-charge guard block the legitimate retry
    // until its TTL expired.
    const key = 'test-key-decline-retry-0001';
    const declined = await POST(makeContext({
      ...declineBuyer, idempotencyKey: key,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(declined.status).toBe(402);

    // Same key, good card: must go through rather than 409 or replay the failure.
    const retried = await POST(makeContext({
      ...validBuyer, idempotencyKey: key,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(retried.status).toBe(201);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it('the decline trigger is a dev affordance, not a production one', async () => {
    // A production build must never be one crafted email away from a free "declined"
    // checkout. The marker is gated on import.meta.env.DEV.
    const { MOCK_DECLINE_MARKER } = await import('../src/lib/payment.js');
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/lib/payment.ts', import.meta.url), 'utf8'));
    expect(src).toContain('import.meta.env.DEV');
    expect(declineBuyer.buyerEmail).toContain(MOCK_DECLINE_MARKER);
  });
});

describe('a completed idempotency key belongs to the buyer who completed it', () => {
  it('replays to that buyer, and refuses anyone else the order references', async () => {
    // The replay response hands back orderIds and checkoutRef. Keyed on nothing but the key, it
    // would hand them to whoever presented one — so the key alone would authorise reading another
    // buyer's order references.
    const key = 'test-key-owner-binding-001';
    const first = await POST(makeContext({
      ...validBuyer, idempotencyKey: key,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(first.status).toBe(201);

    // Same buyer, same key: the lost-response retry still works.
    const retry = await POST(makeContext({
      ...validBuyer, idempotencyKey: key,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(retry.status).toBe(200);
    expect((await retry.json() as { replayed?: boolean }).replayed).toBe(true);

    // Someone else with the same key: refused, and the body carries no orders or ref.
    const other = await POST(makeContext({
      ...validBuyer, buyerEmail: 'someone.else@example.com', idempotencyKey: key,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(other.status).toBe(409);
    const body = await other.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('orderIds');
    expect(body).not.toHaveProperty('checkoutRef');

    // And the refusal charged nothing and created nothing.
    expect(createOrder).toHaveBeenCalledTimes(1);
  });
});
