-- 0022_generated_artifacts — where a pre-built public document lives (GO_LIVE §7).
--
-- **What it replaces.** `/api/feed/products.xml` and `/sitemap-content.xml` assembled the WHOLE
-- platform catalogue, in memory, on every request. Measured in this repository: 45 stores took the
-- feed to 6.1 seconds. Node serves one event loop, so for those seconds every other request in the
-- process is waiting — a shopper at checkout included — and at a thousand sellers the same shape is
-- a several-hundred-megabyte string in a single process, which is an OOM rather than a slow page.
-- `single-flight.ts` and a 1h `Cache-Control` restrained that (concurrent pulls share one build,
-- serial flooding goes to the CDN); neither moved the build out of the process serving buyers.
-- `products.xml.ts`'s own comment had said since the JSON era that this becomes "a cached/generated
-- artifact" once the data lives in Postgres. It does now, and this is that artifact.
--
-- **Why a table and not `app_settings`.** `app_settings` is a keyed `jsonb` store for two-field
-- settings (`platform-ads.ts`, `admin-tab-views.ts`). A feed document is text in the tens of
-- megabytes, it is not JSON, and jsonb is parsed and re-serialised on every read and write — the
-- one storage shape that would put the whole document back in memory as a value, which is the cost
-- this table exists to remove. Nor a file on disk: an atomic deploy replaces the directory (§7) and
-- several instances share nothing, so the artifact would silently differ per instance and vanish on
-- release. Postgres is the one place all instances already agree on, and TOAST stores and
-- compresses large text out of line without anybody asking it to.
--
-- **Why PARTS and not one `text` column.** A single column means the writer holds the finished
-- document as one string to insert it, and the reader holds it again to send it — exactly the
-- process-sized allocation we are removing, just moved off the request path. In chunks the build
-- flushes every ~256KB and the response streams part by part, so neither side ever holds more than
-- one part. It is also what lets the build BREATHE: the writer awaits a real insert every part, and
-- an await is what hands the event loop back to the shoppers.
--
-- **Why a generation instead of writing in place.** A rebuild must never be visible half-written —
-- a feed that is briefly missing half the catalogue tells Merchant Center that half the platform's
-- products are gone, and that answer is acted on before the next build corrects it. So parts are
-- written under a NEW generation and the pointer moves in one statement at the end; a reader
-- either sees the whole old document or the whole new one. The previous generation is kept, not
-- deleted, so a slow reader already streaming it finishes rather than hitting a hole (see
-- `artifacts.ts#publishArtifact` — it keeps exactly two).
--
-- No `state`/`building` column, for the same reason 0007 has none: "being built" is derivable (a
-- generation with parts that the pointer does not name) and a second field saying it is a second
-- field that can disagree after a crash. An abandoned build leaves orphan parts, which the next
-- successful publish clears.

CREATE SEQUENCE IF NOT EXISTS generated_artifact_generation_seq;

CREATE TABLE IF NOT EXISTS generated_artifacts (
  -- The document, e.g. 'feed:products.xml'. Stable — it is what the route asks for, so renaming one
  -- serves 503 until the next build, exactly like renaming a job re-runs it.
  name            text PRIMARY KEY,
  -- Which generation's parts ARE the document right now. The whole atomicity of a rebuild is this
  -- one column moving.
  live_generation bigint NOT NULL,
  -- Stamped when the pointer moved, so "how old is what we are serving" is answerable without
  -- reading a byte of it. This is the number that decides whether a stale artifact is a problem.
  built_at        timestamptz NOT NULL DEFAULT now(),
  part_count      integer NOT NULL,
  -- UTF-8 bytes of the whole document. Sent as `Content-Length` — a puller fetching tens of
  -- megabytes should know how many before it starts, and it costs nothing to have counted them
  -- while writing.
  byte_size       bigint NOT NULL,
  -- One human line for whoever is reading this table during an incident ("45 stores · 1,204 items"),
  -- the same role `job_runs.last_detail` plays. Not a payload.
  detail          text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS generated_artifact_parts (
  name       text NOT NULL,
  generation bigint NOT NULL,
  -- 0-based. Concatenating every part of one generation in this order IS the document, byte for
  -- byte — the separators live inside the parts, so the reader never adds anything of its own.
  idx        integer NOT NULL,
  body       text NOT NULL,
  PRIMARY KEY (name, generation, idx)
);

-- No foreign key to `generated_artifacts`: parts are written BEFORE the meta row names their
-- generation, which is the whole point of the swap. A reference would have to be satisfied by a
-- row that does not exist yet.
--
-- No index beyond the primary key. Every read is `WHERE name = $1 AND generation = $2` with or
-- without `idx` — a prefix of the key — and the only other statement is the delete at publish time,
-- which is also by name.
