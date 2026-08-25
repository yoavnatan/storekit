/**
 * Optimistic-concurrency revisions — the guard against a "lost update" when the
 * seller has the dashboard open in more than one tab (or on a second device).
 *
 * The failure it exists for: tab A and tab B both loaded product X. The seller
 * raises the price in A and saves; then, in B — still showing the old form — he
 * fixes a typo in the description and saves. B's form carries the OLD price too,
 * so A's change is silently overwritten. Nothing errors, nothing warns, and the
 * price is simply wrong. Same story for the Settings form and the whole store.
 *
 * A revision is a short hash of ONLY the fields the form in question actually
 * writes, taken from the stored record. The client sends back the revision it
 * loaded; if the stored record has moved since, the save is refused with 409 and
 * the seller decides (see the callers in api/product.ts + api/store.ts).
 *
 * Why a content hash of the form's own fields rather than a record-wide
 * `updatedAt` stamp:
 *  - No false alarms. A store-wide sale, a bg-colour, a feed token — all write to
 *    the same store record but none of them is a field the Settings form owns, so
 *    none of them can make an honest save look like a conflict. One false alarm
 *    teaches the seller to click through the real one.
 *  - Nothing to migrate. No new column, no backfill, and a legacy row written
 *    before this existed produces a revision like any other.
 *  - It survives the JSON→Postgres move unchanged (DB_MIGRATION_PLAN.md): it is
 *    derived from the row's own values, not from storage metadata.
 *
 * Pure and dependency-free on purpose — the same function has to be callable from
 * an API route, from `.astro` SSR, and (if a surface ever needs it) the browser.
 */

/** Deterministic serialization: object key order can differ between two equal records (JSON round-trips, spread rebuilds), and a revision that changed for that reason would be a conflict nobody caused. `~` marks absent/null so a cleared field is distinguishable from an empty string. */
function stable(value: unknown): string {
  if (value === null || value === undefined) return '~';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${k}:${stable(obj[k])}`).join(',')}}`;
  }
  return String(value);
}

/** Two independent 32-bit rolling hashes, so an accidental collision (a change that produces the same revision, i.e. a conflict we'd miss) needs both to collide at once. */
function revOf(fields: unknown): string {
  const s = stable(fields);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/** An empty collection and an absent one are written interchangeably by the save paths (`tags: []` vs no `tags` key), so they must not read as a change. An empty STRING is left alone — clearing a description is a real edit. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (value !== null && typeof value === 'object' && Object.keys(value as object).length === 0) return undefined;
  return value;
}

/** The product fields the dashboard's full edit form submits (api/product.ts `edit-product`).
 *  `variantSku` was deliberately absent while the editor merely PRESERVED it; it grew a column in
 *  the combo table on 2026-08-19, so it is now a field the seller edits and needs the same per-field
 *  merge as any other — without it, a CSV import or an external sync writing a code would be
 *  reverted by whatever an open form happened to be holding. */
/** APPEND-ONLY, and positional — a rev is these fields' hashes joined in this order. Inserting
 *  mid-list would make every open form's baseline describe the wrong fields; appending only makes
 *  it the wrong LENGTH, which `mergeByFieldRev` already treats as "client doesn't speak revisions"
 *  and falls back from safely (see its header). That is what makes adding a field deploy-safe. */
export const PRODUCT_REV_FIELDS = [
  'name', 'description', 'price', 'stock', 'images', 'categoryId', 'tags',
  'sku', 'specs', 'discount', 'sellerNote', 'variants', 'variantStock', 'variantImages',
  'brand', 'weightGrams',
  // Appended, per the rule above — a baseline minted before this deploy is simply the wrong LENGTH,
  // which mergeByFieldRev already falls back from safely.
  'variantSku',
] as const;

/** The store fields the Settings form submits (api/store.ts `save-settings`). Everything else on the store — sale, bg colours, feed config, export token, custom domain, slug — saves live from its own section and is intentionally outside this revision. */
export const STORE_REV_FIELDS = [
  'name', 'tagline', 'description', 'categories', 'bannerImage', 'profileImage',
  'address', 'addressVisible', 'hours', 'hoursVisible',
  // **Sub-keys of `shipping`, not `shipping` itself — and that is the whole point.** The column is
  // one JSON object, so listing it whole made every setting inside it ONE mergeable unit: two tabs
  // toggling two DIFFERENT switches both reported having changed "shipping", to different values,
  // and the seller was interrupted by a conflict this module exists to avoid. It was invisible
  // while `shipping` held a single key, because then the object and the field were the same thing.
  // A dotted path is read and written by `readPath`/`writePath` below; a plain name still behaves
  // exactly as it always did. **Adding a switch to `shipping` means adding its path HERE too** —
  // otherwise it is not merged, and worse, it is not written at all.
  'shipping.selfPickup', 'shipping.printsLabels',
  // Appended rather than inserted — a convention here, not a safety property, and the difference is
  // worth stating because the obvious guess is wrong. `fieldRevs` joins one revision PER FIELD
  // positionally, so the tempting conclusion is that a mid-list insert would misalign an in-flight
  // baseline against the wrong fields. It cannot: `mergeByFieldRev` gates on
  // `base.length === fields.length`, so a baseline minted before this deploy is judged UNUSABLE as
  // a whole and that one save falls back to "take everything the seller submitted", exactly as it
  // behaved before per-field merging existed. That is the real cost of extending this list — any
  // extension, in any position — and it is one save per form open across a deploy, self-healing on
  // the next page load. Appending simply keeps the list readable next to the form.
  // Two fields and not one, on purpose (migration 0021): uploading a logo does not adopt it, and
  // choosing the name back does not delete it — so they merge independently too.
  'headerLogo', 'headerStyle',
] as const;

/** Read a field that may be a dotted path into a nested object (`shipping.selfPickup`). A plain
 *  name is a one-segment path, so this is identical to `record[f]` for every field that is not
 *  nested — the product form's entire list included. Missing intermediates read as `undefined`,
 *  which is what an absent field has always produced here. */
function readPath(record: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return record[path];
  return path.split('.').reduce<unknown>(
    (value, key) => (value == null ? undefined : (value as Record<string, unknown>)[key]),
    record,
  );
}

/** The write half. Intermediates are created as plain objects, so a merge result is assembled the
 *  same way whether the record it came from had the nested object or not. Deliberately only ever
 *  called on the merge's own fresh output — it mutates, and nothing else here may. */
function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (!path.includes('.')) { target[path] = value; return; }
  const keys = path.split('.');
  const last = keys.pop() as string;
  let node = target;
  for (const key of keys) {
    const next = node[key];
    if (typeof next !== 'object' || next === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[last] = value;
}

/** One revision PER FIELD, positional over the field list above — that is what lets a save be merged field by field instead of accepted or rejected whole. */
function fieldRevs(record: Record<string, unknown>, fields: readonly string[]): string {
  return fields.map((f) => revOf(normalize(readPath(record, f)))).join('.');
}

export function productEditRev(p: object): string {
  return fieldRevs(p as Record<string, unknown>, PRODUCT_REV_FIELDS);
}

export function storeSettingsRev(s: object): string {
  return fieldRevs(s as Record<string, unknown>, STORE_REV_FIELDS);
}

export interface MergeOutcome {
  /** What to write: the seller's own edits, on top of whatever the record holds now. */
  merged: Record<string, unknown>;
  /** Fields BOTH sides changed, to different values — the only genuinely ambiguous case, and the only one worth asking about. Empty means the save is safe to write as-is. */
  conflicts: string[];
}

/**
 * Three-way merge of a submitted form against the stored record, using the per-field
 * revisions the form was rendered with.
 *
 * The reason this exists rather than a plain accept/reject: a dashboard form submits
 * EVERY field, including the ones the seller never looked at. If a second tab saved
 * meanwhile, writing the form whole reverts that tab's work — and "save anyway" would
 * do exactly the same damage the refusal was there to prevent. So each field is decided
 * on its own:
 *
 *   this tab didn't touch it        → keep what is stored (the other tab's value stands)
 *   this tab touched it, nobody else → take the seller's value
 *   both, to the same value          → no argument, take it
 *   both, to different values        → a real conflict; ask, and only `force` overrides
 *
 * The practical effect: two tabs editing different fields of the same product both get
 * their way silently, and the seller is only ever interrupted about the one field two
 * people genuinely disagree on.
 *
 * A missing/short baseline means the client doesn't speak revisions (an older deploy
 * mid-rollout, or a stray POST) — every field is then taken from the submission, which
 * is exactly how this endpoint behaved before revisions existed. Backward-compatible by
 * construction (AI_INSTRUCTIONS.md → Hard rules → Backward-compatible API).
 */
export function mergeByFieldRev(opts: {
  fields: readonly string[];
  submitted: object;
  stored: object;
  baseline: FormDataEntryValue | null;
  force?: boolean;
}): MergeOutcome {
  const { fields, force } = opts;
  const submitted = opts.submitted as Record<string, unknown>;
  const stored = opts.stored as Record<string, unknown>;
  const base = typeof opts.baseline === 'string' ? opts.baseline.split('.') : [];
  const merged: Record<string, unknown> = {};
  const conflicts: string[] = [];
  const usable = base.length === fields.length;

  fields.forEach((field, i) => {
    const submittedValue = readPath(submitted, field);
    if (!usable) { writePath(merged, field, submittedValue); return; }

    const baseRev = base[i];
    const submittedRev = revOf(normalize(submittedValue));
    const storedValue = readPath(stored, field);
    const storedRev = revOf(normalize(storedValue));
    const seller = submittedRev !== baseRev;
    const elsewhere = storedRev !== baseRev;

    if (!seller) { writePath(merged, field, storedValue); return; }
    if (elsewhere && submittedRev !== storedRev && !force) conflicts.push(field);
    writePath(merged, field, submittedValue);
  });

  return { merged, conflicts };
}
