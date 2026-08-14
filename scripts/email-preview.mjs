/**
 * `npm run email:preview` — render every mail the platform can send, to files you open in a browser.
 *
 * The problem it solves: until now the only way to see what a Dezabin email looks like was to
 * provoke the event that sends one, with a provider key configured, and then go and read your inbox.
 * So nobody looked, and the mails were reviewed as source code — which is how the store-lifecycle
 * text part lost a sentence its HTML had (the comment in store-lifecycle-email.ts tells that story).
 * A mail is a designed surface; it has to be reviewable the way a page is.
 *
 * It renders through the SAME pure builders the app sends with — buildBuyerOrderConfirmation,
 * buildOrderStatusEmail, buildStoreLifecycleEmail, buildInvoiceReadyEmail, buildPasswordResetEmail,
 * renderAlertEmail. Nothing here re-implements any markup, which is the only way the preview can
 * stay honest as the mails change. If a builder starts returning null for a case, that case shows up
 * in the index as "no mail is sent", which is itself a decision worth being able to see.
 *
 * Nothing is sent and no key is needed. Loading .ts through Vite's SSR pipeline is what lets a plain
 * .mjs script call into src/ — the same transform Astro and Vitest already run on this code.
 */

import { createServer } from 'vite';
import { mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.email-preview');

// ── Demo data ────────────────────────────────────────────────────────────────
// Deliberately not the blandest possible values. Real Hebrew names, a variant, a two-digit quantity
// and a long product name are the inputs that expose an RTL or wrapping problem; "Test User" and
// "Item 1" pass every layout ever written.

/** Public Cloudinary demo assets. `cdnSrc` passes a remote URL straight through when no cloud name
 *  is configured (which is the normal state locally), so these render as-is. */
const IMG = (name) => `https://res.cloudinary.com/demo/image/upload/${name}`;

const ITEMS_A = [
  {
    productId: 'p1', productName: 'ספל קרמיקה בעבודת יד — גלזורה כחולה', productSlug: 'ceramic-mug',
    storeSlug: 'bet-hayotzrim', storeName: 'בית היוצרים', priceAgorot: 8900, qty: 2,
    image: IMG('sample.jpg'), selectedVariants: { צבע: 'כחול עמוק', גודל: 'גדול' },
  },
  {
    productId: 'p2', productName: 'צלחת הגשה', productSlug: 'serving-plate',
    storeSlug: 'bet-hayotzrim', storeName: 'בית היוצרים', priceAgorot: 14500, qty: 1,
    image: IMG('shoes.jpg'),
  },
];

const ITEMS_B = [
  {
    productId: 'p3', productName: 'תיק בד מודפס', productSlug: 'tote-bag',
    storeSlug: 'studio-lavan', storeName: 'סטודיו לבן', priceAgorot: 6500, qty: 12,
    image: IMG('bike.jpg'),
  },
];

const ITEMS_C = [
  {
    productId: 'p4', productName: 'נר סויה בניחוח וניל', productSlug: 'soy-candle',
    storeSlug: 'or-vashemesh', storeName: 'אור ושמש', priceAgorot: 4900, qty: 3,
  },
];

const BUYER = {
  buyerName: 'נועה בן־ארי',
  buyerEmail: 'noa.benari@gmail.com',
  buyerPhone: '052-4471903',
  buyerAddress: { city: 'תל אביב-יפו', street: 'רחוב שבזי 14, דירה 3', zip: '6581424' },
};

function order(id, items, extra = {}) {
  const subtotal = items.reduce((s, it) => s + it.priceAgorot * it.qty, 0);
  const shipping = extra.shippingAgorot ?? 3000;
  const slug = items[0].storeSlug;
  return {
    id,
    checkoutRef: 'DZ-7K42M9',
    ...BUYER,
    items,
    storeSubtotals: { [slug]: { storeName: items[0].storeName, subtotalAgorot: subtotal, shippingAgorot: shipping } },
    shippingAgorot: shipping,
    totalAgorot: subtotal + shipping,
    paymentStatus: 'paid',
    shippingStatus: 'processing',
    createdAt: '2026-08-14T09:12:00.000Z',
    updatedAt: '2026-08-14T09:12:00.000Z',
    ...extra,
  };
}

const ORDER_A = order('11111111-1111-4111-8111-111111111111', ITEMS_A);
const ORDER_B = order('22222222-2222-4222-8222-222222222222', ITEMS_B, { shippingAgorot: 0 });
const ORDER_C = order('33333333-3333-4333-8333-333333333333', ITEMS_C);

// ── The catalogue ────────────────────────────────────────────────────────────

/** Each entry: a title, who it goes to and when, and a builder returning an EmailMessage or null. */
function catalogue(m) {
  return [
    {
      group: 'הזמנות',
      title: 'אישור הזמנה — חנות אחת',
      when: 'לקונה, מיד אחרי צ׳קאאוט',
      build: () => m.orderEmails.buildBuyerOrderConfirmation([ORDER_A]),
    },
    {
      group: 'הזמנות',
      title: 'אישור הזמנה — כמה חנויות בסל',
      when: 'לקונה, מיד אחרי צ׳קאאוט. הפריטים מקובצים לפי חנות, ולכל חנות קישור משלה',
      build: () => m.orderEmails.buildBuyerOrderConfirmation([ORDER_A, ORDER_B, ORDER_C]),
    },
    {
      group: 'הזמנות',
      title: 'הזמנה חדשה — למוכר',
      when: 'למוכר, מיד אחרי צ׳קאאוט. תשובה על המייל הזה חוזרת לקונה',
      build: () => m.orderEmails.buildSellerOrderNotification(ORDER_A, 'shira@bet-hayotzrim.co.il'),
    },
    {
      group: 'סטטוס הזמנה',
      title: 'ההזמנה נשלחה — עם מספר מעקב',
      when: 'לקונה, כשהמוכר (או חברת השילוח) מסמן "נשלח"',
      build: () => m.status.buildOrderStatusEmail({ ...ORDER_A, trackingNumber: 'IL483920174' }, 'shipped'),
    },
    {
      group: 'סטטוס הזמנה',
      title: 'ההזמנה נשלחה — בלי מספר מעקב',
      when: 'אותו מייל, כשאין מספר מעקב',
      build: () => m.status.buildOrderStatusEmail(ORDER_A, 'shipped'),
    },
    {
      group: 'סטטוס הזמנה',
      title: 'ההזמנה בוטלה',
      when: 'לקונה, בביטול',
      build: () => m.status.buildOrderStatusEmail(ORDER_A, 'cancelled'),
    },
    {
      group: 'סטטוס הזמנה',
      title: 'ההזמנה מוכנה ("נארזה")',
      when: 'לא נשלח מייל — זו אבן דרך של המוכר, והקונה מקבל על זה התראה באתר בלבד',
      build: () => m.status.buildOrderStatusEmail(ORDER_A, 'ready'),
    },
    {
      group: 'חשבוניות',
      title: 'החשבונית שלך מוכנה',
      when: 'לקונה, כשהמוכר מעלה חשבונית להזמנה. קישור, לא קובץ מצורף',
      build: () => m.invoice.buildInvoiceReadyEmail({
        order: ORDER_A,
        documentUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
      }),
    },
    {
      group: 'חשבון ואבטחה',
      title: 'איפוס סיסמה',
      when: 'למוכר, כשביקש לאפס סיסמה. הקישור תקף לשעה ולשימוש אחד',
      build: () => m.passwordResetEmail.buildPasswordResetEmail({
        to: 'shira@bet-hayotzrim.co.il',
        sellerName: 'שירה כהן',
        // Through the real builder, so the preview shows the real origin rule rather than a
        // hand-written URL that could quietly disagree with it.
        resetUrl: m.passwordReset.passwordResetUrl('8f2c1d9e4b7a60335ea1c8d47b09f6a2'),
        expiresInMinutes: 60,
      }),
    },
    {
      group: 'החנות שלך',
      title: 'החנות הוקפאה — עם הזמנות פתוחות',
      when: 'למוכר, כשהקפיא את החנות בעצמו',
      build: () => m.lifecycle.buildStoreLifecycleEmail({
        to: 'shira@bet-hayotzrim.co.il', sellerName: 'שירה כהן',
        store: { name: 'בית היוצרים' }, state: 'paused', openOrders: 3,
      }),
    },
    {
      group: 'החנות שלך',
      title: 'בקשת סגירה — עם הזמנה פתוחה אחת',
      when: 'למוכר, כשביקש לסגור. נושא את החובה לסיים את ההזמנות שנותרו',
      build: () => m.lifecycle.buildStoreLifecycleEmail({
        to: 'shira@bet-hayotzrim.co.il', sellerName: 'שירה כהן',
        store: { name: 'בית היוצרים' }, state: 'closing', openOrders: 1,
      }),
    },
    {
      group: 'החנות שלך',
      title: 'החנות חזרה לפעילות',
      when: 'למוכר, בהחזרה מהקפאה. מזהיר שהקמפיינים לא חוזרים לבד',
      build: () => m.lifecycle.buildStoreLifecycleEmail({
        to: 'shira@bet-hayotzrim.co.il', sellerName: 'שירה כהן',
        store: { name: 'בית היוצרים' }, state: 'active', openOrders: 0,
      }),
    },
    {
      group: 'החנות שלך',
      title: 'החנות נסגרה',
      when: 'למוכר, כשהסגירה הושלמה בפועל',
      build: () => m.lifecycle.buildStoreLifecycleEmail({
        to: 'shira@bet-hayotzrim.co.il', sellerName: 'שירה כהן',
        store: { name: 'בית היוצרים' }, state: 'closed', openOrders: 0,
      }),
    },
    {
      group: 'אליך בלבד',
      title: 'התראת שגיאה קריטית',
      when: `ל-ALERT_EMAIL, כששגיאה קריטית נרשמת. לכל היותר אחת ל-15 דקות לכל נתיב`,
      build: () => {
        const { subject, html, text } = m.alert.renderAlertEmail({
          id: '9c1e7a04-3b52-4f18-9d6a-2e4c8b501f77',
          severity: 'critical',
          createdAt: '2026-08-14T09:41:17.000Z',
          route: '/api/checkout',
          message: 'Payment capture returned 502 from provider after authorize succeeded',
          stack: 'Error: capture failed\n    at captureSale (src/lib/payment.ts:184:11)\n    at async POST (src/pages/api/checkout.ts:640:5)',
          storeName: 'בית היוצרים',
          actorLabel: 'noa.benari@gmail.com',
          statusCode: 502,
        });
        return { to: 'you@example.com', subject, html, text };
      },
    },
  ];
}

// ── Rendering ────────────────────────────────────────────────────────────────

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Point the logo at the copy sitting beside the output instead of at the live site, so the header
 *  renders before the domain exists. Everything else keeps its real absolute URL — hovering a link
 *  should show where it will actually go in production. */
function localiseLogo(html, siteUrl) {
  return html.split(`${siteUrl}/logo-email.png`).join('logo-email.png');
}

function card(entry, index) {
  const file = `mail-${String(index).padStart(2, '0')}.html`;
  const meta = entry.message
    ? `<dl class="meta">
        <div><dt>נושא</dt><dd dir="auto">${escAttr(entry.message.subject)}</dd></div>
        <div><dt>אל</dt><dd dir="ltr">${escAttr(entry.message.to)}</dd></div>
        <div><dt>תשובה חוזרת אל</dt><dd dir="ltr">${escAttr(entry.replyTo)}</dd></div>
      </dl>`
    : `<p class="none">אין מייל במקרה הזה — הבנאי מחזיר null בכוונה.</p>`;

  const frames = entry.message
    ? `<div class="frames">
        <figure><figcaption>טלפון · 375px</figcaption><iframe src="${file}" style="width:375px;height:760px"></iframe></figure>
        <figure><figcaption>מחשב · 700px</figcaption><iframe src="${file}" style="width:700px;height:760px"></iframe></figure>
      </div>
      <details><summary>גרסת הטקסט (מה שרואה מי שחוסם HTML — וממנה מושפעת ההגעה לתיבה)</summary><pre dir="auto">${escAttr(entry.message.text)}</pre></details>`
    : '';

  return `<section class="mail" id="m${index}">
    <h3>${escAttr(entry.title)}</h3>
    <p class="when">${escAttr(entry.when)}</p>
    ${meta}
    ${frames}
  </section>`;
}

function indexPage(entries, siteUrl, defaultReplyTo) {
  const groups = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.name === e.group) last.items.push(e);
    else groups.push({ name: e.group, items: [e] });
  }
  const sent = entries.filter((e) => e.message).length;

  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>מיילים · תצוגה מקדימה</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:24px; background:#eef0f4; color:#1c2333;
         font-family:'Heebo',system-ui,-apple-system,'Segoe UI',Arial,sans-serif; line-height:1.6; }
  header { max-width:1140px; margin:0 auto 24px; }
  h1 { margin:0 0 6px; font-size:24px; }
  header p { margin:0 0 4px; color:#5a6478; font-size:14px; }
  nav { max-width:1140px; margin:0 auto 28px; display:flex; flex-wrap:wrap; gap:8px; }
  nav a { background:#fff; border:1px solid #d8dce4; border-radius:999px; padding:5px 12px;
          font-size:13px; text-decoration:none; color:#2a3547; }
  h2 { max-width:1140px; margin:36px auto 12px; font-size:15px; letter-spacing:.04em;
       text-transform:none; color:#5a6478; border-bottom:1px solid #d8dce4; padding-bottom:6px; }
  .mail { max-width:1140px; margin:0 auto 20px; background:#fff; border:1px solid #d8dce4;
          border-radius:14px; padding:20px; }
  .mail h3 { margin:0 0 2px; font-size:18px; }
  .when { margin:0 0 14px; color:#5a6478; font-size:13px; }
  .meta { margin:0 0 14px; padding:12px 14px; background:#f7f8fa; border-radius:10px; font-size:13px; }
  .meta div { display:flex; gap:10px; padding:2px 0; }
  .meta dt { flex:0 0 130px; color:#5a6478; margin:0; }
  .meta dd { margin:0; word-break:break-word; }
  .none { margin:0; padding:12px 14px; background:#f7f8fa; border-radius:10px;
          font-size:14px; color:#5a6478; }
  .frames { display:flex; flex-wrap:wrap; gap:18px; align-items:flex-start; }
  figure { margin:0; }
  figcaption { font-size:12px; color:#5a6478; margin-bottom:6px; }
  iframe { border:1px solid #d8dce4; border-radius:10px; background:#fff; max-width:100%; }
  details { margin-top:14px; }
  summary { cursor:pointer; font-size:13px; color:#4870c0; }
  pre { margin:10px 0 0; padding:12px; background:#f7f8fa; border:1px solid #e2e5eb;
        border-radius:8px; font-size:12px; white-space:pre-wrap; word-break:break-word; }
</style></head><body>
<header>
  <h1>כל המיילים של דזבין</h1>
  <p>${sent} מיילים נשלחים בפועל, מתוך ${entries.length} מצבים. כל אחד מוצג פעמיים — במסך טלפון ובמסך מחשב.</p>
  <p>הלוגו כאן נטען מהקובץ שליד; הקישורים בתוך המיילים מצביעים על <code dir="ltr">${escAttr(siteUrl)}</code> האמיתי, כך שאפשר לרחף עליהם ולראות לאן הם ילכו.</p>
  <p>תשובה חוזרת מגיעה ל-<code dir="ltr">${escAttr(defaultReplyTo)}</code>, אלא אם כתוב אחרת בכרטיס.</p>
</header>
<nav>${entries.map((e, i) => `<a href="#m${i}">${escAttr(e.title)}</a>`).join('')}</nav>
${groups.map((g) => `<h2>${escAttr(g.name)}</h2>${g.items.map((e) => card(e, entries.indexOf(e))).join('')}`).join('')}
</body></html>`;
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });

  let entries;
  let siteUrl;
  let defaultReplyTo;
  try {
    const load = (p) => server.ssrLoadModule(p);
    const m = {
      orderEmails: await load('/src/lib/email/order-emails.ts'),
      status: await load('/src/lib/email/order-status-email.ts'),
      lifecycle: await load('/src/lib/email/store-lifecycle-email.ts'),
      invoice: await load('/src/lib/email/invoice-email.ts'),
      passwordResetEmail: await load('/src/lib/email/password-reset-email.ts'),
      passwordReset: await load('/src/lib/password-reset.ts'),
      alert: await load('/src/lib/critical-alert.ts'),
      parts: await load('/src/lib/email/parts.ts'),
    };
    const { store } = await load('/src/config/store.config.ts');
    siteUrl = store.url.replace(/\/$/, '');
    defaultReplyTo = store.business.email;

    entries = catalogue(m).map((e) => {
      const message = e.build();
      return { ...e, message, replyTo: message?.replyTo ?? `${defaultReplyTo} (ברירת מחדל)` };
    });
  } finally {
    await server.close();
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await copyFile(path.join(ROOT, 'public', 'logo-email.png'), path.join(OUT, 'logo-email.png'));

  await Promise.all(entries.map((e, i) => e.message
    ? writeFile(path.join(OUT, `mail-${String(i).padStart(2, '0')}.html`), localiseLogo(e.message.html, siteUrl))
    : Promise.resolve()));

  await writeFile(path.join(OUT, 'index.html'), indexPage(entries, siteUrl, defaultReplyTo));

  const sent = entries.filter((e) => e.message).length;
  console.log(`\n${sent} מיילים נכתבו (מתוך ${entries.length} מצבים). לפתיחה:\n`);
  console.log(`  open ${path.relative(process.cwd(), path.join(OUT, 'index.html'))}\n`);
}

await main();
