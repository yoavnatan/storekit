import { BOM, toCsvCell } from './csv-bulk.js';
import { fromAgorot } from './money.js';
import type { PlatformStatement } from './platform-statement.js';

/**
 * The statement as a file the accountant opens.
 *
 * Same three load-bearing details as `seller-reports-csv.ts`, for the same reasons its header
 * argues at length: a `BOM` so Excel reads Hebrew, `\r\n` endings, and money as a plain decimal so
 * the column can be summed rather than read.
 *
 * **`sanitizeCsvCell` is not used here and that is not an oversight.** Every cell in this document
 * is a label this file writes or a number this codebase computed — no seller, buyer or admin ever
 * typed a character of it. The sanitizer exists for cells carrying text a PERSON entered, which is
 * where the spreadsheet-formula injection route is; adding it to constants would be cargo cult and
 * would suggest, wrongly, that some of these strings are untrusted. The moment a per-seller
 * breakdown lands here (it is deliberately not built — the owner rejected line-by-line detail as
 * overload) every name in it needs it.
 *
 * **Three columns, not two.** A statement is `section, line, amount`, so the section column is what
 * lets the accountant filter the accrual rows away from the cash rows in their own sheet — which is
 * the entire point of having asked which basis each line is on.
 */

const money = (agorot: number): string => fromAgorot(agorot).toFixed(2);

// The same two sections the screen shows, under the same names — a reader comparing the file to
// the page must not have to work out which row is which.
const ACCRUAL = 'ההכנסה שלנו (בסיס צבירה)';
const CASH = 'תנועה בפועל — כספי מוכרים (בסיס מזומן)';

export function platformStatementCsv(s: PlatformStatement): string {
  const rows: (string | number)[][] = [
    ['סעיף', 'שורה', 'סכום בשקלים'],

    // Turnover leads the section as CONTEXT — it is what the commission is a percentage of, and it
    // is not the platform's money. The two rows after it are, and they are the ones that sum.
    [ACCRUAL, 'נמכר דרך הפלטפורמה (מחזור)', money(s.grossAgorot)],
    [ACCRUAL, 'מספר רכישות', s.purchases],
    [ACCRUAL, 'עמלת פלטפורמה שנצברה', money(s.commissionAccruedAgorot)],
    [ACCRUAL, 'דמי מנוי שנצברו', money(s.subscriptionsAccruedAgorot)],
    [ACCRUAL, 'סה"כ הכנסה שנצברה', money(s.incomeAccruedAgorot)],

    [CASH, 'יתרת פתיחה — כספי מוכרים בהחזקתנו', money(s.openingBalanceAgorot)],
    [CASH, 'נצבר למוכרים בתקופה', money(s.sellerEarnedAgorot)],
    [CASH, 'שולם למוכרים בתקופה', money(-s.paidOutAgorot)],
    [CASH, 'מספר תשלומים שבוצעו', s.payouts],
    [CASH, 'התאמות (זיכויים/חיובים חוזרים)', money(s.adjustmentsAgorot)],
    [CASH, 'יתרת סגירה — כספי מוכרים בהחזקתנו', money(s.closingBalanceAgorot)],
    [CASH, 'עמלה שנגבתה בפועל', money(s.commissionSettledAgorot)],

    // On the face of the document, not in a footnote: it is what makes two printings of the same
    // month explainable rather than alarming, and what stops the ad-margin gap being read as zero.
    ['הערות', 'תקופה', `${s.period.fromISO} — ${s.period.toISO}`],
    ['הערות', 'הופק בתאריך', s.generatedAtISO],
    ['הערות', 'מחושב מהנתונים החיים — ביטול הזמנה ישנה משנה גם תקופה שכבר הופקה', ''],
    ['הערות', 'הכנסות פרסום אינן כלולות — החיבור לגוגל/מטא טרם בוצע', ''],
    ['הערות', 'ללא מע"מ ובלי מספרי חשבונית — טרם נקבעו', ''],
  ];
  // `String(cell)` before the quoter: the count columns are numbers, and `toCsvCell` takes the
  // already-rendered text — a number arriving there would be quoted on nothing but chance.
  return BOM + rows.map((r) => r.map((cell) => toCsvCell(String(cell))).join(',')).join('\r\n') + '\r\n';
}

/** `platform-statement-2026-08.csv`, or the two dates when the period is not a whole month. */
export function statementFileName(s: PlatformStatement): string {
  return `platform-statement-${s.period.monthKey ?? `${s.period.fromISO}_${s.period.toISO}`}.csv`;
}
