// Trailing-slash trimming, in one place and in linear time.
//
// The obvious `value.replace(/\/+$/, '')` is quadratic: for a string of N slashes that never
// satisfies the anchor, the engine retries the run from every position. Measured at introduction,
// 64k slashes took 4.3 seconds — and one of the callers below feeds it `Astro.url.pathname`, which
// is whatever the request line said. On single-threaded SSR that is the whole server stalling, so
// this scans backwards once instead.

const SLASH = '/'.charCodeAt(0);

/** `value` without its trailing slashes. Linear in the input, whatever the input. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH) end--;
  return value.slice(0, end);
}
