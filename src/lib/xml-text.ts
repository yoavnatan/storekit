/**
 * The one place a string is made safe to put inside an XML document.
 *
 * **Why this file exists — it was two copies, and only one of them was right (2026-08-02).**
 * `product-feed.ts` and `sitemap.ts` each defined their own `xmlEscape`. The feed's stripped the
 * control characters XML forbids outright before escaping the five significant ones; the sitemap's
 * escaped the five and nothing else. Same name, same apparent job, one silently weaker — and the
 * weaker one guards the file whose whole purpose is being parsed by Google.
 *
 * That asymmetry is the exact failure this codebase has already paid for once: an XML-illegal
 * character does not corrupt one entry, it makes the DOCUMENT unparseable, so the entire feed or
 * sitemap is rejected with nothing in our logs to show for it (memory
 * `project_feed_silent_rejection_class`). A per-file copy of a rule like that will drift again —
 * the fix is one definition both import, plus `tests/xml-text.test.ts`, which fails if either file
 * grows a private escaper back.
 *
 * `sitemap.ts`'s own comment said it was guarding "regardless of what a future caller passes in".
 * It was not; now it is.
 */

/**
 * Characters XML 1.0 does not permit at all, even escaped — C0 controls except tab/LF/CR, the two
 * non-characters, and unpaired surrogates.
 *
 * Stripped rather than replaced: they carry no meaning a shopper would miss, and any placeholder
 * would itself have to be escaped. Unpaired surrogates matter in practice because a JS string
 * sliced mid-emoji (a truncated product title) produces one, and it is invalid UTF-8 on the wire.
 */
const XML_ILLEGAL =
  // eslint-disable-next-line no-control-regex -- matching the control characters IS the point here
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Drop everything XML cannot represent. Every value entering a document goes through here, whether
 *  it is being escaped or wrapped in CDATA — those are two ways to carry text, not two rulesets. */
export function xmlText(value: string): string {
  return String(value ?? '').replace(XML_ILLEGAL, '');
}

/** `xmlText` plus the five significant characters escaped — for element text and attribute values.
 *  `"` and `'` are included deliberately: an escaper that skips them is safe until the first caller
 *  puts its output inside `attr="…"`, which is how this codebase's attribute-escaping hole happened
 *  (memory `project_attribute_escaping_xss`). */
export function xmlEscape(value: string): string {
  return xmlText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CDATA for free text. A literal `]]>` inside would close the section early, so it is split across
 *  two sections — the standard trick, and the reason free text cannot simply be concatenated. */
export function xmlCdata(value: string): string {
  return `<![CDATA[${xmlText(value).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}
