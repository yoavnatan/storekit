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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOWCASE_STORES, imagePrompt, bannerPrompt, logoPrompt, IMAGE_SIZE, IMAGE_ASPECT, BANNER_ASPECT } from './lib/showcase/identity.mjs';
import { FASHION_PRODUCTS } from './lib/showcase/catalog-fashion.mjs';
import { HOME_PRODUCTS } from './lib/showcase/catalog-home.mjs';
import { TECH_PRODUCTS } from './lib/showcase/catalog-tech.mjs';
import { PLANT_PRODUCTS } from './lib/showcase/catalog-plants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'lib/showcase/image-manifest.json');

const CATALOGS = {
  'showcase-fashion': FASHION_PRODUCTS,
  'showcase-home': HOME_PRODUCTS,
  'showcase-tech': TECH_PRODUCTS,
  'showcase-plants': PLANT_PRODUCTS,
};

const MODEL = 'gemini-3.1-flash-image';

// ── Args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const CHECK = has('--check');
const FORCE = has('--force');
const ONLY_STORE = val('store');
const LIMIT = Number(val('limit') || 0) || (CHECK ? 1 : 0);

// ── Manifest ────────────────────────────────────────────────────────────────
const loadManifest = () => (existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : {});
function saveManifest(m) {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  // Sorted, so the file is a stable diff rather than a reshuffle on every run.
  const sorted = Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
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
async function generateImage(prompt, apiKey, aspect = IMAGE_ASPECT) {
  const attempts = [
    {
      name: 'generateContent',
      url: `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      body: {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: aspect, imageSize: IMAGE_SIZE },
        },
      },
    },
    {
      name: 'interactions',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      body: {
        model: MODEL,
        input: [{ type: 'text', text: prompt }],
        response_format: {
          type: 'image', mime_type: 'image/jpeg',
          aspect_ratio: aspect, image_size: IMAGE_SIZE,
        },
      },
    },
  ];

  let lastError = 'no attempt ran';
  for (const attempt of attempts) {
    let res;
    try {
      res = await fetch(attempt.url, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(attempt.body),
      });
    } catch (e) {
      lastError = `${attempt.name}: network error — ${e.message}`;
      continue;
    }

    const text = await res.text();
    if (!res.ok) {
      // The body is where Google says WHY, and dropping it is how "400" becomes unfixable.
      lastError = `${attempt.name}: HTTP ${res.status} — ${text.slice(0, 400)}`;
      // 401/403/429 are about the KEY, not the shape, so a second shape cannot help.
      if ([401, 403, 429].includes(res.status)) throw new Error(lastError);
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
  throw new Error(lastError);
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

/** Every image this catalog needs, as {key, prompt, label}. Banner and logo first: they are three
 *  of the ~306 and they are the two a person actually looks at, so a `--limit` run shows something
 *  worth judging instead of five handbags. */
function buildJobs() {
  const jobs = [];
  for (const store of SHOWCASE_STORES) {
    if (ONLY_STORE && store.slug !== ONLY_STORE) continue;
    jobs.push({ key: `${store.slug}:__banner`, prompt: bannerPrompt(store), label: `${store.name} — באנר`, aspect: BANNER_ASPECT });
    jobs.push({ key: `${store.slug}:__logo`, prompt: logoPrompt(store), label: `${store.name} — לוגו` });
  }
  for (const store of SHOWCASE_STORES) {
    if (ONLY_STORE && store.slug !== ONLY_STORE) continue;
    for (const p of CATALOGS[store.slug]) {
      jobs.push({ key: `${store.slug}:${p.n}`, prompt: imagePrompt(store, p.s), label: `${store.name} — ${p.n}` });
    }
  }
  return jobs;
}

async function main() {
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
  let jobs = buildJobs();
  if (!FORCE) jobs = jobs.filter((j) => !manifest[j.key]);
  if (LIMIT) jobs = jobs.slice(0, LIMIT);

  if (!jobs.length) {
    console.log(`\n✅ Nothing to do — all ${Object.keys(manifest).length} images are already in the manifest.`);
    console.log('   Use --force to regenerate.\n');
    return;
  }

  if (CHECK) {
    console.log('\n🔎 Check mode — one image, to prove the key and the billing tier are live.\n');
  } else {
    console.log(`\n🎨 ${jobs.length} image(s) to generate at ${IMAGE_SIZE}. Already done: ${Object.keys(manifest).length}.`);
    console.log('   Interrupt any time — finished images are saved as they go and a re-run resumes.\n');
  }

  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    process.stdout.write(`   ${job.label} … `);
    try {
      const bytes = await generateImage(job.prompt, apiKey, job.aspect);
      const url = await uploadToCloudinary(bytes, cloud, preset);
      manifest[job.key] = url;
      saveManifest(manifest);   // after EVERY image: a crash must not discard what was paid for
      done++;
      console.log(`✓ ${(bytes.length / 1024).toFixed(0)}KB`);
    } catch (e) {
      failed++;
      console.log('✗');
      console.log(`      ${e.message}`);
      if (CHECK) break;
      // A key/quota failure will fail identically for all 300, so stop rather than burn the list.
      if (/HTTP (401|403|429)/.test(e.message)) {
        console.log('\n   Stopping — that error is about the key or the quota, not this image.\n');
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
