/**
 * Variant presets for the showcase catalogs.
 *
 * Keyed by the `v` field on a catalog row, so the choice of picker belongs to the
 * PRODUCT TYPE rather than to the store. One blanket set per store — what the old
 * seeder did — put "מידה: XL" on a handbag, which demonstrates the variant feature
 * by making it look broken.
 *
 * A row with `v: null` gets no picker at all, and that is a feature: a showcase
 * store where every item pops a size selector stops demonstrating the plain
 * single-SKU product, which is most of a real catalog.
 *
 * **Colour option names must exist in `src/lib/color-variants.ts`'s COLOR_MAP**
 * or the storefront renders a text chip where a swatch belongs. The warm names
 * used below (טרקוטה, זית, חול …) were added to that map in the same change —
 * they are ordinary Israeli retail colour words, not showcase-only vocabulary.
 */

/** Israeli shoe sizing is EU. 37–43 spans women's and men's in one list, which is
 *  what a small shop that sells both actually publishes. */
const SIZE_SHOES = { name: 'מידה', options: ['37', '38', '39', '40', '41', '42', '43'] };
const SIZE_APPAREL = { name: 'מידה', options: ['S', 'M', 'L', 'XL'] };

const COLOR_WARM = { name: 'צבע', options: ['שחור', 'חול', 'טרקוטה'] };
const COLOR_SHOES = { name: 'צבע', options: ['שחור', 'לבן', 'קוניאק'] };
const COLOR_BAGS = { name: 'צבע', options: ['שחור', 'קוניאק', 'חול'] };
const COLOR_HOME = { name: 'צבע', options: ['שמנת', 'זית', 'טרקוטה'] };
const SIZE_HOME = { name: 'גודל', options: ['קטן', 'בינוני', 'גדול'] };
/** Electronics stay neutral — the warm palette belongs to the other two stores,
 *  and a terracotta laptop stand is not a product anybody sells. */
const COLOR_TECH = { name: 'צבע', options: ['שחור', 'לבן', 'גרפיט'] };
const STORAGE = { name: 'נפח', options: ['512GB', '1TB', '2TB'] };
const SIZE_TECH = { name: 'גודל', options: ['13-14 אינץ׳', '15-16 אינץ׳'] };

/** A nursery sizes a live plant by the pot it ships in, not by S/M/L — that diameter is the actual
 *  trade convention here and it is what decides both the price and the shipping box. */
const SIZE_POT = { name: 'קוטר עציץ', options: ['12 ס״מ', '17 ס״מ', '22 ס״מ'] };

export const VARIANT_PRESETS = {
  potSize: [SIZE_POT],
  apparel: [SIZE_APPAREL, COLOR_WARM],
  shoes: [SIZE_SHOES, COLOR_SHOES],
  colorOnly: [COLOR_BAGS],
  colorHome: [COLOR_HOME],
  sizeHome: [SIZE_HOME],
  colorTech: [COLOR_TECH],
  storage: [STORAGE],
  sizeTech: [SIZE_TECH],
};

export function variantsFor(key) {
  if (!key) return null;
  const preset = VARIANT_PRESETS[key];
  if (!preset) throw new Error(`unknown variant preset ${JSON.stringify(key)}`);
  // Cloned, because the seeder writes these onto product rows and a shared array
  // would let one product's edit reach every other product of the same type.
  return preset.map((dim) => ({ name: dim.name, options: [...dim.options] }));
}
