/**
 * Share links — every "send this page to someone" URL, built in one place.
 *
 * **Why a module and not four template strings at the call sites.** Each network takes the
 * message apart differently, and getting it wrong is invisible in review because the link still
 * opens — it just arrives with the title missing, or the URL pasted twice:
 *  - **WhatsApp** takes ONE free-text blob (`?text=`) and finds the link inside it, so the URL
 *    must be part of the text — passing them separately loses the URL entirely.
 *  - **Facebook** takes ONLY the URL (`?u=`) and ignores any text parameter: the words shown next
 *    to the link come from the page's own Open Graph tags, which is why `Seo.astro` is the other
 *    half of this feature and not a nice-to-have beside it.
 *  - **Telegram** takes the two SEPARATELY (`?url=` + `?text=`), and folding the URL into the text
 *    the WhatsApp way makes it appear twice in the sent message.
 *  - **mailto** splits into `subject` + `body`, and the body is where the URL belongs.
 *
 * **The URL handed in is always the page's CANONICAL** (`custom-domain.ts#storeCanonicalUrl` /
 * `#productCanonicalUrl`) — for a store on an active custom domain that is the seller's own
 * domain, which is the point of the feature: a link a shopper forwards points at the store's own
 * site, not at our path to it. Two properties come with that and both are load-bearing here:
 * it is absolute (a share target opens on THEIR origin, so a relative path is a dead link), and
 * its Hebrew slugs are already percent-encoded per segment (`url-base.ts#urlSegment`). So the
 * only encoding this module does is the query-parameter layer — encoding an already-encoded
 * segment is correct (`%D7%90` → `%25D7%2590` is what a share target must receive to hand the
 * original back), and re-encoding it twice is what would break it.
 *
 * Deliberately NOT here: X/Twitter (not how Israelis forward a shop), and SMS/Instagram/anything
 * else app-specific — those arrive through the OS share sheet (`navigator.share`), which the menu
 * offers as one extra item on the devices that have it instead of guessing at a list.
 */

/** The networks with a stable public share endpoint. Order is the order they are offered, and it
 *  is the Israeli order: WhatsApp is how a link actually travels here. */
export const SHARE_CHANNELS = ['whatsapp', 'facebook', 'telegram', 'email'] as const;

export type ShareChannel = (typeof SHARE_CHANNELS)[number];

export interface ShareContent {
  /** Absolute canonical URL of the page being shared. See the module header. */
  url: string;
  /** Plain text naming the thing — a store name, or "<product> · <store>". No price: a forwarded
   *  message outlives the price it quotes, and the page it links to is where the live one is. */
  title: string;
}

/**
 * The one-blob form: title, then the link on its own line.
 *
 * The newline is not cosmetic — WhatsApp and every other client that auto-links only builds a
 * preview card from a URL that ends at whitespace, so a title glued to the link with a space and
 * a trailing full stop is a link that silently arrives as plain text.
 */
export function shareMessage(content: ShareContent): string {
  return `${content.title}\n${content.url}`;
}

/** The URL to open for one channel. `mailto:` for email, https for the rest. */
export function shareChannelUrl(channel: ShareChannel, content: ShareContent): string {
  const url = encodeURIComponent(content.url);
  const title = encodeURIComponent(content.title);
  const message = encodeURIComponent(shareMessage(content));

  switch (channel) {
    // wa.me is WhatsApp's own documented entry point and resolves on both desktop and mobile —
    // it hands off to the installed app when there is one and to web.whatsapp.com when there is
    // not, which api.whatsapp.com/send does not do as reliably from a mobile browser.
    case 'whatsapp':
      return `https://wa.me/?text=${message}`;
    case 'facebook':
      return `https://www.facebook.com/sharer/sharer.php?u=${url}`;
    case 'telegram':
      return `https://t.me/share/url?url=${url}&text=${title}`;
    case 'email':
      return `mailto:?subject=${title}&body=${message}`;
  }
}
