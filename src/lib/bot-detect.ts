/**
 * Is this request an automated client rather than a shopper?
 *
 * Used to keep crawlers, previewers and monitors out of the seller-facing
 * numbers (`store-pageviews.ts`, `product-pageviews.ts`, `analytics.ts`).
 *
 * This matters more here than on a typical site: SEO is the platform's primary
 * acquisition bet, and `public/robots.txt` deliberately INVITES thirteen-plus
 * crawlers (Googlebot, Bingbot and the AI fleet — GPTBot, ClaudeBot,
 * PerplexityBot, CCBot…). Every one of those visits was being counted as a page
 * view a seller sees in their performance tab. The failure is quiet and
 * expensive: a seller reads "480 views, 0 orders" and concludes the mall sends
 * traffic that never buys, when most of it was never a person.
 *
 * Detection is by User-Agent only — deliberately. Reverse-DNS verification is
 * what you need to *trust* a bot's identity (to serve it different content);
 * here we only need to *exclude* it from a counter, where a spoofed UA that
 * opts itself out is harmless and a missed bot just leaves today's behaviour.
 *
 * Bias: a false positive costs one uncounted view, a false negative inflates a
 * number the seller makes decisions on — so borderline clients (headless
 * browsers, HTTP libraries, link previewers) are treated as bots.
 */

/**
 * Named clients, matched as plain substrings. Covers the crawlers robots.txt
 * names, the major search engines, link-preview fetchers (a WhatsApp share
 * unfurling a product link is not a visit), uptime monitors, headless browsers
 * (our own Playwright runs included) and bare HTTP libraries.
 */
const NAMED = [
  // AI crawlers — the ones robots.txt explicitly welcomes
  'gptbot', 'oai-searchbot', 'chatgpt-user', 'perplexitybot', 'perplexity-user',
  'claudebot', 'anthropic-ai', 'claude-web', 'google-extended', 'applebot',
  'amazonbot', 'meta-externalagent', 'ccbot', 'bytespider', 'diffbot', 'omgili',
  // Search engines
  'googlebot', 'bingbot', 'adsbot', 'mediapartners', 'duckduckbot', 'yandex',
  'baiduspider', 'slurp', 'sogou', 'exabot', 'seznambot', 'petalbot',
  // Link previewers / social unfurlers
  'facebookexternalhit', 'twitterbot', 'linkedinbot', 'pinterest', 'redditbot',
  'whatsapp', 'telegrambot', 'slackbot', 'discordbot', 'embedly', 'quora link',
  'skypeuripreview', 'vkshare', 'tumblr', 'flipboard', 'nuzzel', 'outbrain',
  // Monitors, auditors, headless browsers, libraries
  'uptimerobot', 'pingdom', 'statuscake', 'site24x7', 'newrelicpinger',
  'headlesschrome', 'phantomjs', 'lighthouse', 'chrome-lighthouse', 'pagespeed',
  'gtmetrix', 'playwright', 'puppeteer', 'selenium', 'cypress',
  'curl/', 'wget', 'python-requests', 'python-urllib', 'aiohttp', 'httpx',
  'axios', 'node-fetch', 'undici', 'go-http-client', 'okhttp', 'java/',
  'libwww-perl', 'ruby', 'guzzlehttp', 'postman', 'insomnia', 'apache-httpclient',
];

/**
 * Generic fallbacks for crawlers not named above.
 *
 * `bot\b` rather than a bare `bot`: the trailing word boundary is what keeps
 * "Googlebot/2.1" and "SomeNewBot/1.0" matching while leaving the Android
 * phone-brand UAs ("CUBOT_NOTE_20", "CUBOT_X19") alone — their `BOT` is
 * followed by `_`, a word character, so no boundary and no false positive.
 */
const GENERIC = /(?:bot\b|bot\/|crawler|crawling|spider|scraper|feedfetcher|\+https?:\/\/)/i;

/** True when the User-Agent looks like anything other than a person's browser. */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true; // a real browser always sends one; a blank UA is a script
  const ua = userAgent.toLowerCase();
  if (NAMED.some((token) => ua.includes(token))) return true;
  return GENERIC.test(ua);
}

/** Convenience for a Request/Headers-holding caller. */
export function isBotRequest(request: { headers: { get(name: string): string | null } }): boolean {
  return isBotUserAgent(request.headers.get('user-agent'));
}
