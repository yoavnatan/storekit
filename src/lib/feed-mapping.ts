import { CSV_FIELDS, BOM, toCsvCell, type CsvField } from './csv-bulk.js';

// The whole point of this module: a store that already manages its inventory somewhere else (a POS,
// an ERP, a Shopify/WooCommerce export, a plain spreadsheet) produces a feed whose columns are named
// however THAT system names them — `qty`, `item_code`, `Inventory on hand` — not our canonical keys.
// This is the translator. It guesses which source column feeds each of our fields, lets the seller
// correct the guess once (the correction is saved per-store), then rewrites the arbitrary feed into
// our canonical CSV so the existing bulk-import pipeline (validation, spam gate, variant grouping,
// sku-matching) consumes it completely unchanged. Pure — no fs, no Node built-ins — so it runs both
// client-side (the mapping UI's live preview) and server-side (the "sync now" URL pull).

export type MappableKey = CsvField['key'];

/** Common header names each canonical field shows up under in external systems / spreadsheets,
 *  Hebrew + English, lowercased. Order matters only within a key (first listed is the canonical one
 *  for display); across keys a header resolves to whichever key claims it. Deliberately generous —
 *  a wrong guess costs the seller one dropdown change, a missing guess costs them a manual pick. */
const SYNONYMS: Array<[MappableKey, string[]]> = [
  ['id',           ['id', 'uuid', 'product id', 'productid', 'internal id', 'מזהה']],
  ['sku',          ['sku', 'item code', 'itemcode', 'item_code', 'item number', 'item no', 'item', 'barcode', 'mpn', 'catalog', 'catalog number', 'cat no', 'product code', 'מק"ט', 'מקט', 'מק״ט', 'ברקוד', 'קוד פריט', 'קטלוג']],
  ['name',         ['name', 'title', 'product name', 'product', 'item name', 'description short', 'שם', 'שם מוצר', 'שם פריט', 'כותרת', 'מוצר', 'פריט']],
  ['price',        ['price', 'cost', 'amount', 'unit price', 'sale price', 'retail price', 'מחיר', 'עלות', 'מחיר יחידה', 'מחיר מכירה']],
  ['stock',        ['stock', 'qty', 'quantity', 'inventory', 'in stock', 'instock', 'stock qty', 'available', 'availability', 'on hand', 'onhand', 'inventory on hand', 'units', 'מלאי', 'כמות', 'זמין', 'יחידות', 'מלאי זמין', 'כמות במלאי']],
  ['category',     ['category', 'type', 'department', 'product type', 'main category', 'קטגוריה', 'סוג', 'מחלקה', 'קטגוריה ראשית']],
  ['subcategory1', ['subcategory', 'subcategory 1', 'sub category', 'sub-category', 'subcategory1', 'תת קטגוריה', 'תת-קטגוריה', 'תת קטגוריה 1']],
  ['subcategory2', ['subcategory 2', 'sub category 2', 'subcategory2', 'תת קטגוריה 2', 'תת-קטגוריה 2']],
  ['tags',         ['tags', 'keywords', 'labels', 'tag', 'תגיות', 'תגית', 'מילות מפתח', 'תוויות']],
  ['description',  ['description', 'desc', 'details', 'long description', 'body', 'תיאור', 'פירוט', 'פרטים']],
  ['group',        ['group', 'variant group', 'item group', 'item_group_id', 'model', 'style', 'parent', 'קבוצה', 'קבוצת גרסאות', 'דגם', 'סגנון']],
  // Shopify/Matrixify export their variants as Option{1,2,3} Name / Value column pairs — match those
  // spellings so such a file maps with zero picks. (Our own canonical he/en labels auto-map too.)
  ['option1Name',  ['option1 name', 'option 1 name', 'option1name']],
  ['option1Value', ['option1 value', 'option 1 value', 'option1value', 'option1']],
  ['option2Name',  ['option2 name', 'option 2 name', 'option2name']],
  ['option2Value', ['option2 value', 'option 2 value', 'option2value', 'option2']],
  ['option3Name',  ['option3 name', 'option 3 name', 'option3name']],
  ['option3Value', ['option3 value', 'option 3 value', 'option3value', 'option3']],
];

/** Normalize a header the way both the synonym table and the saved-mapping lookup expect: strip the
 *  "required" asterisk and surrounding quotes, collapse whitespace, lowercase. */
export function normalizeHeader(h: string): string {
  return h.replace(/\*/g, '').replace(/["'`]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const SYNONYM_TO_KEY = new Map<string, MappableKey>();
for (const [key, names] of SYNONYMS) {
  for (const n of names) SYNONYM_TO_KEY.set(normalizeHeader(n), key);
}
// Our own canonical labels/keys are valid source headers too (so re-uploading OUR export, or a file
// a seller built from our template, auto-maps with zero picks).
for (const f of CSV_FIELDS) {
  SYNONYM_TO_KEY.set(normalizeHeader(f.he), f.key);
  SYNONYM_TO_KEY.set(normalizeHeader(f.en), f.key);
  SYNONYM_TO_KEY.set(normalizeHeader(f.key), f.key);
}

export interface MappingEntry {
  /** The exact header as it appears in the seller's file (shown verbatim in the UI). */
  source: string;
  /** Which of our fields it feeds, or null = "ignore this column". */
  key: MappableKey | null;
}

/** Guess a canonical field for each source header. A saved per-store mapping (keyed by the exact
 *  source header, or its normalized form) always wins over the synonym guess. Never maps two source
 *  columns to the same key — the first column claiming a key keeps it, later ones fall to null — so
 *  the transform stays strictly one-source-per-field. */
export function guessMapping(headers: string[], saved?: Record<string, MappableKey>): MappingEntry[] {
  const used = new Set<MappableKey>();
  return headers.map((source): MappingEntry => {
    const savedKey = saved?.[source] ?? saved?.[normalizeHeader(source)];
    let key: MappableKey | null = savedKey ?? SYNONYM_TO_KEY.get(normalizeHeader(source)) ?? null;
    if (key && used.has(key)) key = null;
    if (key) used.add(key);
    return { source, key };
  });
}

/**
 * The saved mapping and NOTHING else — the same shape, with the synonym guess removed.
 *
 * **Why the unattended pull cannot use `guessMapping` (2026-08-03, stage 4a).** The guess is correct
 * for a human: they see the result in a preview and confirm it before anything is written. A timer
 * sees nothing. And the saved record only lists the columns the seller mapped — a column they chose
 * to IGNORE is simply absent from it, indistinguishable from one that did not exist yet. So under
 * `guessMapping` the fallback fires for both, and the remote file gains a say it was never given:
 * a supplier adding a `Price` column to their export would have the platform start rewriting that
 * store's prices, every hour, with nobody in the loop. Same for a column the seller deliberately
 * ignored — it would come back on its own.
 *
 * A new column is a change for the seller to look at in the panel, not one a schedule adopts.
 */
export function confirmedMapping(headers: string[], saved?: Record<string, MappableKey>): MappingEntry[] {
  const used = new Set<MappableKey>();
  return headers.map((source): MappingEntry => {
    let key: MappableKey | null = saved?.[source] ?? saved?.[normalizeHeader(source)] ?? null;
    if (key && used.has(key)) key = null;
    if (key) used.add(key);
    return { source, key };
  });
}

export interface MappingStatus {
  mapped: MappableKey[];
  /** A matcher column — without it every row is treated as brand-new (creates duplicates on the next
   *  sync), so the UI warns when it's absent. */
  hasMatcher: boolean;
  /** The reason to sync at all — flagged (not blocked) if the feed carries no stock column. */
  hasStock: boolean;
}

export function mappingStatus(entries: MappingEntry[]): MappingStatus {
  const mapped = entries.map((e) => e.key).filter((k): k is MappableKey => !!k);
  const set = new Set(mapped);
  return { mapped, hasMatcher: set.has('sku') || set.has('id'), hasStock: set.has('stock') };
}

/** Serialize the seller-confirmed mapping to the compact `{ sourceHeader: key }` shape stored on the
 *  store record (ignored columns are omitted). */
export function mappingToRecord(entries: MappingEntry[]): Record<string, MappableKey> {
  const rec: Record<string, MappableKey> = {};
  for (const e of entries) if (e.key) rec[e.source] = e.key;
  return rec;
}

/** Rewrite arbitrary source rows into our canonical CSV — header row is the canonical keys (which
 *  csv-bulk.ts#mapHeader resolves directly), in CSV_FIELDS order, BOM-prefixed. A source column with
 *  key=null is dropped; a canonical field no source column feeds comes through blank, which the
 *  import pipeline already reads as "leave unchanged" on an update. This is the ONLY place the
 *  seller's column names touch our data — everything downstream sees a normal canonical file. */
export function buildCanonicalCsv(rows: string[][], entries: MappingEntry[]): string {
  const colForKey = new Map<MappableKey, number>();
  entries.forEach((e, idx) => { if (e.key && !colForKey.has(e.key)) colForKey.set(e.key, idx); });

  const header = CSV_FIELDS.map((f) => f.key);
  const body = rows.slice(1).map((cells) =>
    CSV_FIELDS.map((f) => {
      const srcIdx = colForKey.get(f.key);
      return srcIdx === undefined ? '' : (cells[srcIdx] ?? '');
    }),
  );
  return BOM + [header, ...body].map((r) => r.map(toCsvCell).join(',')).join('\r\n');
}
