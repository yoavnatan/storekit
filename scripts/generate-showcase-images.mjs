#!/usr/bin/env node
/**
 * Showcase-store imagery — generate it, then host it.
 *
 *   npm run showcase:images -- --check    # ONE image, then report exactly what happened
 *   npm run showcase:images               # the whole catalog, resumable
 *   npm run showcase:images -- --store=showcase-home --limit=5
 *   npm run showcase:images -- --force    # regenerate even what the manifest already has
 *
 * ── Why generated and not photographed or borrowed (owner, 2026-08-12) ───────
 * "לא לשים תמונות מזויפות, עדיף מג׳ונרטות". The catalog this replaces used
 * scraped photographs of real Nike, Apple and Prada products, which on a live
 * commercial domain is somebody else's copyright next to somebody else's
 * trademark. Generated imagery is ours, is consistent across a hundred products
 * in a way stock photography never is, and lets the backdrop be a per-store
 * decision — which is what makes שקמה read as a different shop from סהר rather
 * than as the same grid with different objects in it.
 *
 * ── The two-step, and why it is two ─────────────────────────────────────────
 * Gemini returns image BYTES. The application only ever renders a URL, through
 * `lib/cdn.ts`. So every image is uploaded to Cloudinary — the same unsigned
 * preset the seller dashboard uploads through — and it is the Cloudinary URL
 * that lands on the product row. Nothing about a showcase product is special by
 * the time the storefront reads it, which is the property that makes these
 * stores editable from the dashboard like any other.
 *
 * ── Idempotent by manifest, because this run costs real money ───────────────
 * `image-manifest.json` maps a stable key to a delivered URL. A re-run skips
 * everything already in it, so an interrupted run resumes for free and a second
 * run of the seeder costs nothing at all. The key is `<store>:<product name>` —
 * readable on purpose, so a diff of the manifest says which products changed.
 * Renaming a product regenerates its picture, which is correct: the name is what
 * the picture is OF.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOWCASE_STORES, imagePrompt, bannerPrompt, logoPrompt, lockupUrl, markCutUrl, IMAGE_SIZE, BANNER_IMAGE_SIZE, IMAGE_ASPECT, BANNER_ASPECT, BANNER_DELIVERED_RATIO, viewsForProduct } from './lib/showcase/identity.mjs';
import { jsonlLine, uploadJsonl, createBatch, getBatch, downloadResults, readResults } from './lib/showcase/gemini-batch.mjs';
import { FASHION_PRODUCTS } from './lib/showcase/catalog-fashion.mjs';
import { HOME_PRODUCTS } from './lib/showcase/catalog-home.mjs';
import { TECH_PRODUCTS } from './lib/showcase/catalog-tech.mjs';
import { PLANT_PRODUCTS } from './lib/showcase/catalog-plants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'lib/showcase/image-manifest.json');
/** Scratch for `--batch`: the request JSONLs and the (very large) results files. Gitignored, and
 *  outside `scripts/lib/` on purpose so nothing here is ever mistaken for source. */
const BATCH_DIR = join(HERE, '..', '.showcase-batch');
const BATCH_STATE = join(BATCH_DIR, 'state.json');

const CATALOGS = {
  'showcase-fashion': FASHION_PRODUCTS,
  'showcase-home': HOME_PRODUCTS,
  'showcase-tech': TECH_PRODUCTS,
  'showcase-plants': PLANT_PRODUCTS,
};


// ── Args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const CHECK = has('--check');
const FORCE = has('--force');
const COST_ONLY = has('--cost');
const BATCH = has('--batch');
const SAMPLE = has('--sample');
const ONLY_STORE = val('store');
const LIMIT = Number(val('limit') || 0) || (CHECK ? 1 : 0);
/** `--views=main` generates only the primary catalog shot for every product and skips the gallery
 *  extras. That is the staging lever: the mains are what the grid, the cart, the feed and the
 *  product hero all read, so a run of just those leaves a complete, sharp shop — the galleries are
 *  the reward for clicking and can be bought later, out of the same manifest, without repaying for
 *  anything. See the cost table under `--cost`. */
const ONLY_VIEWS = (val('views') || '').split(',').filter(Boolean);

/**
 * The model, and what it costs.
 *
 * Prices are per IMAGE, off Google's published pricing page (verified 2026-08-12), and they are
 * here rather than in a comment because `--cost` prints real money from them — a number nobody
 * maintains is a number nobody can act on. Batch halves every one of them (see `--batch`).
 *
 * Pro was the default for one round, after the owner asked whether we were even using the right
 * tool ("התמונות מרגישות לי ירודות"). It is measurably stronger on fabric weave, glazed ceramic,
 * brushed metal and skin on a hand — which is most of this catalog. But at 724 images the gap is
 * $97 against $73 interactive, and the budget for this run is real, so the default is now the one
 * the money allows and the sample is what decides whether the difference is visible at all.
 *
 * `gemini-2.5-flash-image` is listed because it is the cheapest thing that exists, and excluded
 * from being useful here by `maxSize`: it caps at 1024px, and `lib/cdn.ts` uses `c_limit`, which
 * never upscales — so the product page's own lightbox (`w_1600`) would be served a 1024px file and
 * stretch it. That is the pixelation the owner ruled out, bought for $8.
 */
const MODELS = {
  pro: { id: 'gemini-3-pro-image', price: { '1K': 0.134, '2K': 0.134, '4K': 0.24 }, maxSize: '4K' },
  flash: { id: 'gemini-3.1-flash-image', price: { '1K': 0.067, '2K': 0.101, '4K': 0.151 }, maxSize: '4K' },
  'flash-lite': { id: 'gemini-3.1-flash-lite-image', price: { '1K': 0.067, '2K': 0.101, '4K': 0.151 }, maxSize: '4K' },
  'flash-2.5': { id: 'gemini-2.5-flash-image', price: { '1K': 0.039, '2K': 0.039, '4K': 0.039 }, maxSize: '1K' },
};
// `--fast` used to be how you asked for Flash. Flash is now the default, so the flag selects what
// it always did and is kept only so an invocation someone already has written down still works.
const MODEL_KEY = val('model') || 'flash';
if (!MODELS[MODEL_KEY]) {
  console.error(`\n❌ --model=${MODEL_KEY} is not one of: ${Object.keys(MODELS).join(', ')}\n`);
  process.exit(1);
}
const MODEL = MODELS[MODEL_KEY].id;
/** Batch is the same models at half price, in exchange for waiting — Google's own words are "50%
 *  of the standard interactive API cost for the equivalent model", with a 24-hour turnaround that
 *  in practice is far shorter. Every image model here reports `batchGenerateContent` as supported,
 *  checked against the live ListModels response rather than the docs. */
const priceOf = (size, modelKey = MODEL_KEY) => MODELS[modelKey].price[size] * (BATCH ? 0.5 : 1);
/** A job's own price: the eight lettering images run on Pro regardless of `--model`. */
/** A composed job is free — it is a Cloudinary transform of images already paid for, so it must
 *  not be priced as generation. Pricing it would make `--cost` overstate the bill and, worse, make
 *  a run that is entirely composition look like one worth postponing. */
const jobPrice = (j) => (j.compose ? 0 : priceOf(j.size ?? IMAGE_SIZE, j.modelKey ?? MODEL_KEY));

// ── Manifest ────────────────────────────────────────────────────────────────
const loadManifest = () => (existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : {});
/**
 * Write the manifest by MERGING onto whatever is on disk, never by replacing it.
 *
 * This function used to serialise its in-memory copy over the file, which is correct only while
 * exactly one process is writing. Two are, routinely: a long batch run collects in the background
 * while a short interactive run regenerates one banner or one logo in the foreground. Observed
 * 2026-08-13 — two logo entries were deleted so they would be re-made, and the background run's
 * next save silently put them back from a copy of the manifest it had loaded an hour earlier.
 * Nothing errored; the work simply did not happen.
 *
 * Re-reading first makes each save a merge, so concurrent writers add to each other instead of
 * overwriting. It does NOT make a DELETION survive a concurrent writer that still holds the key —
 * that is what `--force` is for, and it is why deleting entries by hand is the wrong way to ask
 * for a regeneration while anything else is running.
 */
function saveManifest(m) {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  const merged = { ...loadManifest(), ...m };
  // Sorted, so the file is a stable diff rather than a reshuffle on every run.
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * One image from Gemini, returned as a Buffer.
 *
 * **Two request shapes are tried, and that is deliberate rather than sloppy.** Google's own docs
 * currently describe image generation two different ways — the long-standing
 * `:generateContent` endpoint, and a newer `/interactions` one — and they disagree about both the
 * request body and where the bytes come back. Rather than guess and have the first paid run fail
 * on a shape mismatch, this tries the documented-longest-standing one and falls back, then reads
 * the image from whichever envelope came back. When the fallback is what worked, it says so, so
 * this comment can eventually be deleted rather than left to rot.
 */
async function generateImage(prompt, apiKey, aspect = IMAGE_ASPECT, size = IMAGE_SIZE, model = MODEL, reference = null) {
  // A gallery view is generated FROM its product's main image so the two show the same object —
  // see `SAME_ITEM_CLAUSE`. The reference goes FIRST: the model reads it as what the following
  // text is about, which is the whole point.
  const parts = reference
    ? [{ inline_data: { mime_type: 'image/jpeg', data: reference.toString('base64') } }, { text: prompt }]
    : [{ text: prompt }];
  const attempts = [
    {
      name: 'generateContent',
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      body: {
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: aspect, imageSize: size },
        },
      },
    },
    {
      name: 'interactions',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      body: {
        model,
        input: [{ type: 'text', text: prompt }],
        response_format: {
          type: 'image', mime_type: 'image/jpeg',
          aspect_ratio: aspect, image_size: size,
        },
      },
    },
  ];

  let lastError = 'no attempt ran';
  let networkFailed = false;
  for (const attempt of attempts) {
    let res;
    try {
      res = await fetch(attempt.url, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(attempt.body),
      });
    } catch (e) {
      // A dropped connection is the other thing that is worth simply doing again — four images in
      // the first full run died on a bare "fetch failed".
      lastError = `${attempt.name}: network error — ${e.message}`;
      networkFailed = true;
      continue;
    }

    const text = await res.text();
    if (!res.ok) {
      // The body is where Google says WHY, and dropping it is how "400" becomes unfixable.
      lastError = `${attempt.name}: HTTP ${res.status} — ${text.slice(0, 400)}`;
      // 401/403 are about the KEY, so a second request shape cannot help and neither can waiting.
      if ([401, 403].includes(res.status)) throw new Error(lastError);
      // 429 is a RATE limit, not a dead key — the whole point of it is that the same request
      // succeeds later. Treating it as fatal is what stopped the first full run at 166 of 408.
      if (res.status === 429) throw Object.assign(new Error(lastError), { retryable: true });
      continue;
    }

    let data;
    try { data = JSON.parse(text); } catch { lastError = `${attempt.name}: response was not JSON`; continue; }

    const b64 = extractImage(data);
    if (b64) {
      if (attempt.name !== 'generateContent') console.log(`   (note: the "${attempt.name}" API shape is the one that works — simplify generateImage())`);
      return Buffer.from(b64, 'base64');
    }
    lastError = `${attempt.name}: 200 OK but no image in the response — ${text.slice(0, 300)}`;
  }
  // A 200 with no image happens too (the model declining a prompt, or returning only text), and it
  // is worth one more go — the same subject usually succeeds on a re-ask.
  throw Object.assign(new Error(lastError), { retryable: networkFailed });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `generateImage` with backoff.
 *
 * Rate limits are the normal condition of a 400-image run, not an exception: the first full run
 * stopped at 166 because a single 429 was treated as a dead key. Waiting is the entire remedy, so
 * the retry is generous (up to ~2 minutes across four attempts) and only ever applied to errors
 * that time can actually fix.
 */
async function generateImageWithRetry(prompt, apiKey, aspect, size, model, reference) {
  const WAITS = [8_000, 20_000, 45_000, 90_000];
  for (let i = 0; ; i++) {
    try {
      return await generateImage(prompt, apiKey, aspect, size, model, reference);
    } catch (e) {
      const canRetry = (e.retryable || /HTTP 429|fetch failed|no image in the response/.test(e.message)) && i < WAITS.length;
      if (!canRetry) throw e;
      process.stdout.write(`(rate limited, waiting ${WAITS[i] / 1000}s) `);
      await sleep(WAITS[i]);
    }
  }
}

/** The bytes live in a different place in each envelope; ask for all of them rather than assume. */
function extractImage(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const inline = p.inlineData ?? p.inline_data;
    if (inline?.data) return inline.data;
  }
  return data?.output_image?.data
    ?? data?.output?.[0]?.image?.data
    ?? null;
}

/** Upload to Cloudinary through the same unsigned preset the dashboard uses, and return the
 *  delivered URL. `public_id` is not set: the preset may forbid it, and Cloudinary's own id is
 *  fine because the manifest is what maps a product to its URL. */
/**
 * Cloudinary's unsigned upload refuses anything over 10MB, and a 4K banner can exceed it — אדנית's
 * arrived at 10,699,807 bytes on 2026-08-13 and was rejected after it had already been paid for.
 *
 * There is no image library in this project (no `sharp`), so the bytes cannot be re-compressed
 * here, and adding a native dependency for four images would be the wrong trade. Instead the size
 * is checked BEFORE the upload and the picture is re-generated one step smaller — which costs one
 * extra image rather than losing the one already bought, and can only ever fire on a banner, since
 * nothing else is generated above 2K.
 */
const CLOUDINARY_MAX_BYTES = 10 * 1024 * 1024;

async function uploadToCloudinary(buffer, cloud, preset) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: 'image/jpeg' }), 'showcase.jpg');
  fd.append('upload_preset', preset);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Cloudinary ${res.status} — ${body?.error?.message ?? 'no message'}`);
  if (!body.secure_url) throw new Error('Cloudinary returned no secure_url');
  return body.secure_url;
}

/**
 * Store the banner at the ratio it is DISPLAYED at, so that nothing is ever cropped again.
 *
 * The store header shows a 3:1 band, and `cdnBand` gets there with `ar_3,c_fill,g_auto` — a
 * SALIENCY crop, which picks its own band and cannot be argued with from inside a prompt. Three
 * rounds of banner complaints were all the same sentence in different words ("הכיתוב נחתך",
 * "העציצים ייחתכו", "אלמנטים שנחתכים מלמעלה ולמטה", "לא במידה הנכונה"), and every one of them was
 * that crop rather than the picture.
 *
 * Widening the generated frame (16:9 → 21:9) shrank the loss from 41% of the height to 22%; it did
 * not remove it, because no image model offers 3:1. So the last 22% is taken HERE, once, from the
 * exact centre — which is where every banner prompt composes to — and the cropped result is
 * uploaded as the asset the manifest points at. `cdnBand` then asks a 3:1 source for a 3:1 band
 * and crops nothing at all, on this and on every future delivery.
 *
 * Cloudinary does the cropping because there is no image library in this project (see
 * `CLOUDINARY_MAX_BYTES` for why one is not worth adding for four images a month): the picture is
 * uploaded, fetched back through a `c_fill,g_center` transform, and re-uploaded. It costs one
 * round trip and one JPEG re-encode at `q_auto:best`, and it costs nothing in generation — which
 * is the only budget that is actually scarce here.
 *
 * A real seller's banner still goes through `g_auto` untouched: they upload an arbitrary
 * photograph nobody composed for this band, and saliency is genuinely the best guess there. This
 * is only for the pictures we commission and therefore control.
 */
async function cropToDeliveredRatio(url, ratio, cloud, preset) {
  const cropped = url.replace('/upload/', `/upload/ar_${ratio},c_fill,g_center,f_jpg,q_auto:best/`);
  const res = await fetch(cropped);
  if (!res.ok) throw new Error(`could not fetch the cropped banner (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return uploadToCloudinary(buffer, cloud, preset);
}

/**
 * Cut the empty margin off a header lock-up, so what is stored IS the artwork.
 *
 * Same fetch-transform-reupload shape as `cropToDeliveredRatio` and the same reason for it (no
 * image library in this project), but the opposite job: the banner is cropped to a shape the page
 * fixes, and this is trimmed to a shape the picture chooses.
 *
 * It matters more than it sounds. `Header.astro` CONTAINS the logo in a 176×40 box, so the box's
 * height is only reached by an image whose own ratio is at least 4.4:1. The generated frame is
 * 21:9 — 2.33:1 — with the lock-up composed inside it and white all around, so stored as-is it
 * would render about 93px wide and half the header's height would go to empty white. Trimming the
 * white away leaves the strip the artwork actually is, which fills the box.
 *
 * `e_trim` removes a uniform border; the tolerance is what lets it survive JPEG noise in a "white"
 * that is not bit-identical white, and 15 is low enough to stop at the first real stroke. PNG on
 * the way out because trimming to a strip is exactly when a JPEG's ringing around dark lettering
 * on white becomes visible, and this file is ~30KB either way.
 */
/**
 * A COMPOSED image: one that never reaches the model at all.
 *
 * `job.compose` returns a Cloudinary delivery URL that already IS the finished picture, built out
 * of images the manifest already holds — the header lock-up, cut from a store's own banner and
 * logo (`lockupUrl` in identity.mjs says why). It is fetched and re-uploaded for the same reason
 * `cropToDeliveredRatio` re-uploads: what the manifest points at has to be a stored asset, not a
 * transform of one, or every consumer inherits a transform chain it cannot see and `cdn.ts` layers
 * its own on top of it.
 *
 * Returns false when a source is still missing, which is the same "come back next run" answer a
 * missing reference image gets — not an error.
 */
async function composeJob(job, cloud, preset, manifest) {
  const built = await job.compose(manifest);
  if (!built) return false;
  const res = await fetch(built);
  if (!res.ok) throw new Error(`could not fetch the composed image (${res.status})`);
  const url = await uploadToCloudinary(Buffer.from(await res.arrayBuffer()), cloud, preset);
  manifest[job.key] = url;
  saveManifest(manifest);
  return true;
}

/** Every image this catalog needs, as {key, prompt, label}. Banner and logo first: they are three
 *  of the ~306 and they are the two a person actually looks at, so a `--limit` run shows something
 *  worth judging instead of five handbags. */
function buildJobs() {
  const jobs = [];
  for (const store of SHOWCASE_STORES) {
    if (ONLY_STORE && store.slug !== ONLY_STORE) continue;
    // Banner and logo both carry the shop's NAME as rendered lettering, which is the one thing in
    // this catalog the cheap model is measurably worse at — so these eight images, and only these
    // eight, are generated on Pro. Eight at $0.134 is $1.07 against $0.81, and a misspelt shop name
    // is the single most visible defect the whole run could ship.
    jobs.push({
      key: `${store.slug}:__banner`, prompt: bannerPrompt(store), label: `${store.name} — באנר`,
      aspect: BANNER_ASPECT, size: BANNER_IMAGE_SIZE, model: MODELS.pro.id, modelKey: 'pro',
      // Generated at 21:9, STORED at 3:1 — see `cropToDeliveredRatio`. The banner is the only
      // image here whose delivered shape is fixed by the page rather than by the picture.
      deliverRatio: BANNER_DELIVERED_RATIO,
      // A banner may be generated FROM the store's own logo — שקמה's is the mark at the centre of
      // the picture (`bannerRefKey` in identity.mjs), and describing a mark is not the same as
      // getting that mark back. Same mechanism the gallery views use, pointed at a brand image
      // instead of a product. On a run where the logo does not exist yet this banner is simply
      // held back for the next one, which is what `refKey` already means everywhere else.
      refKey: store.bannerRefKey ? `${store.slug}:${store.bannerRefKey}` : null,
    });
    // A store whose mark already exists inside its own banner does not draw a second one: it CUTS.
    // `compose` instead of `prompt`, exactly like the header lock-up below and for the same reason —
    // a generation from a reference is a redraw, and the owner asked three times for the avatar and
    // the banner's mark to be "*בדיוק* אותו הדבר", which no redraw can promise. `markCutUrl` in
    // identity.mjs carries the four rounds of evidence and the one thing that can break it.
    jobs.push(store.logoCut
      ? {
        key: `${store.slug}:__logo`, label: `${store.name} — לוגו`,
        compose: (manifest) => markCutUrl(store, manifest),
      }
      : {
        key: `${store.slug}:__logo`, prompt: logoPrompt(store), label: `${store.name} — לוגו`,
        aspect: IMAGE_ASPECT, size: IMAGE_SIZE, model: MODELS.pro.id, modelKey: 'pro',
        // A logo may be drawn FROM the store's banner. The pair is directional on purpose: exactly
        // one of `logoRefKey`/`bannerRefKey` may be set per store, or neither picture is the source.
        refKey: store.logoRefKey ? `${store.slug}:${store.logoRefKey}` : null,
        refCrop: store.logoRefCrop ?? null,
      });
    // The header lock-up, for the stores that declare one. Opt-in rather than automatic because
    // `headerLogo` is itself opt-in on a real store — a seller who has not made one keeps the
    // name-in-text header, and a showcase store with no `lockup` demonstrates exactly that.
    //
    // `compose` instead of `prompt`: this image is CUT OUT of the store's own banner and logo
    // rather than generated, so it costs nothing and reproduces exactly. Why, at length, in
    // `lockupUrl`'s note — the short version is that four paid attempts to generate it kept
    // cutting a letter in half or blurring a brush-lettered name, and both the name and the mark
    // already exist as artwork nobody has to redraw.
    if (store.lockup) {
      jobs.push({
        key: `${store.slug}:__headerlogo`, label: `${store.name} — לוגו הדר`,
        compose: (manifest) => lockupUrl(store, manifest),
      });
    }
  }
  for (const store of SHOWCASE_STORES) {
    if (ONLY_STORE && store.slug !== ONLY_STORE) continue;
    // `--sample`: one product per CATEGORY rather than the first N rows. The catalogs are grouped
    // by category, so `--limit=5` returns five dresses — which answers "is the art direction right"
    // for dresses and for nothing else. A spread is the only sample worth paying for.
    const catalog = SAMPLE
      ? Object.values(Object.groupBy(CATALOGS[store.slug], (p) => p.c)).map((rows) => rows[0])
      : CATALOGS[store.slug];
    for (const p of catalog) {
      // One job per VIEW. `main` keeps the bare key so every URL already generated under the old
      // one-image-per-product scheme is still found and not paid for twice.
      const views = SAMPLE ? viewsForProduct(p.n).slice(0, 1) : viewsForProduct(p.n);
      for (const [i, view] of views.entries()) {
        if (ONLY_VIEWS.length && !ONLY_VIEWS.includes(view.key)) continue;
        jobs.push({
          key: i === 0 ? `${store.slug}:${p.n}` : `${store.slug}:${p.n}#${view.key}`,
          prompt: imagePrompt(store, p.s, view, p.n),
          label: `${store.name} — ${p.n}${i === 0 ? '' : ` (${view.key})`}`,
          aspect: IMAGE_ASPECT, size: IMAGE_SIZE,
          // Every gallery view names the main image it has to match. `main` itself has no
          // reference — it is the one that defines what the product looks like.
          refKey: i === 0 ? null : `${store.slug}:${p.n}`,
        });
      }
    }
  }
  return jobs;
}

/**
 * What this run will cost, before it spends anything.
 *
 * Free, and the reason it exists: the first full run was launched blind and the bill arrived after
 * the pictures. Every lever that moves the number — model, batch, `--views=main` — is a flag, so
 * the honest way to choose between them is to price all of them on the actual job list.
 */
const shekels = (usd) => (usd * 3.7).toFixed(usd * 3.7 < 10 ? 2 : 0);

function reportCost(jobs) {
  const total = jobs.reduce((sum, j) => sum + jobPrice(j), 0);
  console.log(`\n💵 ${jobs.length} image(s) still to generate — model ${MODEL_KEY} (${MODEL})`
    + `${BATCH ? ', BATCH (half price, up to 24h)' : ', interactive'}`);
  // Two decimals under ₪10: a four-image touch-up priced itself at "≈ ₪0", which is the one number
  // this report must never print — the whole point of it is to be believed before spending.
  console.log(`   $${total.toFixed(2)}   ≈ ₪${shekels(total)}\n`);
  console.log('   The same job list at the other settings:');
  for (const key of Object.keys(MODELS)) {
    for (const batch of [false, true]) {
      const each = (size) => MODELS[key].price[size] * (batch ? 0.5 : 1);
      const sum = jobs.reduce((s, j) => s + (j.modelKey === 'pro' && key !== 'pro'
        ? MODELS.pro.price[j.size ?? IMAGE_SIZE] * (batch ? 0.5 : 1)   // lettering stays on Pro
        : each(j.size ?? IMAGE_SIZE)), 0);
      const capped = MODELS[key].maxSize === '1K' ? '  ⚠️ caps at 1024px — soft in the lightbox' : '';
      console.log(`     ${(key + (batch ? ' + batch' : '')).padEnd(20)} $${sum.toFixed(2).padStart(7)}${capped}`);
    }
  }
  console.log('');
}

/**
 * The batch run: submit, wait, collect.
 *
 * Half the price of the interactive loop above and otherwise identical in what it leaves behind —
 * the same manifest, the same Cloudinary URLs — so `seed:showcase` cannot tell which one produced
 * a picture. What it costs instead is time (Google says up to 24 hours; in practice much less) and
 * the fact that nothing is visible until a chunk lands.
 *
 * **Resumable at every stage, because this is the run that spans a night.** `.showcase-batch/state.json`
 * remembers the operation name for each chunk, so an interrupted or re-run command re-attaches to
 * jobs already submitted instead of paying for them twice — the manifest alone cannot do that,
 * since a submitted-but-uncollected chunk has been billed and has no URLs yet.
 *
 * Chunked at 100 rather than sent as one 724-row job so that the first pictures arrive while the
 * rest are still queued, and so a single failed job costs a chunk instead of the catalog.
 */
async function runBatched(jobs, apiKey, cloud, preset, manifest) {
  const CHUNK = Number(val('chunk') || 0) || 100;
  // A gallery view is generated FROM its product's main image, so a batch of views cannot be
  // submitted until the mains exist. Rather than fail halfway through a paid run, this splits the
  // work and says so: mains first, then re-run for the galleries.
  const waiting = jobs.filter((j) => j.refKey && !manifest[j.refKey]);
  if (waiting.length && waiting.length < jobs.length) {
    jobs = jobs.filter((j) => !waiting.includes(j));
    console.log(`\n   (${waiting.length} gallery image(s) held back — they are generated from their`);
    console.log('    product\'s main image, which this run is about to create. Re-run --batch after.)');
  } else if (waiting.length) {
    console.log('\n❌ Every job here is a gallery view whose main image does not exist yet.');
    console.log('   Generate the mains first:  npm run showcase:images -- --batch --views=main\n');
    return;
  }
  // A batch job names ONE model, so jobs are grouped by model before they are chunked — otherwise
  // the eight Pro lettering images would be submitted against the Flash endpoint and silently come
  // back in the wrong renderer, which is the one defect this split exists to prevent.
  const chunks = [];
  for (const group of Object.values(Object.groupBy(jobs, (j) => j.model ?? MODEL))) {
    for (let i = 0; i < group.length; i += CHUNK) chunks.push(group.slice(i, i + CHUNK));
  }

  mkdirSync(BATCH_DIR, { recursive: true });
  const state = existsSync(BATCH_STATE) ? JSON.parse(readFileSync(BATCH_STATE, 'utf8')) : {};
  const saveState = () => writeFileSync(BATCH_STATE, `${JSON.stringify(state, null, 2)}\n`);

  const cost = jobs.reduce((s, j) => s + jobPrice(j), 0);
  console.log(`\n🧺 Batch mode — ${jobs.length} image(s) in ${chunks.length} chunk(s) of up to ${CHUNK}.`);
  console.log(`   Model ${MODEL_KEY} at half price: $${cost.toFixed(2)} (≈ ₪${shekels(cost)}).`);
  console.log('   Google allows itself 24 hours and MEANS it — a 100-image job measured on');
  console.log('   2026-08-12 sat in the queue for 10h42m. Interrupt freely: a re-run re-attaches');
  console.log('   to the jobs already submitted and never pays for a chunk twice.\n');

  /**
   * PHASE 1 — submit everything, then wait. This used to submit a chunk, wait ~11 hours for it,
   * then submit the next, which turned a four-chunk run into a three-day one for no reason:
   * Google runs batch jobs independently and in parallel, so the whole set costs one queue wait
   * rather than one per chunk. Measured 2026-08-12/13, and it is the difference between 11 hours
   * and 43 for the same money.
   */
  for (const [i, chunk] of chunks.entries()) {
    const model = chunk[0].model ?? MODEL;
    const id = `${model}|${chunk.length}|${chunk[0].key}|${chunk[chunk.length - 1].key}`;
    if (state[id]?.operation) {
      console.log(`   chunk ${i + 1}/${chunks.length}: already submitted — ${state[id].operation}`);
      continue;
    }
    const jsonlPath = join(BATCH_DIR, `requests-${i + 1}.jsonl`);
    const lines = [];
    for (const j of chunk) lines.push(jsonlLine(j.key, model, j.prompt, j.aspect ?? IMAGE_ASPECT, j.size ?? IMAGE_SIZE, await referenceFor(j, manifest)));
    writeFileSync(jsonlPath, lines.join(''));
    process.stdout.write(`   chunk ${i + 1}/${chunks.length}: uploading ${chunk.length} prompts … `);
    const fileName = await uploadJsonl(apiKey, jsonlPath, `showcase-${i + 1}`);
    const operation = await createBatch(apiKey, model, fileName, `showcase-${i + 1}`);
    state[id] = { operation, submitted: new Date().toISOString() };
    saveState();
    console.log(`submitted (${operation})`);
  }
  console.log(`\n   All ${chunks.length} chunk(s) are queued and running in parallel. Collecting as they land.\n`);

  // PHASE 2 — collect. Each chunk is polled to completion in turn, but they are all already
  // running, so the total wait is the SLOWEST chunk rather than the sum of all of them.
  let done = 0;
  let failed = 0;
  for (const [i, chunk] of chunks.entries()) {
    // A chunk is identified by WHAT IS IN IT, not by its position: change the job list and the
    // stale entry is ignored rather than re-attached to the wrong prompts.
    const model = chunk[0].model ?? MODEL;
    const id = `${model}|${chunk.length}|${chunk[0].key}|${chunk[chunk.length - 1].key}`;
    const tag = `chunk ${i + 1}/${chunks.length}`;


    // Poll. Slowly: this is a job with a 24-hour allowance, and a tight loop buys nothing.
    let job;
    for (let attempt = 0; ; attempt++) {
      job = await getBatch(apiKey, state[id].operation);
      if (job.done || job.error || /SUCCEEDED|FAILED|CANCELLED|EXPIRED/.test(job.state)) break;
      if (attempt === 0) process.stdout.write(`   ${tag}: ${job.state} `);
      process.stdout.write('.');
      await sleep(30_000);
    }
    console.log('');

    if (job.error || /FAILED|CANCELLED|EXPIRED/.test(job.state)) {
      console.log(`   ${tag}: ✗ ${job.error ?? job.state}`);
      failed += chunk.length;
      // The chunk is spent either way; drop the attachment so a re-run can resubmit it deliberately.
      delete state[id];
      saveState();
      continue;
    }

    if (!job.responsesFile) {
      console.log(`   ${tag}: ✗ finished with no results file — nothing to collect`);
      failed += chunk.length;
      continue;
    }

    const resultsPath = join(BATCH_DIR, `results-${i + 1}.jsonl`);
    process.stdout.write(`   ${tag}: downloading results … `);
    await downloadResults(apiKey, job.responsesFile, resultsPath);
    console.log(`${(statSync(resultsPath).size / 1024 / 1024).toFixed(0)}MB`);

    const byKey = new Map(chunk.map((j) => [j.key, j]));
    for await (const row of readResults(resultsPath)) {
      const label = byKey.get(row.key)?.label ?? row.key ?? '(unkeyed row)';
      if (row.error || !row.response) {
        failed++;
        console.log(`      ${label} … ✗ ${row.error ?? 'no response'}`);
        continue;
      }
      const b64 = extractImage(row.response);
      if (!b64) {
        failed++;
        console.log(`      ${label} … ✗ finished with no image in the envelope`);
        continue;
      }
      try {
        const raw = await uploadToCloudinary(Buffer.from(b64, 'base64'), cloud, preset);
        const job = byKey.get(row.key);
        let url = raw;
        if (job?.deliverRatio) url = await cropToDeliveredRatio(url, job.deliverRatio, cloud, preset);
        manifest[row.key] = url;
        saveManifest(manifest);   // after EVERY image, same as the interactive path
        done++;
      } catch (e) {
        failed++;
        console.log(`      ${label} … ✗ ${e.message}`);
      }
    }
    console.log(`   ${tag}: ✓ ${done} collected so far.`);
    // Collected chunks stay in the state file only as a record; the manifest is what stops a re-run.
    state[id].collected = new Date().toISOString();
    saveState();
    rmSync(resultsPath, { force: true });   // hundreds of MB of base64, already banked as URLs
  }

  console.log(`\n✅ ${done} generated, ${failed} failed, ${Object.keys(manifest).length} in the manifest total.`);
  if (failed) console.log('   Re-run with --batch to retry only the failures — finished images are skipped.\n');
  else console.log('   Now write them into the database:  npm run seed:showcase\n');
}

/**
 * The main image a gallery view has to match, as JPEG bytes, or null.
 *
 * Fetched from Cloudinary at a reduced width rather than at 2K: the reference is there to fix the
 * product's shape, colour and pattern, and 1024px carries all three. It also keeps the request
 * small, which matters when 320 of these are going through the batch API in one file.
 *
 * A missing reference is NOT an error — it means the main has not been generated yet, and the
 * caller skips the job so a later run can pick it up once the main exists.
 */
async function referenceFor(job, manifest) {
  if (!job.refKey) return null;
  const url = manifest[job.refKey];
  if (!url) return null;
  // `refCrop` cuts the reference down to the ONE thing the job is about before it is sent.
  //
  // It exists because the plain version failed in a way worth recording: סהר's logo was generated
  // from its banner so the two crescents would match, and what came back was a soft blurred copy
  // of the whole shop with no mark in it at all. A model shown a picture reproduces the PICTURE —
  // "redraw only the small object on the right, flat" loses to a photograph of a room.
  //
  // Cropping fixes the premise rather than arguing with it: hand it an image that IS the mark and
  // the ordinary behaviour is the wanted one. The crop is a Cloudinary transform, so it costs no
  // generation and no local image library — the same reason `cropToDeliveredRatio` is built that
  // way. Fractional geometry (`x_0.85,w_0.095`), so it survives the source being re-rendered at a
  // different pixel size.
  const transform = `${job.refCrop ? `${job.refCrop}/` : ''}w_1024,q_auto:good,f_jpg`;
  const res = await fetch(url.replace('/upload/', `/upload/${transform}/`));
  if (!res.ok) throw new Error(`could not fetch the reference image (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** The job list this invocation would actually pay for, after the manifest and the flags. */
function pendingJobs(manifest) {
  let jobs = buildJobs();
  if (!FORCE) jobs = jobs.filter((j) => !manifest[j.key]);
  if (LIMIT) jobs = jobs.slice(0, LIMIT);
  return jobs;
}

async function main() {
  // Pricing needs no key and must never be gated behind one: the whole point of `--cost` is to be
  // runnable before deciding whether to spend anything at all.
  if (COST_ONLY) { reportCost(pendingJobs(loadManifest())); return; }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('\n❌ GEMINI_API_KEY is not set. See .env.example — it names the two pages you need\n'
      + '   (create the key, then upgrade the project to a paid tier; the image models are paid-only).\n');
    process.exit(1);
  }
  const cloud = process.env.PUBLIC_CLOUDINARY_CLOUD_NAME;
  const preset = process.env.PUBLIC_CLOUDINARY_UPLOAD_PRESET;
  if (!cloud || !preset) {
    console.error('\n❌ PUBLIC_CLOUDINARY_CLOUD_NAME / PUBLIC_CLOUDINARY_UPLOAD_PRESET are not set — see .env.example.\n');
    process.exit(1);
  }

  const manifest = loadManifest();
  const jobs = pendingJobs(manifest);

  if (!jobs.length) {
    console.log(`\n✅ Nothing to do — all ${Object.keys(manifest).length} images are already in the manifest.`);
    console.log('   Use --force to regenerate.\n');
    return;
  }

  // `--batch` is a way of buying GENERATION at half price. A composed job buys nothing, has no
  // prompt to put in a JSONL line, and takes a second — so it is done here on the spot and only
  // what is left goes to the batch API. Without this split a composed job would be written into
  // the request file with an empty prompt and come back as a picture of nothing.
  if (BATCH) {
    for (const job of jobs.filter((j) => j.compose)) {
      process.stdout.write(`   ${job.label} … `);
      try { console.log(await composeJob(job, cloud, preset, manifest) ? '✓ composed' : '— skipped: a source image does not exist yet'); }
      catch (e) { console.log(`✗\n      ${e.message}`); }
    }
    await runBatched(jobs.filter((j) => !j.compose), apiKey, cloud, preset, manifest);
    return;
  }

  if (CHECK) {
    console.log('\n🔎 Check mode — one image, to prove the key and the billing tier are live.\n');
  } else {
    console.log(`\n🎨 ${jobs.length} image(s) to generate. Already done: ${Object.keys(manifest).length}.`);
    console.log('   Interrupt any time — finished images are saved as they go and a re-run resumes.\n');
  }

  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    process.stdout.write(`   ${job.label} … `);
    try {
      if (job.compose) {
        if (await composeJob(job, cloud, preset, manifest)) {
          done++;
          console.log('✓ composed from this store\'s own banner and logo — no generation');
        } else {
          console.log('— skipped: one of the images it is built from does not exist yet');
        }
        continue;
      }
      const reference = await referenceFor(job, manifest);
      if (job.refKey && !reference) {
        console.log('— skipped: its main image does not exist yet');
        continue;
      }
      let bytes = await generateImageWithRetry(job.prompt, apiKey, job.aspect, job.size, job.model ?? MODEL, reference);
      if (bytes.length > CLOUDINARY_MAX_BYTES && job.size === '4K') {
        process.stdout.write(`(${(bytes.length / 1048576).toFixed(1)}MB is over Cloudinary's limit, re-making at 2K) `);
        bytes = await generateImageWithRetry(job.prompt, apiKey, job.aspect, '2K', job.model ?? MODEL, reference);
      }
      const raw = await uploadToCloudinary(bytes, cloud, preset);
      const url = job.deliverRatio
        ? await cropToDeliveredRatio(raw, job.deliverRatio, cloud, preset)
        : raw;
      manifest[job.key] = url;
      saveManifest(manifest);   // after EVERY image: a crash must not discard what was paid for
      done++;
      console.log(`✓ ${(bytes.length / 1024).toFixed(0)}KB${job.deliverRatio ? `, stored at ${job.deliverRatio}:1` : ''}`);
    } catch (e) {
      failed++;
      console.log('✗');
      console.log(`      ${e.message}`);
      if (CHECK) break;
      // Only a dead KEY stops the run now. A 429 survived four backoffs to get here, so waiting
      // longer inside this process is not the answer either — but the manifest holds everything
      // already paid for, so a later re-run picks up exactly where this stopped.
      if (/HTTP (401|403)/.test(e.message)) {
        console.log('\n   Stopping — that error is about the key itself, not this image.\n');
        break;
      }
    }
  }

  if (CHECK) {
    if (done) {
      console.log(`\n✅ It works. The key is live and the project is on a paid tier.`);
      console.log(`   ${manifest[jobs[0].key]}`);
      console.log('   Open that URL to see what the art direction actually produced, then run the full set:');
      console.log('     npm run showcase:images\n');
    } else {
      console.log('\n❌ Did not work. The message above is Google\'s own — the usual causes:');
      console.log('   • 429 / RESOURCE_EXHAUSTED on the FIRST call = the project is still free-tier.');
      console.log('     The image models are paid-only. Upgrade at https://aistudio.google.com/billing');
      console.log('   • 403 = the Generative Language API is not enabled on that project.');
      console.log('     https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com');
      console.log('   • 400 API_KEY_INVALID = the key is from a different project than the one you enabled.\n');
      process.exit(1);
    }
    return;
  }

  console.log(`\n✅ ${done} generated, ${failed} failed, ${Object.keys(manifest).length} in the manifest total.`);
  if (failed) console.log('   Re-run to retry only the failures — finished images are skipped.\n');
  else console.log('   Now write them into the database:  npm run seed:showcase\n');
}

main().catch((e) => { console.error('\nshowcase image generation failed:', e.message, '\n'); process.exit(1); });
