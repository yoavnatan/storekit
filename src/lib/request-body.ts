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
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
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
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as T };
  } catch {
    return { ok: false, status: 400 };
  }
}
