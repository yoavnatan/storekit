/**
 * Editing the site's Hebrew ON the site — DEV ONLY.
 *
 * Armed with the button in the corner (or Alt+E), hovering outlines any text the dictionary
 * produced and a click opens it for editing. Saving writes `src/i18n/translations.ts` through
 * `/api/dev/copy`, Vite reloads, and the new wording is on screen — no grep, no copy-paste, no
 * chat round trip.
 *
 * **How a piece of text on screen is traced back to its key**, which is the whole problem: the
 * server hands over the entire Hebrew dictionary (`#dev-copy-data`) and this builds the reverse
 * index — normalised text → the keys that produce it. Instrumenting `t()` to stamp keys into the
 * DOM would be more precise and was rejected: the same accessor fills attributes, `set:html`
 * strings and client renderers, so the stamp would have to survive places that have no element to
 * carry it, and every one of those is a place the editor would silently stop working.
 *
 * Three consequences of matching on text, all deliberate:
 *  - A sentence printed with `{n}` filled in is matched by pattern, and the editor shows the SOURCE
 *    string with `{n}` still in it. Editing the rendered text would drop the placeholder; the route
 *    refuses that anyway, but the textarea should never have offered it.
 *  - When several keys hold the same words, all of them are offered and the editor asks which.
 *    Guessing would rewrite a string on a screen nobody was looking at.
 *  - Text assembled from more than one dictionary string in one element is not matched. It is
 *    reported as "not found" rather than approximated.
 */

type Dict = Record<string, string>;

interface Match {
  /** Candidate keys, most specific first. */
  keys: string[];
  /** The element the text belongs to. */
  el: HTMLElement;
  /** The attribute the text came from, or null when it is the element's own text. */
  attr: string | null;
}

const ARMED_KEY = '__dev_copy_armed';
/**
 * Commands left outstanding by edits made so far, kept across the reload that Vite fires the moment
 * `translations.ts` is written.
 *
 * Saving a string that is DRAWN into committed files is the one case where the editor has something
 * the owner must act on, and it is also the one message the reload was guaranteed to destroy — it
 * appeared in the panel for the fraction of a second before Vite swapped the page. A note that
 * cannot be read is worse than none: the edit still looks finished.
 */
const TODO_KEY = '__dev_copy_todo';
/** Attributes a visitor reads that come from the dictionary. `value` covers submit buttons. */
const TEXT_ATTRS = ['placeholder', 'aria-label', 'title', 'alt', 'value'];

/** The server's `tidy`, mirrored for the one case the response did not carry the saved value. */
function tidyLike(raw: string): string {
  return raw.trim().replace(/ {2,}/g, ' ');
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `שלח {n} הודעות` → a pattern that matches the sentence with the hole filled in. */
function placeholderPattern(value: string): RegExp | null {
  if (!/\{\w+\}/.test(value)) return null;
  const escaped = normalise(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\\\{\w+\\\}/g, '(.*?)')}$`);
}

function readDict(): Dict {
  try {
    return JSON.parse(document.getElementById('dev-copy-data')?.textContent ?? '{}') as Dict;
  } catch {
    return {};
  }
}

function readTodo(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(TODO_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    // A private window throws on read, and a hand-edited value parses to anything at all.
    return [];
  }
}

function writeTodo(list: string[]): void {
  try {
    sessionStorage.setItem(TODO_KEY, JSON.stringify(list));
  } catch {
    // Nothing to do — the strip still shows for this page, it just will not survive the reload.
  }
}

/**
 * Writing `translations.ts` makes Vite reload the whole page, and the reload is the thing that made
 * this tool painful to use: a sentence inside an edit modal, or inside the bulk-upload panel, was
 * saved — and the save closed the screen it was on, so fixing three lines in one dialog meant
 * re-opening the dialog three times (owner, 2026-09-08: *"אני עושה שמור וזה מרענן וסוגר את זה
 * וצריך לחזור לפתוח את זה... סיוט"*).
 *
 * So the editor patches the screen itself and tells the Vite client to skip that one reload.
 * Throwing out of `vite:beforeFullReload` is how it is abandoned — the client notifies its listeners
 * before calling `location.reload()` and does not catch.
 *
 * The window is deliberately short and single-shot: the NEXT full reload, from any source, is a real
 * one. An edit to a component of mine must still refresh the page it is on.
 */
let skipReloadUntil = 0;

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', () => {
    if (Date.now() > skipReloadUntil) return;
    skipReloadUntil = 0;
    throw new Error('dev copy editor: text patched in place, reload skipped');
  });
}

/**
 * Put the new words everywhere the old ones are showing, and into the JSON that client renderers
 * read, so a panel opened AFTER the edit says the new thing too.
 *
 * Returns the number of places changed, or -1 for a string the screen cannot be trusted to hold:
 * one with a placeholder is printed with the hole already filled, so what is on screen is not the
 * string that was edited and only a reload can be right.
 */
function applyOnScreen(key: string, oldValue: string, newValue: string): number {
  if (/\{\w+\}/.test(oldValue) || /\{\w+\}/.test(newValue)) return -1;
  const flat = normalise(oldValue);
  if (!flat) return -1;

  let hits = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  for (const node of nodes) {
    if (normalise(node.nodeValue ?? '') !== flat) continue;
    node.nodeValue = newValue;
    hits++;
  }

  for (const el of document.querySelectorAll<HTMLElement>('*')) {
    for (const attr of TEXT_ATTRS) {
      const raw = el.getAttribute(attr);
      if (raw && normalise(raw) === flat) {
        el.setAttribute(attr, newValue);
        hits++;
      }
    }
  }

  // `#i18n-data` holds the same dotted tree, sliced per surface. A renderer that runs later reads it
  // rather than the DOM, so without this the next modal would open saying the old thing.
  const island = document.getElementById('i18n-data');
  if (island?.textContent) {
    try {
      const data = JSON.parse(island.textContent) as Record<string, unknown>;
      const path = key.split('.');
      let node: Record<string, unknown> | undefined = data;
      for (const segment of path.slice(0, -1)) {
        node = node?.[segment] as Record<string, unknown> | undefined;
        if (!node || typeof node !== 'object') break;
      }
      const leaf = path[path.length - 1];
      if (node && typeof node[leaf] === 'string') {
        node[leaf] = newValue;
        island.textContent = JSON.stringify(data);
        hits++;
      }
    } catch {
      // Not shaped the way this expects — the DOM is still patched, which is what is on screen.
    }
  }

  return hits;
}

export function initCopyEditor(): void {
  const dict = readDict();
  const keys = Object.keys(dict);
  if (!keys.length) return;

  // Exact text → keys. Several keys can share one string, so the value is a list.
  const exact = new Map<string, string[]>();
  const patterned: { key: string; re: RegExp }[] = [];
  for (const key of keys) {
    const value = dict[key];
    if (!value) continue;
    const flat = normalise(value);
    const existing = exact.get(flat);
    if (existing) existing.push(key);
    else exact.set(flat, [key]);
    const re = placeholderPattern(value);
    if (re) patterned.push({ key, re });
  }

  /** Move one key from its old text to its new one, in the dictionary and in both indexes. */
  function reindex(key: string, next: string): void {
    const previous = normalise(dict[key] ?? '');
    const stale = exact.get(previous)?.filter((k) => k !== key) ?? [];
    if (stale.length) exact.set(previous, stale);
    else exact.delete(previous);

    dict[key] = next;
    const flat = normalise(next);
    const existing = exact.get(flat);
    if (existing) existing.push(key);
    else exact.set(flat, [key]);

    const slot = patterned.findIndex((p) => p.key === key);
    if (slot !== -1) patterned.splice(slot, 1);
    const re = placeholderPattern(next);
    if (re) patterned.push({ key, re });
  }

  let armed = sessionStorage.getItem(ARMED_KEY) === '1';
  let hovered: Match | null = null;

  // ── chrome ────────────────────────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .dev-copy-toggle{position:fixed;inset-inline-start:12px;bottom:12px;z-index:2147483000;
      font:600 12px/1 system-ui,sans-serif;padding:8px 12px;border-radius:999px;cursor:pointer;
      border:1px solid #0002;background:#fff;color:#111;box-shadow:0 2px 10px #0002}
    .dev-copy-toggle[data-armed="1"]{background:#111;color:#fff;border-color:#111}
    .dev-copy-ring{position:fixed;z-index:2147482999;pointer-events:none;border:2px solid #2563eb;
      border-radius:4px;background:#2563eb14;transition:all .06s linear}
    .dev-copy-panel{position:fixed;inset-inline:12px;bottom:56px;z-index:2147483001;max-width:520px;
      margin-inline:auto;background:#fff;color:#111;border:1px solid #0002;border-radius:10px;
      box-shadow:0 8px 40px #0003;padding:12px;direction:rtl;
      font:400 13px/1.5 system-ui,sans-serif}
    .dev-copy-panel textarea{width:100%;min-height:74px;font:inherit;direction:rtl;padding:8px;
      border:1px solid #0003;border-radius:6px;resize:vertical;box-sizing:border-box}
    .dev-copy-panel select{width:100%;font:inherit;padding:6px;margin-bottom:6px;
      border:1px solid #0003;border-radius:6px}
    .dev-copy-key{font:500 11px/1.4 ui-monospace,monospace;color:#666;direction:ltr;text-align:left;
      margin-bottom:6px;word-break:break-all}
    .dev-copy-shared{font-size:11px;color:#666;margin-bottom:6px}
    .dev-copy-row{display:flex;gap:8px;align-items:center;margin-top:8px}
    .dev-copy-row button{font:600 12px/1 system-ui,sans-serif;padding:8px 14px;border-radius:6px;
      cursor:pointer;border:1px solid #0003;background:#fff}
    .dev-copy-row button.primary{background:#111;color:#fff;border-color:#111}
    .dev-copy-note{margin-inline-start:auto;color:#666;font-size:11px}
    .dev-copy-note[data-bad="1"]{color:#b91c1c}
    .dev-copy-todo{margin-top:8px;padding:8px;border-radius:6px;background:#fef3c7;color:#78350f;
      font:500 11px/1.5 ui-monospace,monospace;direction:ltr;text-align:left;user-select:all}
    .dev-copy-standing{position:fixed;inset-inline-start:12px;bottom:56px;z-index:2147482998;
      max-width:340px;background:#fef3c7;color:#78350f;border:1px solid #f59e0b55;border-radius:8px;
      padding:8px 10px;box-shadow:0 2px 10px #0002;direction:rtl;font:500 11px/1.5 system-ui,sans-serif}
    .dev-copy-standing-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
    .dev-copy-standing-x{margin-inline-start:auto;border:0;background:none;cursor:pointer;
      color:inherit;font:600 14px/1 system-ui,sans-serif;padding:0 2px}
    body.dev-copy-armed *{cursor:crosshair !important}
  `;
  document.head.appendChild(style);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'dev-copy-toggle';
  document.body.appendChild(toggle);

  const ring = document.createElement('div');
  ring.className = 'dev-copy-ring';
  ring.hidden = true;
  document.body.appendChild(ring);

  // Outstanding redraw commands, shown whether or not the editor is armed: the reason to disarm is
  // usually that the editing is finished, which is exactly when this still has to be read.
  const standing = document.createElement('div');
  standing.className = 'dev-copy-standing';
  standing.hidden = true;
  document.body.appendChild(standing);

  function paintStanding(): void {
    const list = readTodo();
    standing.textContent = '';
    standing.hidden = !list.length;
    if (!list.length) return;

    const head = document.createElement('div');
    head.className = 'dev-copy-standing-head';
    head.append('הטקסט נשמר, אבל הוא מצויר לתוך קבצים — צריך לצייר מחדש:');
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'dev-copy-standing-x';
    dismiss.setAttribute('aria-label', 'סגירה');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => {
      writeTodo([]);
      paintStanding();
    });
    head.appendChild(dismiss);
    standing.appendChild(head);

    // textContent per command rather than one innerHTML: the strings come from our own map today,
    // and a map is exactly the thing someone later fills from somewhere else.
    for (const command of list) {
      const row = document.createElement('div');
      row.className = 'dev-copy-todo';
      row.textContent = command;
      standing.appendChild(row);
    }
  }

  let panel: HTMLDivElement | null = null;

  function paintToggle(): void {
    toggle.dataset.armed = armed ? '1' : '0';
    toggle.textContent = armed ? 'עריכת טקסט · פעיל' : 'עריכת טקסט';
    document.body.classList.toggle('dev-copy-armed', armed);
    if (!armed) {
      ring.hidden = true;
      hovered = null;
    }
  }

  function setArmed(next: boolean): void {
    armed = next;
    sessionStorage.setItem(ARMED_KEY, armed ? '1' : '0');
    paintToggle();
  }

  // ── matching ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The longest string in the dictionary bounds what can possibly match, and the bound matters: this
   * runs on every mousemove, for five ancestors, and the fifth ancestor of a product card is most of
   * the page. Without it each move ran ~200 placeholder patterns over a few thousand characters of
   * `textContent` that could never have matched anything.
   */
  const longest = keys.reduce((max, key) => Math.max(max, dict[key]?.length ?? 0), 0);

  function keysFor(text: string): string[] {
    if (text.length > longest * 2) return [];
    const flat = normalise(text);
    if (!flat || flat.length > longest) return [];
    const hit = exact.get(flat);
    if (hit) return hit;
    return patterned.filter((p) => p.re.test(flat)).map((p) => p.key);
  }

  /** The deepest element at this point whose own text (or one attribute) came from the dictionary. */
  function matchAt(target: EventTarget | null): Match | null {
    let el = target instanceof HTMLElement ? target : null;
    for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
      for (const attr of TEXT_ATTRS) {
        const raw = el.getAttribute(attr);
        if (!raw) continue;
        const found = keysFor(raw);
        if (found.length) return { keys: found, el, attr };
      }
      const found = keysFor(el.textContent ?? '');
      if (found.length) return { keys: found, el, attr: null };
    }
    return null;
  }

  function drawRing(el: HTMLElement): void {
    const box = el.getBoundingClientRect();
    ring.hidden = false;
    ring.style.top = `${box.top - 2}px`;
    ring.style.left = `${box.left - 2}px`;
    ring.style.width = `${box.width + 4}px`;
    ring.style.height = `${box.height + 4}px`;
  }

  // ── the editor ────────────────────────────────────────────────────────────────────────────────

  function closePanel(): void {
    panel?.remove();
    panel = null;
  }

  function openPanel(match: Match): void {
    closePanel();
    panel = document.createElement('div');
    panel.className = 'dev-copy-panel';

    // Several keys holding the same words is common — the tagline alone is three. Saying so, and
    // saying that only the chosen one moves, is the difference between "I edited it" and "I edited
    // it and the same sentence two rows down did not change, so this thing is broken".
    const shared = match.keys.length > 1;
    const picker = shared
      ? `<select class="dev-copy-pick">${match.keys
          .map((k) => `<option value="${k}">${k}</option>`)
          .join('')}</select>` +
        `<div class="dev-copy-shared">${match.keys.length} מפתחות מחזיקים בדיוק את הטקסט הזה. השינוי חל על הנבחר בלבד.</div>`
      : '';

    panel.innerHTML =
      picker +
      `<div class="dev-copy-key"${shared ? ' hidden' : ''}></div>` +
      `<textarea spellcheck="false"></textarea>` +
      `<div class="dev-copy-row">` +
      `<button type="button" class="primary" data-act="save">שמירה</button>` +
      `<button type="button" data-act="cancel">ביטול</button>` +
      `<span class="dev-copy-note">⌘↵ לשמירה · Esc לביטול</span>` +
      `</div>` +
      // Shown only when the saved string is one of the few DRAWN into committed files. `user-select:all`
      // so one click takes the whole command — it is meant to be pasted into a terminal, not read.
      `<div class="dev-copy-todo" hidden></div>`;
    document.body.appendChild(panel);

    const area = panel.querySelector('textarea') as HTMLTextAreaElement;
    const keyLine = panel.querySelector('.dev-copy-key') as HTMLElement;
    const pick = panel.querySelector('.dev-copy-pick') as HTMLSelectElement | null;
    const note = panel.querySelector('.dev-copy-note') as HTMLElement;
    const todo = panel.querySelector('.dev-copy-todo') as HTMLElement;

    // The SOURCE string, not what is on screen: a sentence rendered with `{n}` already filled in
    // would lose its placeholder the moment it was saved back.
    const load = (key: string): void => {
      keyLine.textContent = key;
      area.value = dict[key] ?? '';
    };
    load(match.keys[0]);
    pick?.addEventListener('change', () => load(pick.value));
    area.focus();
    area.select();

    const currentKey = (): string => pick?.value ?? match.keys[0];

    async function save(): Promise<void> {
      const key = currentKey();
      note.dataset.bad = '0';
      note.textContent = 'שומר…';
      try {
        const res = await fetch('/api/dev/copy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key, value: area.value }),
        });
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
          was?: string;
          now?: string;
          unchanged?: boolean;
          fallbacks?: { file: string; line: number; rewritten: boolean }[];
          regenerate?: string | null;
        };
        if (!data.ok) {
          note.dataset.bad = '1';
          note.textContent = data.error ?? 'השמירה נכשלה';
          return;
        }
        // The reverse index has to move with the dictionary, not just the dictionary — the sentence
        // you just changed has to stay hoverable, and the page is no longer reloading underneath to
        // rebuild it.
        const saved = data.now ?? tidyLike(area.value);
        reindex(key, saved);

        // Patch the screen and keep it. The reload is skipped only when the patch actually landed:
        // a string with a placeholder is printed with the hole filled, so the words on screen are
        // not the words that were edited, and there the reload is the only honest answer.
        const patched = applyOnScreen(key, data.was ?? '', saved);
        if (patched >= 0) skipReloadUntil = Date.now() + 2000;
        const stale = (data.fallbacks ?? []).filter((f) => !f.rewritten);
        const left: string[] = [];
        if (stale.length) {
          // Named rather than silently left: these are the copies a visitor sees when the dictionary
          // was not handed to the script, and the same words under two keys is the one case the
          // route refuses to guess at.
          left.push(`${stale.length} עותקים בקוד לא עודכנו (${stale[0].file}:${stale[0].line})`);
        }
        if (data.regenerate) {
          // The tagline is drawn into the lockups as outlines, so the dictionary being right does
          // not make the logo right. Nothing downstream can notice that — not the reload, not the
          // suite. Recorded BEFORE it is shown, because the write to translations.ts has already
          // started Vite's reload and this panel may not survive to be read.
          const list = readTodo();
          if (!list.includes(data.regenerate)) writeTodo([...list, data.regenerate]);
          paintStanding();
          todo.textContent = data.regenerate;
          todo.hidden = false;
          left.push('צריך לצייר מחדש');
        }
        if (left.length) {
          note.dataset.bad = '1';
          note.textContent = `נשמר · ${left.join(' · ')}`;
          return;
        }
        // "נשמר ורוענן" would be a lie now, and "נשמר" alone leaves the open question the reload
        // used to answer by itself — whether the screen behind the panel is showing the new words.
        note.textContent = data.unchanged
          ? 'ללא שינוי'
          : patched > 0
            ? `נשמר · עודכן ב-${patched} מקומות בלי לרענן`
            : 'נשמר · הדף יתרענן';
        closePanel();
      } catch {
        note.dataset.bad = '1';
        note.textContent = 'אין תשובה מהשרת';
      }
    }

    panel.addEventListener('click', (event) => {
      const act = (event.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'save') void save();
      if (act === 'cancel') closePanel();
    });
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void save();
      }
    });
  }

  // ── wiring ────────────────────────────────────────────────────────────────────────────────────

  toggle.addEventListener('click', () => setArmed(!armed));

  document.addEventListener('mousemove', (event) => {
    if (!armed || panel) return;
    if (event.target === toggle) {
      ring.hidden = true;
      hovered = null;
      return;
    }
    hovered = matchAt(event.target);
    if (hovered) drawRing(hovered.el);
    else ring.hidden = true;
  });

  // Capture phase: the click must not reach the link or button underneath while armed.
  document.addEventListener(
    'click',
    (event) => {
      if (!armed) return;
      if (toggle.contains(event.target as Node) || panel?.contains(event.target as Node)) return;
      const match = matchAt(event.target);
      if (!match) return;
      event.preventDefault();
      event.stopPropagation();
      openPanel(match);
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    // Not while the caret is in the editor's own textarea: Alt+E is a live key there, and disarming
    // mid-sentence closes nothing but stops the next click from working, which reads as a dead tool.
    const typing = !!panel && panel.contains(event.target as Node);
    if (event.altKey && event.code === 'KeyE' && !typing) {
      event.preventDefault();
      setArmed(!armed);
      return;
    }
    if (event.key === 'Escape' && panel) {
      closePanel();
      ring.hidden = true;
    }
  });

  paintToggle();
  paintStanding();
}
