/**
 * Latin runs inside Hebrew copy, isolated — so a number or a comma the seller typed in Hebrew does
 * not get swallowed by the English word in front of it.
 *
 * **The report (owner, 2026-08-15): "אחרי שכותבים משהו באנגלית, סימנים ומספרים נחשבים כאילו הם
 * בפלואו האנגלי למרות שאני רושם שם בעברית (אחרי שאני עושה רווח)".** That is precisely what the
 * Unicode bidi algorithm does, and it is not a browser bug: a space between a Latin word and a
 * digit is a NEUTRAL character, and a neutral between two left-to-right characters resolves to
 * left-to-right. So "קוד DEZABIN 10%" is not read as [Hebrew][DEZABIN][10%] — the run "DEZABIN 10%"
 * is one left-to-right block, and inside an RTL line that block is placed as a unit, which puts the
 * 10% on the wrong side of the code the seller wrote it after.
 *
 * Measured in Chromium (2026-08-15), reading order right-to-left, before → after:
 *   "קוד DEZABIN 10% הנחה"    → "קוד 10% DEZABIN הנחה"    ✗ → correct ✓
 *   "מבצע SUMMER: 20% הנחה"   → "מבצע 20% SUMMER: הנחה"   ✗ → correct ✓
 *   "SALE 2026 מבצע סוף עונה" → "2026 SALE מבצע סוף עונה" ✗ → correct ✓
 * and five other shapes (code at the end, code first, a date, a comma after a code, two codes) that
 * were already right stayed right — which is the half that matters, because the obvious fix is
 * worse than the bug.
 *
 * **Why not `<bdi>` around the whole line, which is what the platform does everywhere else.** It
 * was tried first and measured: `<bdi>` resolves its contents by their FIRST strong character, so a
 * line that opens with a Latin word becomes a left-to-right line, and "DEZABIN הקוד לכל הסל" came
 * back with DEZABIN moved to the end. Isolating the whole string fixes nothing here anyway — the
 * damage happens *inside* it. The isolate has to go around the foreign run, not around the sentence
 * containing it.
 *
 * **Why not an RLM character.** U+200F does the same job by making the neutral resolve right-to-left,
 * but it is invisible, so it travels into the database, into a CSV export, into the product feed and
 * into every string comparison, and nobody can see why two strings differ. This is a rendering
 * concern and it stays in the rendering layer: the stored value is exactly what the seller typed.
 *
 * String-returning and isomorphic, like `price-html.ts`: the sale strip is rendered by the
 * storefront, by the dashboard's server-rendered preview, and again by the live preview as the
 * seller types, and those three must not drift.
 */

import { escapeHtml } from './html-escape.js';

/**
 * A Latin run: a Latin letter and whatever stays glued to it — more letters, digits, an apostrophe,
 * an ampersand, a slash or a hyphen ("AT&T", "SALE-50", "L'Oréal", "S/M").
 *
 * The trailing `[.,:;!?]*` is not decoration. Punctuation typed directly after a Latin word belongs
 * to that word visually, and leaving it outside the isolate detached it — measured: "SUMMER:" came
 * back as "SUMMER :" and "DEZABIN," as "DEZABIN ,". Punctuation with a space in front of it is a
 * different thing and stays in the Hebrew flow, which is why there is no leading counterpart.
 *
 * Digits ALONE are deliberately not matched. A bare "10%" or "31.12" in a Hebrew sentence already
 * renders in the right place (measured), and isolating every number would be a change to text that
 * is not broken — the rule is that the isolate goes where the foreign run is.
 */
const LATIN_RUN = /[A-Za-z][A-Za-z0-9'’&/-]*[.,:;!?]*/g;

/**
 * The text as HTML, with every Latin run wrapped in its own isolate.
 *
 * Escaping happens per SEGMENT rather than to the whole string first, and that is load-bearing: an
 * escaped `&` becomes `&amp;`, whose own letters would then match the run pattern and be wrapped —
 * splitting the entity down the middle and printing it as text.
 */
export function isolateLatinRunsHtml(text: string): string {
  // ── A line with NO Hebrew in it is not a mixed line, and isolating each word REVERSES it ──
  //
  // Measured in Chromium, 2026-08-20, inside an RTL page:
  //   "seller edited items / shipping / discount on this order"
  //   → per-word isolates → "order this on discount / shipping / items edited seller"
  // and that is the algorithm behaving correctly. Each `<bdi>` is a neutral object to the paragraph
  // around it, so eight of them in an RTL line are laid out right-to-left however sensible each one
  // is on its own. Untouched, the whole sentence is ONE left-to-right run and reads perfectly.
  //
  // It was latent while the only callers were a seller's sale strip, where a fully-English title is
  // possible but unusual. The money journal's detail column made it certain: several event kinds are
  // recorded in English on purpose, because they are notes to a developer rather than to a shopper.
  //
  // ONE isolate around the whole thing rather than nothing at all: that keeps a foreign sentence
  // from dragging the punctuation of the Hebrew line it sits inside, which is the same reason the
  // per-run isolate exists. The "whole line in `<bdi>`" failure the header above describes is a
  // different case — it needs Hebrew in the line to go wrong, and there is none here.
  if (!text) return '';
  if (!/[\u0590-\u05ff]/.test(text)) return `<bdi>${escapeHtml(text)}</bdi>`;

  let out = '';
  let last = 0;
  for (const m of text.matchAll(LATIN_RUN)) {
    const at = m.index ?? 0;
    out += escapeHtml(text.slice(last, at));
    out += `<bdi>${escapeHtml(m[0])}</bdi>`;
    last = at + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}
