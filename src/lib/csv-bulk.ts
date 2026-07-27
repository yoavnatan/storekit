import { findSpamKeyword, findKeywordStuffing } from './spam-filter.js';

export interface CsvField {
  key: 'id' | 'sku' | 'name' | 'price' | 'stock' | 'category' | 'subcategory1' | 'subcategory2' | 'tags' | 'description' | 'group'
    | 'option1Name' | 'option1Value' | 'option2Name' | 'option2Value' | 'option3Name' | 'option3Value';
  he: string;
  en: string;
}

/** The three generic variant-dimension slots, paired name↔value — Shopify/Matrixify-style, so a
 *  product's variants export/import by any dimension (צבע, חומר, נפח…), not a fixed color/size. */
export const OPTION_SLOTS = [
  { name: 'option1Name', value: 'option1Value' },
  { name: 'option2Name', value: 'option2Value' },
  { name: 'option3Name', value: 'option3Value' },
] as const satisfies ReadonlyArray<{ name: CsvField['key']; value: CsvField['key'] }>;

// Three separate columns (not one "ביגוד > גברים" path string) — much easier for a seller to
// fill in a spreadsheet correctly than a delimiter syntax, and maps 1:1 onto MAX_CATEGORY_DEPTH.
// The trailing columns (group + the three option name/value pairs) are appended, never inserted
// mid-list, so a seller's older files (and every existing fixture) with only the first columns still
// import cleanly — missing trailing columns just read blank. Rows sharing a non-empty `group` merge
// into one product with variants; see variant-csv.ts#mergeVariantGroups. On those rows the `sku`/
// `stock` columns describe the individual combo (blue-L), not the product as a whole; each option
// pair carries one dimension of that combo (option1Name="צבע", option1Value="כחול").
export const CSV_FIELDS: CsvField[] = [
  { key: 'id',           he: 'מזהה (אל תשנה/תמחקי)', en: 'ID (do not edit/remove)' },
  { key: 'sku',          he: 'מק"ט',                  en: 'SKU' },
  { key: 'name',         he: 'שם *',                  en: 'Name *' },
  { key: 'price',        he: 'מחיר *',                en: 'Price *' },
  { key: 'stock',        he: 'מלאי',                  en: 'Stock' },
  { key: 'category',     he: 'קטגוריה',                en: 'Category' },
  { key: 'subcategory1', he: 'תת קטגוריה 1',          en: 'Subcategory 1' },
  { key: 'subcategory2', he: 'תת קטגוריה 2',          en: 'Subcategory 2' },
  { key: 'tags',         he: 'תגיות (מופרדות בפסיק)', en: 'Tags (comma-separated)' },
  { key: 'description',  he: 'תיאור',                  en: 'Description' },
  { key: 'group',        he: 'קבוצת גרסאות',          en: 'Variant group' },
  { key: 'option1Name',  he: 'שם גרסה 1',             en: 'Option 1 name' },
  { key: 'option1Value', he: 'ערך גרסה 1',            en: 'Option 1 value' },
  { key: 'option2Name',  he: 'שם גרסה 2',             en: 'Option 2 name' },
  { key: 'option2Value', he: 'ערך גרסה 2',            en: 'Option 2 value' },
  { key: 'option3Name',  he: 'שם גרסה 3',             en: 'Option 3 name' },
  { key: 'option3Value', he: 'ערך גרסה 3',            en: 'Option 3 value' },
];

export const BOM = '﻿';

/** Generous headroom above the feature's stated ~1000-product target — guards a single request against pathological/abusive file sizes. */
export const MAX_IMPORT_ROWS = 5000;

/** RFC4180-ish CSV parser: handles quoted fields, embedded commas/newlines, doubled-quote escaping, \r\n or \n. */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Excel/Sheets treats a cell starting with =, +, -, @, tab or CR as a formula — a product
 *  name/description round-tripped from the (unrestricted) product editor could otherwise
 *  execute arbitrary formulas for whoever opens the exported file. Standard OWASP mitigation:
 *  prefix with a literal quote so it's forced back to plain text. */
// Exported for store-products-bulk.ts's productsToCsv() — that function needs store-categories.ts
// (a Node-only module, fs/path) to resolve a product's category path, so it can't live in this
// file: csv-import.ts (the dashboard's client-side CSV preview) also imports from here, and
// bundling a Node-only import into the browser build crashes the whole page on load.
export function sanitizeCsvCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function toCsvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// A plain product leaves group + all option columns blank; a variant product is several rows sharing
// one `group` value, each carrying one combo with its own sku + stock, its dimensions spelled out in
// the option name/value pairs. The sweatshirt rows show a two-dimension product (צבע×מידה); the table
// rows show that a dimension can be ANYTHING (חומר) — not just color/size — so the format is
// self-documenting from the template alone.
// Columns: id, sku, name, price, stock, category, subcategory1, subcategory2, tags, description, group, option1Name, option1Value, option2Name, option2Value, option3Name, option3Value
const TEMPLATE_EXAMPLE_ROWS: Record<'he' | 'en', string[][]> = {
  he: [
    ['', '', 'חולצת כותנה קיץ', '89.9', '15', 'ביגוד', 'גברים', '', 'קיץ, מבצע', 'חולצת כותנה איכותית', '', '', '', '', '', '', ''],
    ['', 'SW-BL-L', 'סווטשירט', '129.9', '5', 'ביגוד', 'גברים', '', '', 'סווטשירט חמים', 'סווטשירט', 'צבע', 'כחול', 'מידה', 'L', '', ''],
    ['', 'SW-BL-S', 'סווטשירט', '129.9', '8', 'ביגוד', 'גברים', '', '', 'סווטשירט חמים', 'סווטשירט', 'צבע', 'כחול', 'מידה', 'S', '', ''],
    ['', 'SW-OR-L', 'סווטשירט', '129.9', '3', 'ביגוד', 'גברים', '', '', 'סווטשירט חמים', 'סווטשירט', 'צבע', 'כתום', 'מידה', 'L', '', ''],
    ['', 'TBL-W', 'שולחן', '450', '4', 'ריהוט', '', '', '', 'שולחן עץ מלא', 'שולחן', 'חומר', 'עץ', '', '', '', ''],
    ['', 'TBL-M', 'שולחן', '450', '2', 'ריהוט', '', '', '', 'שולחן עץ מלא', 'שולחן', 'חומר', 'מתכת', '', '', '', ''],
  ],
  en: [
    ['', '', 'Summer cotton shirt', '89.9', '15', 'Clothing', 'Men', '', 'summer, sale', 'High quality cotton shirt', '', '', '', '', '', '', ''],
    ['', 'SW-BL-L', 'Sweatshirt', '129.9', '5', 'Clothing', 'Men', '', '', 'Warm sweatshirt', 'sweatshirt', 'Color', 'Blue', 'Size', 'L', '', ''],
    ['', 'SW-BL-S', 'Sweatshirt', '129.9', '8', 'Clothing', 'Men', '', '', 'Warm sweatshirt', 'sweatshirt', 'Color', 'Blue', 'Size', 'S', '', ''],
    ['', 'SW-OR-L', 'Sweatshirt', '129.9', '3', 'Clothing', 'Men', '', '', 'Warm sweatshirt', 'sweatshirt', 'Color', 'Orange', 'Size', 'L', '', ''],
    ['', 'TBL-W', 'Table', '450', '4', 'Furniture', '', '', '', 'Solid wood table', 'table', 'Material', 'Wood', '', '', '', ''],
    ['', 'TBL-M', 'Table', '450', '2', 'Furniture', '', '', '', 'Solid wood table', 'table', 'Material', 'Metal', '', '', '', ''],
  ],
};

/** A fixed sample file (header + example rows) — always the same regardless of the store's own
 *  catalog, so a brand-new seller with zero products still has a concrete example of both the plain
 *  and the variant format to start from (productsToCsv below would give them just a bare header).
 *  Every example row's "id" column is blank, exactly like a real new-product row, so filling in
 *  real values and importing as-is works correctly (creates the products) rather than needing rows
 *  deleted first. */
export function templateCsv(lang: 'he' | 'en'): string {
  const header = CSV_FIELDS.map((f) => toCsvCell(f[lang])).join(',');
  const examples = TEMPLATE_EXAMPLE_ROWS[lang].map((row) => row.map(toCsvCell).join(','));
  return BOM + [header, ...examples].join('\r\n');
}

export interface RawImportRow {
  line: number;
  cells: Partial<Record<CsvField['key'], string>>;
}

/** Maps a header row to canonical field keys, matching either language regardless of current UI lang. */
export function mapHeader(headerRow: string[]): { map: Map<number, CsvField['key']>; missing: CsvField['key'][] } {
  const byLabel = new Map<string, CsvField['key']>();
  for (const f of CSV_FIELDS) {
    byLabel.set(f.he.replace('*', '').trim().toLowerCase(), f.key);
    byLabel.set(f.en.replace('*', '').trim().toLowerCase(), f.key);
    // Lowercased so a header written as the literal key still matches (the lookup lowercases too);
    // camelCase keys like `option1Name` would otherwise never resolve.
    byLabel.set(f.key.toLowerCase(), f.key);
  }
  const map = new Map<number, CsvField['key']>();
  headerRow.forEach((raw, idx) => {
    const key = byLabel.get(raw.replace('*', '').trim().toLowerCase());
    if (key) map.set(idx, key);
  });
  const found = new Set(map.values());
  const missing = (['name', 'price'] as const).filter((k) => !found.has(k));
  return { map, missing };
}

export function toRawRows(rows: string[][], headerMap: Map<number, CsvField['key']>): RawImportRow[] {
  return rows.slice(1).map((cells, i) => {
    const obj: Partial<Record<CsvField['key'], string>> = {};
    headerMap.forEach((key, idx) => { obj[key] = (cells[idx] ?? '').trim(); });
    return { line: i + 2, cells: obj };
  }).filter((r) => Object.values(r.cells).some((v) => v));
}

export interface SkuMatchTarget {
  id: string;
  name: string;
  price: number;
}

/** Runs on every import (manual upload AND external-feed sync). A seller who manages inventory
 *  elsewhere — or just re-uploads their own Excel — keys rows by their OWN sku, never our internal
 *  UUID, so a row whose sku already exists in the catalog IS an update to that product. This resolves
 *  each such row's sku to the existing product's id (and backfills a blank name/price from it, so an
 *  inventory feed can legitimately carry only sku+stock) BEFORE validation — after which the whole
 *  downstream pipeline treats it as an ordinary id-matched update, no other code path changed. A row
 *  whose sku is unknown is left untouched, so it flows through as a create (name/price then required,
 *  as usual). An explicit id column always wins over sku matching, so the export→edit→import
 *  round-trip is unaffected. Mutates and returns the same rows (a cheap in-place pre-pass, like
 *  toRawRows' output is only ever consumed once). */
export function resolveSkuMatches(rows: RawImportRow[], catalogBySku: Map<string, SkuMatchTarget>): RawImportRow[] {
  for (const r of rows) {
    if (r.cells.id?.trim()) continue;
    const sku = r.cells.sku?.trim();
    if (!sku) continue;
    const target = catalogBySku.get(sku);
    if (!target) continue;
    r.cells.id = target.id;
    if (!r.cells.name?.trim()) r.cells.name = target.name;
    if (!r.cells.price?.trim()) r.cells.price = String(target.price);
  }
  return rows;
}

export interface BulkProductInput {
  name: string;
  price: number;
  /** Undefined = blank cell = "leave unchanged" on an update row, defaults to 0 on create. */
  stock?: number;
  /** Ordered root-first segment names (e.g. ["ביגוד", "גברים"]), already validated for no orphan gaps — resolved/auto-created into a real categoryId by store-products-bulk.ts. Undefined = all three columns blank = "leave unchanged" on update / no category on create. */
  categoryPath?: string[];
  tags?: string[];
  description?: string;
  /** Not used to match/find rows (only the id column is) — a plain data field like category/tags, kept in sync with the single-product editor. Uniqueness IS validated here (unlike other bulk fields) — see validateRows' sku-duplicate check — to match the same guarantee the single-product add/edit form enforces via isSkuTaken(). On a variant-group row this is the individual combo's sku. */
  sku?: string;
  /** Raw variant dimensions parsed from the option name/value column pairs (in slot order), consumed
   *  only by variant-csv.ts#mergeVariantGroups (which assembles the product's variant matrix). A slot
   *  with any content (name or value) is kept so the group pass can flag an inconsistent/half-filled
   *  dimension; a fully-blank slot is dropped. Left on the per-row input so grouping stays a separate,
   *  testable pass over already-validated rows rather than tangled into per-row validation. */
  variantOptions?: Array<{ name: string; value: string }>;
}

export interface BulkRowResult {
  line: number;
  action: 'create' | 'update' | 'error';
  id?: string;
  input?: BulkProductInput;
  /** The row's raw `group` cell, kept even on error rows so mergeVariantGroups can still bucket a
   *  broken row with its siblings (one bad row fails the whole variant product, not silently drops). */
  group?: string;
  errors: string[];
}

/** existingSkuOwners: sku → the id of the existing product that currently owns it (for detecting both
 *  a collision with the rest of the catalog and — since a row's own current sku is its own entry here —
 *  distinguishing "this row keeps its own sku" from a real conflict). */
export function validateRows(rawRows: RawImportRow[], existingIds: Set<string>, existingSkuOwners: Map<string, string> = new Map()): BulkRowResult[] {
  const skuClaimedInBatch = new Map<string, number>(); // sku → line that already claimed it in this same import
  return rawRows.map((raw): BulkRowResult => {
    const errors: string[] = [];
    const group = raw.cells.group?.trim() || undefined;
    const id = raw.cells.id?.trim() || undefined;
    if (id && !existingIds.has(id)) errors.push('id-not-found');

    const name = raw.cells.name?.trim() ?? '';
    if (!name) errors.push('name-required');

    const price = parseFloat(raw.cells.price ?? '');
    if (!Number.isFinite(price) || price < 0) errors.push('price-invalid');

    let stock: number | undefined;
    if (raw.cells.stock?.trim()) {
      const parsed = parseInt(raw.cells.stock, 10);
      if (!Number.isFinite(parsed) || parsed < 0) errors.push('stock-invalid');
      else stock = parsed;
    }

    const sku = raw.cells.sku?.trim() || undefined;
    if (sku) {
      const catalogOwner = existingSkuOwners.get(sku);
      const conflictsWithCatalog = catalogOwner !== undefined && catalogOwner !== id;
      const conflictsWithBatch = skuClaimedInBatch.has(sku);
      if (conflictsWithCatalog || conflictsWithBatch) errors.push('sku-duplicate');
      else skuClaimedInBatch.set(sku, raw.line);
    }

    // Three columns, root-first — a subcategory column filled in while the level above it is
    // blank has no valid parent to attach to, so it's a hard error rather than a silent guess.
    const categorySegments = [raw.cells.category, raw.cells.subcategory1, raw.cells.subcategory2]
      .map((c) => c?.trim() || '');
    const firstEmpty = categorySegments.findIndex((s) => !s);
    const hasOrphanGap = firstEmpty !== -1 && categorySegments.slice(firstEmpty + 1).some((s) => s);
    if (hasOrphanGap) errors.push('category-orphan-subcategory');

    const tagsForSpamCheck = raw.cells.tags ? raw.cells.tags.split(',').map((t) => t.trim()) : [];
    // Same blocklist + stuffing gates as the single-product form (product.ts)
    // — a bulk import is the higher-leverage version of the same risk
    // (hundreds of rows in one request instead of one), so it needs the same
    // checks, not lighter ones.
    if (findSpamKeyword(name, raw.cells.description, ...tagsForSpamCheck)) errors.push('spam-keyword');
    if (findKeywordStuffing(name, raw.cells.description, ...tagsForSpamCheck)) errors.push('keyword-stuffing');

    if (errors.length) return { line: raw.line, action: 'error', id, group, errors };

    const categoryPath = categorySegments.filter(Boolean);
    const tags = raw.cells.tags ? raw.cells.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : undefined;
    const variantOptions = OPTION_SLOTS
      .map((slot) => ({ name: raw.cells[slot.name]?.trim() || '', value: raw.cells[slot.value]?.trim() || '' }))
      .filter((o) => o.name || o.value);
    const input: BulkProductInput = {
      name, price, stock,
      categoryPath: categoryPath.length ? categoryPath : undefined,
      tags: tags?.length ? tags : undefined,
      description: raw.cells.description?.trim() || undefined,
      sku,
      variantOptions: variantOptions.length ? variantOptions : undefined,
    };
    return { line: raw.line, action: id ? 'update' : 'create', id, group, input, errors: [] };
  });
}
