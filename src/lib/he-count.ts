/**
 * "N somethings" in Hebrew, written the way a person writes it.
 *
 * **The report (owner, 2026-08-20), and it was two faults wearing one symptom.** The money journal
 * printed `אסמכתת סליקה MOCK-B85303C8 · 1 הזמנות`, and he read it as *"יש שם מספר 1 שלא קשור לשום
 * מילה, המילה בורחת"*. One fault is bidi — the digit joined the Latin reference in front of it and
 * was painted on the far side of it, away from the noun it counts; `bidi-isolate.ts` owns that half,
 * and it is a rendering concern rather than a copy one. The other is this one, and it survives any
 * amount of correct direction: **`1 הזמנות` is not Hebrew.** A count of one takes the singular and
 * spells itself out — `הזמנה אחת` — and a bare digit standing beside a plural noun is exactly what
 * makes a reader look for the word it belongs to.
 *
 * So the digit is dropped where a person would drop it, and kept everywhere else.
 *
 * ── Why two and above keep the numeral ──
 * Hebrew has a distinct form for two (`שתי הזמנות` / `שני פריטים`) and it depends on the noun's
 * gender, which a pair of strings cannot know. `2 הזמנות` is ordinary and unremarkable in running
 * text; guessing a gender and getting it wrong is not. These lines are read by one person on an
 * operations screen — the win was the missing "one", and a gender table living inside a money module
 * would be a second definition of Hebrew grammar for no reader's benefit.
 */
export function heCount(n: number, singular: string, plural: string): string {
  return n === 1 ? `${singular} ${oneFor(singular)}` : `${n} ${plural}`;
}

/**
 * `אחת` or `אחד`, decided by the noun it follows.
 *
 * Hebrew nouns ending in `ה` or `ת` are overwhelmingly feminine (`הזמנה`, `בקשה`, `חנות`) and the
 * rest take the masculine (`פריט`, `מוצר`, `יום`). It is a heuristic, stated as one — but it is a
 * heuristic over the handful of nouns this platform counts, every one of which it gets right, and
 * the alternative is a gender argument at every call site for somebody to pass wrong. A caller whose
 * noun it would get wrong passes the finished phrase as `singular` instead.
 */
function oneFor(singular: string): string {
  return /[הת]$/.test(singular) ? 'אחת' : 'אחד';
}
