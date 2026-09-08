// @vitest-environment jsdom
//
// The screen where a seller connects his OWN clearing account — the SaaS shape's one new money
// surface (`components/dashboard/OwnClearingCard.astro` + `scripts/dashboard/own-clearing.ts`).
//
// Two things here are worth a test rather than a read-through, and both are about a value that must
// not be on screen:
//
//  1. **A secret never reaches the page, in either direction.** The server sends a four-character
//     hint and never a value (`seller-own-clearing.ts#forDisplay`), and the input for a secret is
//     rendered EMPTY — which is also what makes `saveSellerClearing`'s merge correct rather than a
//     convenience. After a save the field is wiped again, because the one place a shoulder-surfer
//     could still read a freshly typed key is the input he typed it into.
//  2. **Only the chosen provider's fields are posted.** Every provider's fieldset is server-rendered
//     and all but one hidden, so a form-wide sweep would post a Hyp terminal number alongside a
//     PayPlus save.
//
// The markup below mirrors the component. That is a copy, and copies drift — so the source guards
// at the bottom fail if the component stops spelling the parts this file leans on.
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { readSource, sourceGuard } from './helpers/source-guard.js';
import { initOwnClearingCard } from '../src/scripts/dashboard/own-clearing.js';
import { initUnsavedGuard } from '../src/scripts/dashboard/unsaved-guard.js';

const CARD = 'src/components/dashboard/OwnClearingCard.astro';

function render({ currentId = '', missing = [] as string[], hintOnFile = '' } = {}): void {
  const fieldset = (id: string, fields: Array<[string, boolean]>) => `
    <div data-provider-fields="${id}" ${id === currentId ? '' : 'hidden'}>
      ${fields.map(([name, secret]) => `
        <label class="field">
          <input class="input" name="${name}" type="${secret ? 'password' : 'text'}" value="">
        </label>`).join('')}
    </div>`;

  document.body.innerHTML = `
    <script type="application/json" id="i18n-data">${JSON.stringify({
      dashboard: {
        ownClearingSave: 'שמירת פרטי הסליקה',
        ownClearingSaved: 'פרטי הסליקה נשמרו',
        ownClearingOnFile: 'מחוברים ל־{name}',
        ownClearingMissing: 'חסר עוד {n} שדות כדי שהחנות תוכל לקבל תשלום',
        ownClearingMissingOne: 'חסר עוד שדה אחד כדי שהחנות תוכל לקבל תשלום',
        ownClearingFailed: 'לא הצלחנו לשמור את הפרטים. נסו שוב.',
        ownClearingPickFirst: 'יש לבחור חברת סליקה',
        fieldRequired: 'יש למלא שדה זה',
        ownClearingNone: 'עדיין לא נבחרה חברת סליקה',
        ownClearingChosen: 'נבחרה {name}',
      },
    })}</script>
    <section id="own-clearing">
      <div id="own-clearing-summary" hidden><p id="own-clearing-summary-line"></p>
        <button type="button" id="own-clearing-edit">ערוך</button>
        <button type="button" id="own-clearing-disconnect">ניתוק</button></div>
      <form id="own-clearing-form" data-unsaved-guard>
        <input type="hidden" name="provider" id="own-clearing-provider" value="${currentId}">
        <span id="own-clearing-state"></span>
        <div id="own-clearing-pick">
          <button type="button" data-provider="hyp" aria-pressed="${currentId === 'hyp'}">Hyp / יעד שריג</button>
          <button type="button" data-provider="payplus" aria-pressed="${currentId === 'payplus'}">PayPlus</button>
        </div>
        ${fieldset('hyp', [['masof', false], ['apiKey', true], ['passp', true]])}
        ${fieldset('payplus', [['paymentPageUid', false], ['apiKey', true], ['secretKey', true]])}
        <p class="hidden" id="own-clearing-error"></p>
        <button type="submit" id="own-clearing-save">שמירת פרטי הסליקה</button>
        <button type="button" id="own-clearing-clear" ${currentId ? '' : 'hidden'}>ביטול הבחירה</button>
        <button type="button" id="own-clearing-cancel" hidden>ביטול</button>
      </form>
    </section>`;
  if (hintOnFile) {
    document.querySelector<HTMLInputElement>('[data-provider-fields="hyp"] [name="masof"]')!.value = hintOnFile;
  }
  // The real page runs BOTH. Without the guard `discardChanges` returns early for want of a
  // baseline, which is exactly what made the first draft of the regression test below pass with the
  // bug still in — proved by restoring the bug and watching it stay green.
  initUnsavedGuard();
  initOwnClearingCard();
  // A baseline is taken on first contact with the form, not at init: `remember` listens for a focus
  // or a pointer press inside it. The seller's first click on a provider button is that contact, so
  // the fixture reproduces it rather than reaching into the module's private map.
  document.getElementById('own-clearing-form')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

const click = (sel: string): void => {
  document.querySelector(sel)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

const submit = (): void => {
  document.getElementById('own-clearing-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};

/** The route's real answer shape, so a change to it fails here rather than on a seller. */
const answer = (over: Record<string, unknown> = {}) => ({
  provider: 'hyp', fields: {}, missing: [], verified: null, canTakePayments: false, ...over,
});

let sent: { url: string; body: Record<string, string> } | null = null;

beforeEach(() => {
  sent = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent = { url, body: JSON.parse(String(init.body)) as Record<string, string> };
    return { ok: true, json: async () => answer() } as Response;
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('picking a provider', () => {
  it('moves the fill, the fieldset and the value the form submits', () => {
    render();
    click('[data-provider="payplus"]');

    const chosen = document.querySelector<HTMLButtonElement>('[data-provider="payplus"]')!;
    const other = document.querySelector<HTMLButtonElement>('[data-provider="hyp"]')!;
    // A press that moves nothing on screen is the no-op this site bans, and it read as a broken
    // field the last time a chooser here had only `aria-pressed` to show for it.
    expect(chosen.classList.contains('btn--accent')).toBe(true);
    expect(other.classList.contains('btn--accent')).toBe(false);
    expect(chosen.getAttribute('aria-pressed')).toBe('true');

    expect(document.querySelector<HTMLElement>('[data-provider-fields="payplus"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-provider-fields="hyp"]')!.hidden).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#own-clearing-provider')!.value).toBe('payplus');
  });

  it('repaints from the field when the form is rewritten under it', () => {
    // "בטל שינויים" and a recovered draft both replace fields from outside and fire
    // `dash:fieldsrewritten`. This widget keeps its state IN the field and its picture in the DOM,
    // so ignoring that event would leave one provider lit over another provider's fields — and the
    // next save posts the one the seller cannot see. `tests/field-repaint-guard.test.ts` requires
    // the listener; this requires that it does the right thing.
    render({ currentId: 'hyp' });
    click('[data-provider="payplus"]');

    const field = document.querySelector<HTMLInputElement>('#own-clearing-provider')!;
    field.value = 'hyp';
    document.getElementById('own-clearing-form')!
      .dispatchEvent(new CustomEvent('dash:fieldsrewritten', { bubbles: true }));

    expect(document.querySelector<HTMLButtonElement>('[data-provider="hyp"]')!.classList.contains('btn--accent')).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-provider="payplus"]')!.classList.contains('btn--accent')).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-provider-fields="hyp"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-provider-fields="payplus"]')!.hidden).toBe(true);
  });

  it('clears the marks on the fields when the provider changes', () => {
    // A mark belongs to the provider that was chosen; the new one has been asked nothing yet.
    // (It used to be a COUNT in one line; the owner rejected that as neither good Hebrew nor the
    // way this site reports an incomplete form — `scripts/form-validity.ts` marks the field.)
    render({ currentId: 'hyp' });
    const field = document.querySelector<HTMLInputElement>('[data-provider-fields="hyp"] [name="apiKey"]')!;
    field.setAttribute('aria-invalid', 'true');
    click('[data-provider="payplus"]');
    expect(field.getAttribute('aria-invalid')).toBeNull();
  });

  it('answers a save pressed with nothing chosen', () => {
    // A silent `return` reads as a dead button — the class `silent-failure-guard.test.ts` scans for.
    render();
    submit();
    const err = document.getElementById('own-clearing-error')!;
    expect(err.classList.contains('hidden')).toBe(false);
    expect(err.textContent).toBeTruthy();
    expect(sent, 'nothing may be posted without a provider').toBeNull();
  });
});

describe('what gets posted', () => {
  it('sends only the chosen provider’s fields', () => {
    render({ currentId: 'hyp' });
    document.querySelector<HTMLInputElement>('[data-provider-fields="hyp"] [name="masof"]')!.value = '0010131918';
    // A value left over in a hidden fieldset — the shape a form-wide sweep would have posted.
    document.querySelector<HTMLInputElement>('[data-provider-fields="payplus"] [name="paymentPageUid"]')!.value = 'leftover';
    submit();

    expect(sent!.url).toBe('/api/seller/own-clearing');
    expect(sent!.body).toEqual({ provider: 'hyp', masof: '0010131918' });
    expect(sent!.body).not.toHaveProperty('paymentPageUid');
  });

  it('sends nothing for a secret the seller did not retype', () => {
    // The whole reason `saveSellerClearing` merges instead of replacing: an untouched secret arrives
    // empty, and a replace would wipe the key he did not retype every time he fixed a terminal
    // number.
    render({ currentId: 'hyp' });
    document.querySelector<HTMLInputElement>('[data-provider-fields="hyp"] [name="masof"]')!.value = '0010131918';
    submit();
    expect(sent!.body).not.toHaveProperty('apiKey');
    expect(sent!.body).not.toHaveProperty('passp');
  });

  it('does not post at all with no provider chosen', () => {
    render();
    submit();
    expect(sent).toBeNull();
  });
});

describe('after a save', () => {
  it('wipes a freshly typed secret out of the DOM', async () => {
    render({ currentId: 'hyp' });
    const secret = document.querySelector<HTMLInputElement>('[data-provider-fields="hyp"] [name="apiKey"]')!;
    secret.value = 'a-real-key-nobody-should-be-able-to-read-back';
    submit();
    await vi.waitFor(() => expect(secret.value).toBe(''));
  });

  it('closes into the summary only when nothing is missing', async () => {
    render({ currentId: 'hyp' });
    submit();
    await vi.waitFor(() => {
      expect(document.getElementById('own-clearing-summary')!.hidden).toBe(false);
      expect(document.getElementById('own-clearing-summary-line')!.textContent).toContain('Hyp');
      expect(document.getElementById('own-clearing-form')!.hidden).toBe(true);
    });
  });

  it('does not say "saved" while fields are still empty', async () => {
    // The button confirmed on every 200, and a save with nothing typed IS a 200: it stores the
    // provider and reports which fields are missing. The screen therefore said "פרטי הסליקה נשמרו"
    // over three fields marked in red — seen in a browser. A partial save is still stored; it just
    // does not claim to be finished.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => answer({ missing: ['passp'] }) } as Response)));
    render({ currentId: 'hyp' });
    document.querySelector<HTMLInputElement>('[data-provider-fields="hyp"] [name="masof"]')!.value = '001';
    submit();
    await vi.waitFor(() => expect(
      document.querySelector('[data-provider-fields="hyp"] [name="passp"]')!.getAttribute('aria-invalid'),
    ).toBe('true'));
    expect(document.getElementById('own-clearing-save')!.classList.contains('btn--confirmed')).toBe(false);
    // And what he DID paste is still on screen — the save stored it, so it must not be thrown back.
    expect(document.querySelector<HTMLInputElement>('[data-provider-fields="hyp"] [name="masof"]')!.value).toBe('001');
  });

  it('stays open and MARKS the empty fields, one message each', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => answer({ missing: ['apiKey', 'passp'] }) } as Response)));
    render({ currentId: 'hyp' });
    submit();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-provider-fields="hyp"] [name="apiKey"]')!.getAttribute('aria-invalid')).toBe('true');
      expect(document.querySelector('[data-provider-fields="hyp"] [name="passp"]')!.getAttribute('aria-invalid')).toBe('true');
      // The one the server did NOT name is left alone — a form that marks everything marks nothing.
      expect(document.querySelector('[data-provider-fields="hyp"] [name="masof"]')!.getAttribute('aria-invalid')).toBeNull();
      expect(document.getElementById('own-clearing-form')!.hidden).toBe(false);
    });
  });

  it('does not throw the chosen provider away — the fields stay on screen', async () => {
    /* ── The bug this pins, found by driving the real screen (2026-09-08) ──
       The save path called `discardChanges(form)`, which restores the baseline `unsaved-guard.ts`
       took when the page RENDERED — and on a first connection that baseline holds `provider=""`.
       So a partial save succeeded, the hidden field was thrown back to empty, the repaint listener
       fired on it, and every fieldset hid: a seller who had just saved two of three fields was left
       looking at a form with no fields in it, no error, and no way to finish. `dash:saved` is the
       right event — it tells the guard the new state IS the baseline. */
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => answer({ missing: ['passp'] }) } as Response)));
    render();
    click('[data-provider="hyp"]');
    document.querySelector<HTMLInputElement>('[data-provider-fields="hyp"] [name="masof"]')!.value = '0010131918';
    submit();

    // Wait for the SAVE to have landed before asserting, not merely for the assertions to hold: the
    // state this checks is also the state before the save, so a `waitFor` over the assertions alone
    // passes on the first poll and proves nothing. The count line only appears once the response has
    // been rendered, so it is the signal that the save actually completed.
    await vi.waitFor(() => expect(
      document.querySelector('[data-provider-fields="hyp"] [name="passp"]')!.getAttribute('aria-invalid'),
    ).toBe('true'));

    expect(document.querySelector<HTMLInputElement>('#own-clearing-provider')!.value).toBe('hyp');
    expect(document.querySelector<HTMLElement>('[data-provider-fields="hyp"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLInputElement>('[data-provider-fields="hyp"] [name="passp"]')).not.toBeNull();
  });

  it('shows a refusal beside the form rather than as a toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'ספק לא מוכר', field: 'provider' }) } as Response)));
    render({ currentId: 'hyp' });
    submit();
    await vi.waitFor(() => {
      const err = document.getElementById('own-clearing-error')!;
      expect(err.classList.contains('hidden')).toBe(false);
      expect(err.textContent).toBe('ספק לא מוכר');
    });
  });
});

describe('the component the fixture above copies', () => {
  it('renders a secret’s input EMPTY, never its stored value', () => {
    // The hint is rendered as prose under the field; the input itself must not carry it. A
    // `value={onFile[...]}` on a password input would put the key back on the page, which is the one
    // thing `forDisplay` exists to prevent.
    expect(
      sourceGuard({
        file: CARD,
        rule: 'a secret field renders with an empty value',
        find: (src) => {
          const hits: string[] = [];
          for (const m of src.matchAll(/type=\{f\.secret[^}]*\}/g)) hits.push(m[0]);
          // The one sanctioned spelling: secret → '', otherwise the plain value.
          return hits.length && !src.includes("value={f.secret ? '' :") ? ['secret input without an empty value'] : [];
        },
        mustReject: `<input type={f.secret ? 'password' : 'text'} value={onFile[f.name]?.hint ?? ''} />`,
      }),
    ).toEqual([]);
  });

  it('a secret field is type="password", which is what keeps it out of the draft store', () => {
    /* Not a styling choice and not only about shoulder-surfing. `FormFallbackGuard.astro` saves a
       blocked form's fields to localStorage so a seller does not lose his typing when the AJAX save
       cannot run — and it skips `type="password"` (its `SKIP` map) along with files and the CSRF
       token. So the input type is the single thing standing between a seller's live clearing key
       and a plaintext copy of it sitting in browser storage on whatever machine he happened to use.
       Change it to `text` for readability and that copy starts being written, silently. */
    expect(
      sourceGuard({
        file: CARD,
        rule: 'a credential marked secret renders as type="password"',
        find: (src) => (src.includes("type={f.secret ? 'password' : 'text'}") ? [] : ['no password type for a secret field']),
        mustReject: '<input class="input" name={f.name} type="text" />',
      }),
    ).toEqual([]);
    // And the guard it depends on still skips that type.
    expect(readSource('src/components/dashboard/FormFallbackGuard.astro', { raw: true }))
      .toMatch(/SKIP\s*=\s*\{[^}]*password:\s*1/);
  });

  it('tells every password manager to keep away from the secret fields', () => {
    /* Chrome ignores `autocomplete="off"` on a password field and fills it — with the text input
       beside it — as if the card were a sign-in form. The owner met that: an email and a password
       appearing in his clearing details every time he opened the tab, and an unsaved-changes bar on
       a form he had not touched, because an autofilled field is a changed field. */
    const src = readSource(CARD);
    expect(src).toContain("autocomplete={f.secret ? 'new-password' : 'off'}");
    expect(src).toContain('data-1p-ignore');
    expect(src).toContain('data-lpignore');
  });

  it('keeps the ids and hooks this file’s fixture is written against', () => {
    const src = readSource(CARD);
    for (const hook of [
      'own-clearing-form', 'own-clearing-provider', 'own-clearing-pick', 'own-clearing-state',
      'own-clearing-error', 'own-clearing-save', 'own-clearing-cancel', 'own-clearing-summary-line',
      'own-clearing-clear', 'own-clearing-disconnect', 'data-provider-fields',
    ]) {
      expect(src, `${CARD} no longer spells ${hook}`).toContain(hook);
    }
  });

  it('shows only the providers a seller can actually connect', () => {
    /* They were rendered disabled with a sentence explaining why, and the owner read that screen:
       *"זה לא צריך להיות משהו שהיוזר בכל רואה"*. A greyed-out row with an apology beside it is our
       roadmap on a settings screen, and it turns a list of choices into a list one of which is
       broken. The registry still holds them and the route still refuses them by id — what changed
       is that the card is built from `connectableProviders()` alone. */
    const src = readSource(CARD);
    expect(src).not.toContain('coming');
    expect(src).not.toContain('ownClearingComingWhy');
    // The pills come from the verified list and nothing else.
    expect(src).toContain('providers.map');
  });
});
