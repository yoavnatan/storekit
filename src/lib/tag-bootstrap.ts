/**
 * The two third-party tag loaders, as ONE definition each.
 *
 * They lived inline in `BaseLayout.astro`, which was right while the server was the only thing that
 * ever started them. It is not, since consent (2026-08-25): with no decision recorded the page ships
 * no tag at all, so the moment a visitor accepts, the BROWSER has to start exactly what the server
 * would have written — and a bootstrap copied into a second file is a bootstrap that gets a
 * parameter added in one of them.
 *
 * **These return executable JS as a STRING on purpose, for both callers.** The server inlines it in
 * `<head>`; the client sets it as a `<script>`'s `textContent`, which runs it identically. Two
 * environments, one implementation, no second version of the snippet either vendor published. The
 * site's CSP allows `'unsafe-inline'` for scripts (`lib/csp.ts` says why), which is what makes the
 * client half work; if that ever becomes nonce-based, the injection is what has to change, not this.
 *
 * **`tests/consent.test.ts` pins that both strings name the origins the CSP actually allows** —
 * a loader pointed at a host `script-src` does not list is a tag that silently never loads, and
 * "the ads are not recording anything" is not a symptom anybody traces back to a header.
 */

/** Google Tag Manager's loader origin. Must stay in `script-src` (`lib/csp.ts`). */
export const TAG_MANAGER_ORIGIN = 'https://www.googletagmanager.com';
/** Meta's pixel loader origin. Must stay in `script-src` (`lib/csp.ts`). */
export const AD_PIXEL_ORIGIN = 'https://connect.facebook.net';

/** GTM's published container snippet, verbatim apart from the id. */
export function gtmHeadScript(id: string): string {
  return `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='${TAG_MANAGER_ORIGIN}/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${id}');`;
}

/** Meta's published pixel snippet, verbatim apart from the id. */
export function metaPixelScript(id: string): string {
  return `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','${AD_PIXEL_ORIGIN}/en_US/fbevents.js');fbq('init','${id}');fbq('track','PageView');`;
}

/**
 * Google Consent Mode v2's `default` call, which must run **before** GTM loads or the container
 * treats the absence of a signal as its own default.
 *
 * Emitted on EVERY page, including pages that ship no tag at all — it costs four lines and it is
 * what makes a later `update` meaningful. `gtag` here is the tiny shim Google's own documentation
 * uses; it pushes `arguments` into the dataLayer untouched, and must not be "cleaned up" into a
 * rest parameter, which serialises differently and is not what the container reads.
 */
export function consentDefaultScript(signal: Record<string, 'granted' | 'denied'>): string {
  const pairs = Object.entries(signal).map(([k, v]) => `'${k}':'${v}'`).join(',');
  return `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('consent','default',{${pairs},'wait_for_update':500});`;
}
