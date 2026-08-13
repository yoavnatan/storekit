import { MIN_DESCRIPTION_LENGTH } from './product-seo-hints.js';
import type { MergedRowResult } from './variant-csv.js';

/**
 * What the import is about to create that nothing else would ever tell the seller.
 *
 * The row-level validation in csv-bulk.ts answers "can this row be written" — a missing name or
 * price fails the line and the preview shows it in red. This answers the other question, which
 * had no answer at all before 2026-08-12: the rows are all perfectly valid, and the catalog they
 * produce is still not sellable.
 *
 * Two counts, and only two, because only these two have a consequence the seller cannot see from
 * the storefront:
 *  · `noImage` — the CSV format carries NO image column (csv-bulk.ts#CSV_FIELDS), so every product
 *    a file creates is image-less by construction. Such a product is fully live — visible, indexed,
 *    buyable — and silently dropped from the ad feed, because `image_link` is a hard Merchant/
 *    Catalog requirement (product-feed.ts#isProductAdvertisable returns 'no-image'). Without this
 *    line the seller finds out weeks later, when a campaign comes back paused.
 *  · `thinDescription` — the description is the product page's meta description and the text an AI
 *    answer engine quotes. Threshold reused from product-seo-hints.ts rather than restated, so this
 *    can never disagree with the meter in the product editor about the same product.
 *
 * ADVISORY, never a gate: both fields are optional in the single-product form too, and a bulk
 * import is where an entry barrier would hurt most — a seller with a real 300-product catalog and
 * no photos yet must still be able to load it. The preview shows these as a note and the confirm
 * button stays enabled.
 *
 * Pure and DB-free so it is testable without a catalog; the caller supplies what the stored
 * products hold.
 */
export interface ImportSeoAdvisory {
  /** Rows that will produce a product with no image at all. */
  noImage: number;
  /** Rows whose resulting description is missing or shorter than MIN_DESCRIPTION_LENGTH. */
  thinDescription: number;
}

/** What an already-stored product contributes — an update row inherits both when its cells are blank. */
export interface AdvisoryExisting {
  description: string;
  images?: string[];
}

/**
 * Counts over the rows the import would actually WRITE: creates, plus updates that change
 * something. Error rows are excluded (nothing is written) and so are `unchanged` rows — they are
 * already skipped on commit and hidden from the preview, and counting them would report a whole
 * re-uploaded catalog as a problem this import is creating.
 */
export function importSeoAdvisory(
  results: MergedRowResult[],
  existingById: Map<string, AdvisoryExisting>,
): ImportSeoAdvisory {
  let noImage = 0;
  let thinDescription = 0;

  for (const r of results) {
    if (r.action === 'error' || r.unchanged || !r.input) continue;
    // A create has no images by construction; an update keeps whatever the stored product has
    // (an import never touches images either way).
    const existing = r.action === 'update' && r.id ? existingById.get(r.id) : undefined;
    if (!(existing?.images ?? []).length) noImage += 1;

    // Blank description cell on an update row = keep the current text (the standard column rule),
    // so the count has to judge the RESULTING description, not the cell.
    const description = (r.input.description ?? existing?.description ?? '').trim();
    if (description.length < MIN_DESCRIPTION_LENGTH) thinDescription += 1;
  }

  return { noImage, thinDescription };
}
