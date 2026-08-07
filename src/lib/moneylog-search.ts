import { MONEY_EVENT_LABELS, MONEY_EVENT_TYPES, type MoneyEventType } from './money-event-types.js';

/**
 * The admin money journal's free-text search, translated from "what the admin is LOOKING at" into
 * something a database can answer.
 *
 * **Why this module exists at all.** The search used to run in JS over every row of the window, which
 * is why the window had to be read whole before fifteen rows could be shown. Pushing it into SQL is
 * what lets `LIMIT` mean anything — but the search matches two things that DO NOT EXIST in the
 * database, and moving it naively would have silently stopped finding them:
 *
 *   1. **The Hebrew label of the event type.** The admin types `ביטול`, reading the chip in front of
 *      them; the column holds `shipping_status_changed`. So a term is resolved against
 *      `MONEY_EVENT_LABELS` HERE, in JS, and travels as a list of `type` values.
 *   2. **The amount as it is RENDERED** (`349.90 ₪`), not as it is stored (`34990`). That one is a
 *      pure function of the column, so it goes the other way — the rendering is reproduced in SQL
 *      (`AMOUNT_RENDERED_SQL`) rather than the term being reverse-engineered into candidate amounts,
 *      which is impossible: `349.9` is a substring of `2,349.90` too.
 *
 * `tests/moneylog-search-parity.test.ts` runs both implementations — this one against Postgres and
 * `admin-moneylog-filter.ts#filterMoneyEvents` in memory — over the same corpus and fails on any
 * disagreement. That is the seam this module is: each side is easy to get right alone, and only the
 * JOIN between them can be wrong.
 *
 * **What the trigram indexes (0001/0004) actually do here, measured rather than assumed.** They do
 * NOT get picked: `ORDER BY at DESC LIMIT 15` makes the planner walk `money_events_at_idx` and
 * filter, betting it will fill the page early. Four more trigram indexes were built on the columns
 * that lack one (`type`, `actor`, `from_value`, `to_value`) and re-measured at 300,000 rows —
 * 1458ms against 1443ms, i.e. nothing — so that migration was NOT written. What the indexes are
 * still worth is the shape they were built for, an equality/prefix lookup of an order id or
 * checkout ref; what actually made this query fast is the date window (money-events.ts) and the
 * `LIMIT`. Re-measure before adding an index here on reasoning alone.
 */

/**
 * Every character that can appear in either rendering of an amount — the digits, the grouping comma,
 * the decimal point, the minus of a correction, and the shekel sign. A term holding anything else
 * (`ord-1111`, `cancelled`, `keramika`) cannot match an amount by construction, so both amount arms
 * are dropped for it and no row is ever rendered to find that out. Search terms never contain
 * whitespace — they are produced by splitting on it — so the space in `349.90 ₪` is not reachable by
 * one term and is deliberately absent here.
 */
const AMOUNT_TERM = /^[0-9.,₪-]+$/;

/**
 * `amount_agorot` rendered exactly as `money.ts#formatAgorot` renders it — what the admin is
 * actually reading on the row (`349.90 ₪`).
 *
 * The `%100` split is `formatPrice`'s own rule (store.config.ts): a round amount prints with no
 * decimals at all, so `1000` is `1,000 ₪` and never `1,000.00 ₪`. Getting that wrong would not
 * error — it would just stop finding the rows an owner searches for most.
 *
 * **It is the most expensive arm in the predicate**: every row has to be rendered before it can be
 * rejected. Measured over a whole 300,000-row journal, guarding it as `amountGuards` does took the
 * search from 1731ms to 1513ms, and dropping it entirely (which the guards do for the common
 * digits-only term) takes it to 1458ms — the cost of the rest of the `OR`. That is why it is gated
 * twice below: first on the term being amount-shaped at all, then on `amountGuards`.
 */
export const AMOUNT_RENDERED_SQL = `(
  CASE WHEN e.amount_agorot % 100 = 0
       THEN to_char(e.amount_agorot / 100, 'FM999,999,999,999,990')
       ELSE to_char(e.amount_agorot::numeric / 100, 'FM999,999,999,999,990.00')
  END || ' ₪')`;

/**
 * Cheap arithmetic conditions that EVERY row matching `term` on its rendered amount must satisfy —
 * or `null` when no row can, in which case the expensive arm above is left out of the query
 * altogether. Pure necessary conditions, never sufficient ones: the rendering still decides.
 *
 * The rendering is `[-]` + the shekels grouped in threes + (`.` + exactly two decimals, unless the
 * amount is round) + ` ₪`. Everything here falls straight out of that shape:
 *
 *   · a `-` in the term  → only a negative amount renders one.
 *   · a `,` in the term  → only a thousand shekels or more gets a grouping comma.
 *   · a `.` in the term  → the rendering has AT MOST ONE dot, so the term's dot must be that dot,
 *                          which pins the decimals: `349.90` can only be an amount ending in 90
 *                          agorot, and `349.9` one ending in 90…99. Two dots, or more than two
 *                          digits after one, cannot occur in any rendering at all.
 *   · `x.00`             → impossible by construction: an amount whose decimals are `00` is round,
 *                          and a round amount is printed WITHOUT a dot.
 *   · plain digits       → the arm is redundant, and provably so, which is what makes dropping it
 *                          safe rather than a guess. Strip the separators from a rendering and you
 *                          get back exactly the digits of `amount_agorot` — so a digits-only term
 *                          that fits inside the rendering (it cannot span a comma or the dot, both
 *                          non-digits) also fits inside `amount_agorot::text`, which is a separate,
 *                          indexable arm. The ONE exception is an amount under a shekel: `5` agorot
 *                          renders `0.05`, whose leading `0` is not in `5`. So a term starting with
 *                          `0` keeps the arm, narrowed to exactly those amounts.
 *
 * Every one of these is asserted against the in-memory matcher in
 * `tests/moneylog-search-parity.test.ts` — the reasoning above is only worth as much as that test.
 */
export function amountGuards(term: string): string[] | null {
  const guards: string[] = [];
  if (term.includes('-')) guards.push('e.amount_agorot < 0');
  if (term.includes(',')) guards.push('(e.amount_agorot >= 100000 OR e.amount_agorot <= -100000)');

  const dot = term.indexOf('.');
  if (dot !== -1) {
    // A rendering has at most one dot, at most two digits after it, and nothing but ` ₪` beyond
    // those. Anything else in the tail — a second dot, a comma, three decimals — cannot occur.
    const tail = /^(\d{0,2})₪?$/.exec(term.slice(dot + 1));
    if (!tail) return null;
    const decimals = tail[1]!;
    if (decimals.length === 0) {
      guards.push('e.amount_agorot % 100 <> 0');
    } else {
      const n = Number(decimals);
      // `.00` and `.0` both mean "round", and a round amount never prints a dot.
      const lo = decimals.length === 2 ? n : n * 10;
      const hi = decimals.length === 2 ? n : n * 10 + 9;
      if (hi === 0) return null;
      guards.push(`(e.amount_agorot % 100 BETWEEN ${Math.max(lo, 1)} AND ${hi} OR e.amount_agorot % 100 BETWEEN ${-hi} AND ${-Math.max(lo, 1)})`);
    }
    return guards;
  }

  if (/^\d+$/.test(term)) {
    if (!term.startsWith('0')) return null; // covered by the raw-agorot arm — see above
    guards.push('(e.amount_agorot > -100 AND e.amount_agorot < 100)');
  }
  return guards;
}

/** The text columns a term is matched against, in the same order `searchHaystack` lists them.
 *
 *  Every column here is written against the alias `e`, which every query in `money-events.ts` gives
 *  the table — one of them joins the table to itself to rank a permalinked row, and an unqualified
 *  `id` there is ambiguous rather than merely untidy. */
const TEXT_COLUMNS = ['order_id', 'checkout_ref', 'store_slug', 'actor', 'detail', 'from_value', 'to_value', 'type'] as const;

/** `LIKE`'s three metacharacters, made literal. The in-memory matcher uses `String.includes`, where
 *  a `%` an admin pasted out of a discount detail is just a percent sign — without this it would
 *  become "match anything" and the two implementations would part company on exactly the rows a
 *  discount search is for. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The event types whose Hebrew label contains `term`. Empty for most searches, which is the point:
 *  the arm is then omitted rather than compared against an empty array. */
export function typesMatchingLabel(term: string): MoneyEventType[] {
  return MONEY_EVENT_TYPES.filter((t) => MONEY_EVENT_LABELS[t].toLowerCase().includes(term));
}

/** Could this term appear inside a rendered or stored amount? See `AMOUNT_TERM`. */
export function termCouldBeAmount(term: string): boolean {
  return AMOUNT_TERM.test(term);
}

/** The search string as the matcher sees it: lowercased, split on whitespace, ANDed by the caller.
 *  Shared with `filterMoneyEvents` through the parity test rather than by import, since that module
 *  must stay free of anything that knows about SQL. */
export function searchTerms(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * One SQL condition per search term, ANDed — `מוצרים ביטול` means both, which is what makes a
 * second word narrow instead of widen.
 *
 * `params` is appended to in place and the `$n` placeholders are numbered off its length, so this
 * composes with whatever clauses a caller has already built.
 */
export function searchClauses(q: string, params: unknown[]): string[] {
  return searchTerms(q).map((term) => {
    params.push(`%${escapeLike(term)}%`);
    const like = `$${params.length}`;
    const arms = TEXT_COLUMNS.map((col) => `e.${col} ILIKE ${like}`);

    const labelled = typesMatchingLabel(term);
    if (labelled.length) {
      params.push(labelled);
      arms.push(`e.type = ANY($${params.length}::text[])`);
    }
    // Two arms, because the in-memory haystack carries two spellings of the amount and a term can
    // never span the space between them: the raw agorot figure (indexable, cheap, and the one a
    // developer pastes out of a log) and the rendered one (expensive — hence `amountGuards`).
    // No `IS NOT NULL` guard on either: both are NULL for a row with no amount, and a NULL arm
    // cannot make the `OR` true, which is exactly the in-memory rule.
    if (termCouldBeAmount(term)) {
      arms.push(`e.amount_agorot::text ILIKE ${like}`);
      const guards = amountGuards(term);
      if (guards) arms.push(`(${[...guards, `${AMOUNT_RENDERED_SQL} ILIKE ${like}`].join(' AND ')})`);
    }
    return `(${arms.join(' OR ')})`;
  });
}
