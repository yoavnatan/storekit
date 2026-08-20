/**
 * Product ATTRIBUTES for the showcase catalogs — what the store page's "סינון" panel filters on
 * (`src/lib/product-facets.ts`).
 *
 * **Derived from each product's own copy, never invented beside it.** Every rule below matches
 * words that are already in the product's name, description or shelf: a plant whose description
 * says "סובל אור חלש" gets `אור: סובל צל`, and a pair of headphones whose description says
 * "אלחוטי" gets `חיבור: אלחוטי`. Nothing is guessed. That is the only way a demo catalogue can
 * carry attributes at all without the seed becoming a second, quieter place where the showcase
 * stores are described — and it happens to model what a real seller does, which is to restate in a
 * spec row what the copy already says in a sentence.
 *
 * **A product that matches nothing gets no row, on purpose.** Most catalogues are partial, and the
 * panel's thresholds (`MIN_PRODUCTS_PER_FACET`, `MIN_VALUES_PER_FACET`) exist precisely to survive
 * that — filling every gap would produce a demo that only exercises the happy path.
 *
 * **Order matters inside a dimension: first match wins.** The more specific value is listed first,
 * so "אור עקיף בהיר" is tested before the bare "אור" and a plant is not filed under both.
 *
 * These are demo data like everything else in these stores (memory `project_all_data_is_demo`).
 * They are not a vocabulary the platform imposes on a real seller — that is
 * `src/lib/spec-vocabulary.ts`, which only ever suggests.
 */

/**
 * One dimension: a label, and the values in the order they are tested. `any` is a list of
 * substrings; the first value with a hit wins, and a product matching none of them simply gets no
 * row for that dimension.
 */
const RULES = {
  'showcase-fashion': [
    {
      label: 'חומר',
      values: [
        { value: 'עור', any: ['עור '] },
        { value: 'דנים', any: ['ג׳ינס', 'דנים', 'ג\'ינס'] },
        { value: 'צמר', any: ['צמר', 'מרינו', 'קשמיר'] },
        { value: 'פשתן', any: ['פשתן'] },
        { value: 'כותנה', any: ['כותנה', 'טריקו'] },
        { value: 'ויסקוזה', any: ['ויסקוז'] },
        { value: 'פוליאסטר', any: ['פוליאסטר'] },
      ],
    },
    {
      label: 'עונה',
      values: [
        { value: 'חורף', any: ['חורף', 'צמר', 'מעיל', 'סריג', 'מבטן', 'גשם'] },
        { value: 'קיץ', any: ['קיץ', 'פשתן', 'קליל', 'נושם', 'שרוול קצר'] },
      ],
    },
  ],

  'showcase-home': [
    {
      label: 'חומר',
      values: [
        { value: 'עץ', any: ['עץ ', 'אלון', 'אגוז', 'אשור', 'במבוק'] },
        { value: 'קרמיקה', any: ['קרמיק', 'חרס', 'פורצלן'] },
        { value: 'זכוכית', any: ['זכוכית'] },
        { value: 'מתכת', any: ['מתכת', 'פלדה', 'נירוסטה', 'ברזל', 'אלומיניום'] },
        { value: 'אבן', any: ['שיש', 'אבן', 'בטון'] },
        { value: 'בד', any: ['ריפוד', 'בד ', 'כותנה', 'פשתן'] },
      ],
    },
    {
      label: 'תחזוקה',
      values: [
        { value: 'ניתן לכביסה', any: ['כביסה', 'כביס'] },
        { value: 'מתאים למדיח', any: ['מדיח'] },
      ],
    },
  ],

  'showcase-tech': [
    {
      label: 'חיבור',
      values: [
        { value: 'אלחוטי', any: ['אלחוט', 'bluetooth', 'בלוטות', 'wifi', 'wi-fi', 'אינטרנט אלחוטי'] },
        { value: 'USB-C', any: ['usb-c', 'usb c', 'טייפ סי'] },
        { value: 'HDMI', any: ['hdmi'] },
        { value: 'ג׳ק 3.5', any: ['3.5 מ״מ', '3.5 מ"מ', 'ג׳ק'] },
        { value: 'כבל', any: ['כבל'] },
      ],
    },
    {
      label: 'מקור חשמל',
      values: [
        { value: 'סוללה נטענת', any: ['טעינה', 'נטענ', 'סוללה', 'שעות האזנה', 'שעות עבודה'] },
        { value: 'חיבור לחשמל', any: ['לשקע', 'לחשמל', 'שנאי', 'ספק כוח'] },
      ],
    },
  ],

  'showcase-plants': [
    {
      label: 'אור',
      values: [
        { value: 'סובל צל', any: ['אור חלש', 'אור נמוך', 'צל', 'עמידים לצל', 'מעט אור'] },
        { value: 'אור עקיף בהיר', any: ['אור עקיף', 'אור בהיר', 'שמש חלקית', 'אור קבוע'] },
        { value: 'שמש מלאה', any: ['שמש מלאה', 'שמש ישראלית', 'שמש ישירה'] },
      ],
    },
    {
      label: 'רמת טיפוח',
      values: [
        { value: 'תובענית', any: ['לחות גבוהה', 'ריסוס', 'תשומת לב', 'דורש', 'דורשת', 'גיזום', 'לא אוהב שמזיזים'] },
        { value: 'קלה', any: ['קשה להרוג', 'סבלני', 'עמיד', 'שורדת', 'סולח', 'בלי להתלונן', 'שוכח להשקות'] },
        { value: 'בינונית', any: ['השקיה', 'מים'] },
      ],
    },
  ],
};

/**
 * The spec rows for one catalog row, or `undefined` when nothing matched.
 *
 * The haystack is the product's own text plus its shelf names — the shelf is included because a
 * catalog row often states the material once, in the sub-category ("עלים גדולים" / "ספות
 * וכורסאות"), and leaves the description to say something else about it.
 */
export function specsFor(storeSlug, row) {
  const rules = RULES[storeSlug];
  if (!rules) return undefined;
  const hay = [row.n, row.d, row.sub, row.sub2].filter(Boolean).join(' ').toLowerCase();
  const specs = [];
  for (const dimension of rules) {
    for (const candidate of dimension.values) {
      if (!candidate.any.some((needle) => hay.includes(needle.toLowerCase()))) continue;
      specs.push({ label: dimension.label, value: candidate.value });
      break;
    }
  }
  return specs.length ? specs : undefined;
}
