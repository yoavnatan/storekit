import { describe, expect, it } from 'vitest';
import {
  MAX_SUGGESTED_LABELS,
  MAX_SUGGESTED_VALUES,
  STARTER_CATEGORY_VALUES,
  STARTER_SPEC_LABELS,
  STARTER_SPEC_VALUES,
  buildSpecVocabulary,
  matchSuggestions,
  starterLabelsFor,
} from '../src/lib/spec-vocabulary.js';
import { facetKey, MAX_FACET_TEXT_LENGTH } from '../src/lib/product-facets.js';
import { SEED_CATEGORIES } from '../src/lib/store-taxonomy.js';

const product = (specs: Array<{ label: string; value: string }>) => ({ specs });

describe('the starter vocabulary', () => {
  it('is keyed by the platform vocabulary, so the table can be complete and stay complete', () => {
    // A store's own tree is unbounded free text; keying off it would be a table permanently
    // missing the next shop. Same split, same reason, as category-icons.ts.
    for (const category of Object.keys(STARTER_SPEC_LABELS)) {
      expect(SEED_CATEGORIES).toContain(category);
    }
  });

  it('answers the case that started this — a toy shop', () => {
    // CURRENT_TASK סשן ד׳: age, kind of play, and who it is for.
    expect(STARTER_SPEC_LABELS['צעצועים']).toEqual(['גיל', 'מגדר', 'סוג משחק']);
  });

  it('never suggests colour, which is a purchasable variant with its own picker', () => {
    for (const labels of Object.values(STARTER_SPEC_LABELS)) {
      expect(labels.map(facetKey)).not.toContain('צבע');
    }
  });

  it('stays a hint rather than a form — three or four names, never a scheme', () => {
    for (const [category, labels] of Object.entries(STARTER_SPEC_LABELS)) {
      expect(labels.length, category).toBeLessThanOrEqual(4);
      expect(labels.length, category).toBeGreaterThan(0);
    }
  });

  it('keeps every suggestion short enough to survive the panel it feeds', () => {
    const all = [
      ...Object.values(STARTER_SPEC_LABELS).flat(),
      ...Object.values(STARTER_SPEC_VALUES).flat(),
      ...Object.values(STARTER_CATEGORY_VALUES).flatMap((byLabel) => Object.values(byLabel).flat()),
    ];
    for (const text of all) {
      expect(text.length, text).toBeLessThanOrEqual(MAX_FACET_TEXT_LENGTH);
    }
  });

  it('keys its starter VALUES off a label that some category actually offers', () => {
    // A value list for an attribute nobody is ever offered is a list nobody can reach.
    const offered = new Set(Object.values(STARTER_SPEC_LABELS).flat().map(facetKey));
    for (const label of Object.keys(STARTER_SPEC_VALUES)) {
      expect(offered, label).toContain(facetKey(label));
    }
  });

  it('keys every per-vertical value list off that vertical\'s OWN labels', () => {
    // Offering ריהוט's materials under a label ריהוט never suggests is a list a seller of
    // furniture cannot reach, and the reason the two maps are keyed the same way.
    for (const [category, byLabel] of Object.entries(STARTER_CATEGORY_VALUES)) {
      expect(SEED_CATEGORIES, category).toContain(category);
      const labels = new Set((STARTER_SPEC_LABELS[category] ?? []).map(facetKey));
      for (const label of Object.keys(byLabel)) {
        expect(labels, `${category} → ${label}`).toContain(facetKey(label));
      }
    }
  });

  it('gives the common verticals real value lists, not just names', () => {
    // The owner's ask, 2026-08-20: the names covered nearly every category, the VALUES did not,
    // and values are the half that stops "עץ מלא" being spelled three ways.
    for (const category of ['אופנה', 'לבית', 'ריהוט', 'צעצועים', 'ספרים', 'מחשבים', 'ספורט']) {
      const byLabel = STARTER_CATEGORY_VALUES[category];
      expect(byLabel, category).toBeDefined();
      expect(Object.keys(byLabel!).length, category).toBeGreaterThan(0);
    }
  });

  it('keeps each list an example rather than a form', () => {
    for (const [category, byLabel] of Object.entries(STARTER_CATEGORY_VALUES)) {
      for (const [label, values] of Object.entries(byLabel)) {
        expect(values.length, `${category} → ${label}`).toBeLessThanOrEqual(6);
        expect(values.length, `${category} → ${label}`).toBeGreaterThan(0);
      }
    }
  });

  it('never offers one shop another shop\'s materials', () => {
    // The whole reason the per-vertical map exists: "חומר" is one word and two different lists.
    const fashion = STARTER_CATEGORY_VALUES['אופנה']!['חומר']!.map(facetKey);
    const furniture = STARTER_CATEGORY_VALUES['ריהוט']!['חומר']!.map(facetKey);
    expect(fashion).toContain('כותנה');
    expect(fashion).not.toContain('עץ מלא');
    expect(furniture).toContain('עץ מלא');
    expect(furniture).not.toContain('כותנה');
  });

  it('de-duplicates across a store\'s categories, in the order the seller chose them', () => {
    expect(starterLabelsFor(['אופנה', 'הנעלה'])).toEqual(['חומר', 'סגנון', 'עונה', 'גזרה']);
    expect(starterLabelsFor(['כלבו'])).toEqual([]);
    expect(starterLabelsFor([])).toEqual([]);
  });
});

describe('buildSpecVocabulary', () => {
  it('groups two spellings into one entry offering the one the store mostly uses', () => {
    // This is the whole point: the third product is nudged to match the first two rather than
    // inventing a third spelling of the same range.
    const { entries } = buildSpecVocabulary([
      product([{ label: 'גיל', value: '3-5' }]),
      product([{ label: 'גיל', value: '3–5' }]),
      product([{ label: 'גיל', value: '3-5' }]),
    ]);
    expect(entries).toHaveLength(1);
    // One chip for the range, spelled the way this store spells it — not two chips for one
    // attribute, which is the drift the whole suggestion layer exists to prevent. The standard
    // bands follow it (see `mergeValues`), but the store's own spelling leads.
    expect(entries[0]!.values[0]).toBe('3-5');
    expect(entries[0]!.values.filter((v) => facetKey(v) === '3-5')).toHaveLength(1);
  });

  it('ranks attributes by how much of the catalogue uses them', () => {
    const { entries } = buildSpecVocabulary([
      product([{ label: 'חומר', value: 'עץ' }, { label: 'נדיר', value: 'א' }]),
      product([{ label: 'חומר', value: 'בד' }]),
      product([{ label: 'חומר', value: 'מתכת' }]),
    ]);
    expect(entries[0]!.label).toBe('חומר');
  });

  it('puts the store\'s own vocabulary ahead of ours, and never lets ours displace it', () => {
    const { entries } = buildSpecVocabulary(
      [product([{ label: 'סוג משחק', value: 'הרכבה' }]), product([{ label: 'סוג משחק', value: 'חשיבה' }])],
      ['צעצועים'],
    );
    expect(entries[0]!.label).toBe('סוג משחק');
    expect(entries.map((e) => e.label)).toEqual(['סוג משחק', 'גיל', 'מגדר']);
  });

  it('does not offer the same attribute twice when the store already uses a starter one', () => {
    const { entries } = buildSpecVocabulary([product([{ label: 'גיל', value: '0-2' }])], ['צעצועים']);
    expect(entries.filter((e) => facetKey(e.label) === 'גיל')).toHaveLength(1);
  });

  it('offers the vertical\'s own values ahead of the generic ones', () => {
    const { entries } = buildSpecVocabulary([], ['ריהוט']);
    const material = entries.find((e) => facetKey(e.label) === 'חומר')!;
    // `סגנון` is in BOTH maps: ריהוט names four, and the universal list names three. The shop's
    // own list has to lead, or a furniture seller is offered "יומיומי" before "כפרי".
    const style = entries.find((e) => facetKey(e.label) === 'סגנון')!;
    expect(material.values[0]).toBe('עץ מלא');
    expect(style.values[0]).toBe('מודרני');
  });

  it('fills an attribute\'s values from the starter list only where history left room', () => {
    const { entries } = buildSpecVocabulary([product([{ label: 'גיל', value: '3-5' }])], []);
    // The store's own spelling first, ours behind it — and never a duplicate of what it has.
    expect(entries[0]!.values[0]).toBe('3-5');
    expect(entries[0]!.values.filter((v) => facetKey(v) === '3-5')).toHaveLength(1);
    expect(entries[0]!.values).toContain('6-8');
  });

  it('counts a label whose value the seller has not typed yet', () => {
    // A half-filled row still says which attribute this seller intends to use.
    const { entries } = buildSpecVocabulary([product([{ label: 'גיל', value: '' }])]);
    expect(entries[0]!.label).toBe('גיל');
  });

  it('ignores rows too long to ever become a filter', () => {
    const long = 'א'.repeat(MAX_FACET_TEXT_LENGTH + 1);
    expect(buildSpecVocabulary([product([{ label: long, value: 'עץ' }])]).entries).toEqual([]);
    const { entries } = buildSpecVocabulary([product([{ label: 'הערה', value: long }])]);
    expect(entries[0]!.values).toEqual([]);
  });

  it('stays within both caps however large the catalogue', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      product(Array.from({ length: 5 }, (__, j) => ({ label: `מאפיין ${j}`, value: `ערך ${i}` }))));
    const { entries } = buildSpecVocabulary(many);
    expect(entries.length).toBeLessThanOrEqual(MAX_SUGGESTED_LABELS);
    for (const entry of entries) {
      expect(entry.values.length).toBeLessThanOrEqual(MAX_SUGGESTED_VALUES);
    }
  });

  it('is stable between two renders of the same catalogue', () => {
    const catalogue = [
      product([{ label: 'חומר', value: 'עץ' }]),
      product([{ label: 'חומר', value: 'בד' }]),
    ];
    expect(JSON.stringify(buildSpecVocabulary(catalogue)))
      .toBe(JSON.stringify(buildSpecVocabulary(catalogue)));
  });

  it('survives a product with no specs at all', () => {
    expect(buildSpecVocabulary([{ specs: null }, { specs: undefined }, {}]).entries).toEqual([]);
  });
});

describe('matchSuggestions', () => {
  it('offers everything while the box is empty', () => {
    expect(matchSuggestions(['3-5', '6-8'], '', 10)).toEqual(['3-5', '6-8']);
  });

  it('narrows as the seller types, through the same folding the panel groups by', () => {
    expect(matchSuggestions(['כותנה', 'פשתן'], 'כות', 10)).toEqual(['כותנה']);
    expect(matchSuggestions(['3-5', '6-8'], '3–', 10)).toEqual(['3-5']);
  });

  it('hides a suggestion the field already says — a button that would do nothing', () => {
    expect(matchSuggestions(['3-5', '6-8'], '3-5', 10)).toEqual([]);
    expect(matchSuggestions(['3-5'], '3–5', 10)).toEqual([]);
  });

  it('honours the limit', () => {
    expect(matchSuggestions(['א1', 'א2', 'א3'], 'א', 2)).toHaveLength(2);
  });
});
