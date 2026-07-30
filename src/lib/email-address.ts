// One definition of "is this an email address", shared by every surface that accepts one.
//
// Two details here are deliberate and easy to lose in a rewrite:
//
// 1. The length cap is checked BEFORE the pattern. RFC 5321 caps an address at 254 characters, so
//    anything longer is invalid regardless — but checking first is also what keeps the match cheap
//    no matter how much text a request body contains.
// 2. The pattern is unambiguous. The usual /^[^\s@]+@[^\s@]+\.[^\s@]+$/ lets `[^\s@]` match the dot
//    as well, so for a domain with no dot the engine has one way to split per character before it
//    can conclude "no match" — quadratic work in the input length. Excluding the dot from the
//    domain classes leaves exactly one possible split, so matching stays linear on any input.
//
// This is validation, not verification: it rejects typos and junk, and says nothing about whether
// the mailbox exists. Only a delivered message proves that.

/** RFC 5321 §4.5.3.1.3 — the longest a forward path may be. */
export const MAX_EMAIL_LENGTH = 254;

/** Local part, then a dotted domain of at least two labels. Dot excluded from the domain classes
 *  so there is one way to match — see note 2 above. */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** True for a syntactically valid, length-bounded address. Doubles as a type guard so routes can
 *  hand it an unknown JSON field directly. Does not trim — surrounding whitespace is rejected, as
 *  it always was. */
export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(value);
}
