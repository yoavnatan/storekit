/**
 * Reading a JSON body from an untrusted request, with a cap that is actually enforced.
 *
 * **`Content-Length` is a claim by the sender, not a measurement.** Both unauthenticated POST
 * endpoints in this application used to cap their body with
 *
 * ```ts
 * const len = Number(request.headers.get('content-length') ?? 0);
 * if (len > MAX) return new Response(null, { status: 413 });
 * await request.json();
 * ```
 *
 * — and a request that simply omits the header (any chunked request does) reads as `0`, sails past
 * the check, and is then buffered and parsed in full. The cap protected against a large body sent
 * honestly and against nothing else, which is the worst kind of limit: one that makes the endpoint
 * look bounded. The comment above one of them even stated it could not happen.
 *
 * This reads the stream itself and stops at the ceiling, so the bytes are counted rather than
 * trusted. The declared length is still honoured first — rejecting an honest 5MB upload without
 * reading it is strictly better than reading 2KB of it before giving up.
 */

/**
 * The ceilings, as a vocabulary rather than a number per route.
 *
 * Twenty-eight call sites each picking their own limit is twenty-eight chances to pick one that is
 * too tight for a real seller, and no way to see the set. These four cover every body this
 * application accepts, and every one of them is far above what the matching UI can produce — the
 * point is to bound memory, not to validate a payload. Field-level caps still belong in the route.
 */
export const BODY_LIMIT = {
  /** An action and an id or two — a toggle, a status flip, a mark-as-read. */
  control: 8_000,
  /** A form's worth of fields, free text included (a message, a campaign, a profile). */
  form: 32_000,
  /** A whole collection in one body: a cart, a wishlist, an order being edited line by line. */
  collection: 256_000,
  /** A catalogue import — a CSV inlined into JSON. ~50,000 product rows. */
  upload: 5_000_000,
} as const;

export type BodyResult<T> =
  | { ok: true; value: T }
  /** 413 — over the cap. 400 — absent, truncated, or not JSON. */
  | { ok: false; status: 413 | 400 };

/**
 * Read at most `maxBytes` of `request` and parse it as JSON.
 *
 * The decoder is `fatal: true`: a byte sequence that is not valid UTF-8 is a rejected body, not a
 * string full of replacement characters that then fails to parse for a confusing reason.
 */
export async function readJsonBody<T = unknown>(request: Request, maxBytes: number): Promise<BodyResult<T>> {
  const read = await readText(request, maxBytes);
  if (!read.ok) return read;
  try {
    return { ok: true, value: JSON.parse(read.value) as T };
  } catch {
    return { ok: false, status: 400 };
  }
}

/**
 * The same bounded read, decoded as an HTML form body (`application/x-www-form-urlencoded`), on a
 * request whose body SOMEBODY ELSE still has to read.
 *
 * Added for the CSRF gate (lib/csrf.ts), which has to find one hidden field in a body the page
 * route will read again afterwards — so it hands over a `request.clone()`. Two things follow, and
 * both were measured rather than assumed:
 *
 *  - It could not simply `await clone.formData()`. That buffers whatever arrives with no ceiling,
 *    which is the exact shape this module exists to refuse.
 *  - It must NOT cancel the reader when it gives up. `clone()` tees the stream, and a `cancel()` on
 *    one branch of a tee never settles while the other branch is still live — the middleware would
 *    hang forever, holding the request open, on any oversized form POST. Abandoning the read
 *    instead stops pulling, so the source stops being drained (measured: it produced 49KB past a
 *    32KB ceiling and no more) and the other branch still reads the body in full.
 */
export async function readFormBody(request: Request, maxBytes: number): Promise<BodyResult<URLSearchParams>> {
  const read = await readText(request, maxBytes, { cancelOnOverflow: false });
  if (!read.ok) return read;
  try {
    return { ok: true, value: new URLSearchParams(read.value) };
  } catch {
    return { ok: false, status: 400 };
  }
}

/**
 * The shared half: at most `maxBytes` of the body, as text.
 *
 * The declared length is still honoured first — rejecting an honest 5MB upload without reading it
 * is strictly better than reading 2KB of it before giving up — but the bytes that actually arrive
 * are what the ceiling is applied to.
 */
async function readText(
  request: Request,
  maxBytes: number,
  { cancelOnOverflow = true }: { cancelOnOverflow?: boolean } = {},
): Promise<BodyResult<string>> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };

  const body = request.body;
  if (!body) return { ok: false, status: 400 };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      // Over the ceiling: stop reading and drop what arrived. Cancelling the stream matters as much
      // as the status code — without it the sender keeps writing into a request nobody is draining.
      // The one caller that must not cancel is `readFormBody` on a clone; its header says why.
      if (total > maxBytes) {
        if (cancelOnOverflow) await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 }; // connection dropped mid-body
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }

  try {
    return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(buffer) };
  } catch {
    return { ok: false, status: 400 };
  }
}
