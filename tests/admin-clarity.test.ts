import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The סשן ד׳ clarity pass, pinned.
 *
 * Every assertion here stands for a question the owner had to ASK about a screen — who wrote this,
 * what is "עמוד", is this handled, what is an אסמכתא, why is this filter still here. None of them is
 * a behaviour a unit test can drive: they are all "does the screen say the thing", and the failure
 * mode is a later edit quietly dropping the sentence and leaving the screen mute again.
 *
 * The admin inbox has TWO renderers of one row — the Astro panel and `insertThreadRow` in the poll
 * — and this repo has paid for that shape before (a guard added to one of them held until somebody
 * left the tab open). So each inbox assertion is made against BOTH files, deliberately.
 */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const panel = read('src/components/admin/AdminMessagesPanel.astro');
const poll = read('src/scripts/admin/admin-messages.ts');
const tabNav = read('src/scripts/admin/tab-nav.ts');
const footerCss = read('src/styles/components/footer.css');
const dashCss = read('src/styles/pages/dashboard.css');
const adminPage = read('src/pages/admin/index.astro');
const reconCard = read('src/components/admin/AdminReconciliationCard.astro');
const moneyLog = read('src/components/admin/AdminMoneyLogPanel.astro');
const contact = read('src/pages/contact.astro');

describe('admin inbox — who wrote it', () => {
  it('opens the thread with a "מי פנה" line, in both renderers', () => {
    expect(panel).toContain('מי פנה');
    expect(poll).toContain('מי פנה');
  });

  it('does not spend the clipped row cell on the address, in either renderer', () => {
    // `${seller.name} (${seller.email})` is what pushed the name itself past the ellipsis in a
    // 16%-wide fixed-layout column. The address belongs to the opened thread now.
    expect(panel).not.toContain('(${seller.email})');
    expect(poll).not.toContain('(${seller.email})');
  });

  it('shows the role badge in the row, in both renderers', () => {
    // The poll's row had no badge at all — so a thread that arrived while the tab was open said
    // nothing about whether a seller, a buyer or a stranger had written it, which is the one fact
    // that decides what to do about it.
    expect(panel).toContain('admin-badge admin-badge--muted');
    expect(poll).toContain('admin-badge admin-badge--muted');
  });

  it('never repeats the role in words next to the badge that already says it', () => {
    expect(panel).not.toContain("'אורח · ללא כתובת לחזרה'");
    expect(poll).not.toContain('${ROLE_WORD[partyRole]} · ללא כתובת לחזרה');
  });

  it('labels the captured page as a place the message was sent FROM, not as "עמוד"', () => {
    expect(panel).toContain('נשלח מהעמוד');
    expect(panel).not.toContain('__label">עמוד<');
  });
});

describe('admin inbox — "טופל" is visible from the list', () => {
  it('renders the mark in the summary row, in both renderers', () => {
    expect(panel).toContain('msg-handled-mark');
    expect(poll).toContain('msg-handled-mark');
  });

  it('repaints the mark and the row state when the button is toggled', () => {
    // The old handler wrote the new state onto `closest('[data-thread-id]')`, which is the button
    // itself — so the list never learned. It has to find the summary row.
    expect(poll).toContain('tr.msg-table__row[data-thread-id=');
    expect(poll).toMatch(/mark\.hidden = !body\.handled/);
  });

  it('gives the mark a colour of its own rather than borrowing the unread bar', () => {
    expect(read('src/styles/utilities/utils.css')).toContain('.msg-handled-mark');
  });
});

describe('admin tabs — a filter that can still find something', () => {
  it('removes the "new only" chip when its rows stop being new, unless it is the active filter', () => {
    expect(tabNav).toContain('newOnlyToggle.remove()');
    expect(tabNav).toContain("aria-pressed') === 'true'");
  });
});

describe('the tab strip is pinned on the admin dashboard too', () => {
  it('scopes the sticky rules to both dashboards from one declaration', () => {
    expect(dashCss).toContain('.admin-dash .dash-tabs');
    expect(dashCss).toContain('.admin-dash .dash-panel-head');
    // One rule, two scopes — not a copy. A second copy is how the two dashboards would drift on
    // where a bar ends, which is the seam this whole change is about.
    expect(dashCss).toMatch(/\.seller-dash \.dash-tabs,\s*\n\.admin-dash \.dash-tabs/);
  });

  it('carries the scope class and measures the real bar heights', () => {
    expect(adminPage).toContain('class="card admin-dash"');
    expect(adminPage).toContain('initStickyOffsets()');
  });

  it('keeps the measurement in a module the admin can import without the seller bundle', () => {
    const sticky = read('src/scripts/dashboard/sticky-offsets.ts');
    expect(sticky).toContain('--site-header-h');
    expect(sticky).toContain('--dash-tabs-h');
    // products.ts must not hold a second copy of it.
    expect(read('src/scripts/dashboard/products.ts')).toContain("export { initStickyOffsets } from './sticky-offsets.js'");
  });
});

describe('the footer on a phone', () => {
  it('wraps the link row and forbids a link from breaking mid-label', () => {
    expect(footerCss).toContain('.site-footer nav ul { flex-wrap: wrap');
    expect(footerCss).toContain('white-space: nowrap');
  });
});

describe('the money journal explains itself', () => {
  it('says what a discrepancy list IS, and why it has no "mark handled"', () => {
    expect(reconCard).toContain('מחושבת מחדש');
    // And it stays a READ-ONLY card: the one control this must never grow is a way to acknowledge
    // a disagreement between two independent calculations without changing the data. A `<button>`
    // appearing here is that control arriving, whatever it ends up being called.
    expect(reconCard).not.toMatch(/<button/);
  });

  it('names the checkout reference as a reference to a PAYMENT', () => {
    expect(moneyLog).toContain('אסמכתת תשלום');
    expect(read('src/lib/reconcile.ts')).toContain('אסמכתת תשלום');
    expect(read('src/components/admin/AdminMoneyLogToolbar.astro')).toContain('אסמכתת תשלום');
  });
});

describe('a fault report is filed, not answered', () => {
  const inquiries = read('src/lib/platform-inquiries.ts');
  const form = read('src/components/ReportForm.astro');
  const replyRoute = read('src/pages/api/admin/messages.ts');

  it('never links a fault report to the reporter\'s seller account', () => {
    // seller_id is the ONLY column putting a thread in a seller's own Messages tab, so this is
    // what keeps "the checkout page is broken" out of his inbox (owner, סשן ד׳).
    expect(inquiries).toContain("role === 'seller' && kind !== 'fault'");
  });

  it('routes the admin\'s reply by the ACCOUNT on the thread, not by the role', () => {
    // With the role as the test, a fault report from a seller would have called notifySeller with
    // an empty id — a notification row nobody can read.
    expect(replyRoute).toContain('const byEmail = !thread.sellerId');
    expect(replyRoute).not.toContain("thread.partyRole !== 'seller'");
    expect(panel).toContain('const byDashboard = !!sellerId');
    expect(poll).toContain('const byDashboard = !!sellerId');
  });

  it('says so on the form, before anything is typed, and again on the confirmation', () => {
    expect(form).toContain('report-kind-hint');
    expect(form).toContain('faultSentBody');
  });

  it('still offers a signed-in seller the fault-report form', () => {
    // The owner's line: *"רק שיהיה ברור שעדיין מוכר צריך להיות מסוגל לדווח על תקלה דרך צור קשר"*.
    // The form is rendered unconditionally — nothing about it is behind a session check.
    expect(contact).toMatch(/<ReportForm[^>]*\/>/);
    expect(contact).not.toMatch(/hasStore &&[^]*<ReportForm/);
  });
});

describe('the sticky offsets are measured on every tab, not only Products', () => {
  const sellerDash = read('src/pages/seller/dashboard.astro');
  it('runs at page load on the seller dashboard', () => {
    // It used to run only inside the products panel's loader, so every other tab pinned its title
    // 1.2px below the strip above it and the page scrolled through the slit.
    expect(sellerDash).toMatch(/initDashTabs\(\);[^]*?initStickyOffsets\(\);/);
  });
  it('never writes 0px for a bar that has not been opened yet', () => {
    // 0px is a value and beats the CSS fallback, which would pin the bar below it under the site
    // header until its panel is first shown.
    expect(read('src/scripts/dashboard/sticky-offsets.ts')).toContain('removeProperty');
  });
});

describe('leaving a tab counts when the keyboard does it', () => {
  it('tracks departures on dashtab:show, not on the tab button click', () => {
    // The arrow keys activate a tab without dispatching a click, so a keyboard user never left a
    // tab as far as the badge and the "new only" chip were concerned.
    expect(tabNav).toContain("document.addEventListener('dashtab:show'");
    expect(tabNav).not.toContain("tab.addEventListener('click'");
  });
});
