import { showToast, showErrorToast } from '../../lib/toast.js';

/**
 * The dashboard's "saved / updated / deleted" notice.
 *
 * **It is a TOAST now, and the banner it replaced was the odd one out all along.** AI_INSTRUCTIONS
 * already names one mechanism for a notice — `showToast`/`showErrorToast` over the single
 * `ToastContainer` surface — and this module was quietly running a second one: a coloured strip
 * inserted into the panel's own flow.
 *
 * Two failures came out of that, one after the other, and both are answered by deleting the
 * mechanism rather than by improving it:
 *
 *  1. **It anchored to `.products-header`, a class nothing renders any more.** `?.after(el)`
 *     swallowed the miss, so the strip was built, never inserted, and then scrolled to — the page
 *     twitching toward a node with no parent. All 56 call sites across five modules had been
 *     silently invisible while every operation behind them succeeded.
 *  2. **Fixed, it was worse.** Inserted above the campaign card it belonged to, it pushed every
 *     card below it down for three seconds; put back at the top of the panel, it was a message
 *     somewhere the seller was not looking. The owner's verdict (2026-08-17), and it is the right
 *     one: *"כל מקום שיש הודעה מעצבנת כזאת למעלה — זו לא הדרך."* A notice that reflows the page is
 *     the wrong shape no matter where it is put, because the content moving under the eye costs
 *     more than the words are worth.
 *
 * A toast floats: it moves nothing, it is the same surface the rest of the site already uses, and
 * it needs no anchor — so there is no class name left here to rot. The signature stays as it was
 * so that all 56 callers keep working unchanged; the third argument is accepted and ignored,
 * because an anchor is exactly what a toast does not need.
 *
 * **Where a toast is still not the best answer**: an action with a button of its own says it
 * better ON the button — the ✓ hold in `btn-confirm.ts`. Prefer that for a save or a toggle the
 * seller is looking straight at, and keep this for anything with no obvious control to speak from.
 */
export function showStatus(msg: string, isError = false, _anchor?: Element | null): void {
  if (isError) showErrorToast(msg);
  else showToast(msg);
}
