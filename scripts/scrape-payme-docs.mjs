// Read PayMe's documentation the way a person does: render the JavaScript app in a real browser,
// walk its navigation, and save each page's text.
//
// Every non-browser route was tried first and each failed for its own reason — no sitemap, the
// crawler user-agent is answered 403, and their content API resolves the route but wants an internal
// node id that is not the one in the address bar. A headless browser sidesteps all of it.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
const START = 'https://payme.stoplight.io/';
const MAX_PAGES = 500;

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 2000 } });

/** Wait for the article body rather than for networkidle: Stoplight keeps connections open, so
 *  networkidle never settles and every page would cost its full timeout. */
async function readArticle(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(4500);
  /* global document -- runs inside the rendered page, not in Node: Playwright serialises this
     function and evaluates it in the browser, where `document` is the page's own. */
  return page.evaluate(() => {
    const main = document.querySelector('main') ?? document.body;
    return main.innerText.replace(/\n{3,}/g, '\n\n').trim();
  });
}

/** Every in-site documentation link currently in the DOM — the sidebar is the navigation, and it
 *  re-renders per section, so this is re-read on every page rather than collected once. */
async function docLinks() {
  /* global location -- same as above: this body is evaluated in the browser. */
  return page.evaluate(() => [...document.querySelectorAll('a[href]')]
    .map((a) => { try { return new URL(a.getAttribute('href'), location.origin).href; } catch { return ''; } })
    .filter((h) => /^https:\/\/(payme\.stoplight\.io|docs\.payme\.io)\/docs\//.test(h))
    // Their links carry a `/branches/V1.6/` segment; keep it, it is part of the address that works.
    .map((h) => h.split('#')[0]));
}

const seen = new Set();
const queue = [START];
const index = [];

while (queue.length && seen.size < MAX_PAGES) {
  const url = queue.shift();
  if (seen.has(url)) continue;
  seen.add(url);

  let text;
  try {
    text = await readArticle(url);
  } catch (err) {
    console.log('SKIP', url, String(err).slice(0, 80));
    continue;
  }

  for (const link of await docLinks()) {
    if (!seen.has(link) && !queue.includes(link)) queue.push(link);
  }

  if (text.length < 200) { console.log('thin', url, text.length); continue; }

  const slug = (new URL(url).pathname.replace(/^\/|\/$/g, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'home').slice(0, 120);
  fs.writeFileSync(path.join(OUT, `${slug}.txt`), `# ${url}\n\n${text}\n`);
  index.push({ url, slug, chars: text.length });
  console.log(String(index.length).padStart(3), slug.slice(0, 70), text.length);
}

fs.writeFileSync(path.join(OUT, '_index.json'), JSON.stringify(index, null, 2));
console.log(`\nsaved ${index.length} pages, visited ${seen.size}, queue left ${queue.length}`);
await browser.close();
