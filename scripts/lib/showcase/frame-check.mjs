/**
 * Is the product actually whole and inside the frame?
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * "אין דבר כזה אין חיה כזאת שמוצר יוצא מהפריים, זה אסור" (owner, 2026-08-12). Four rounds of
 * prompt work went at this — the rule is stated in `LIFE_DIRECTION`, again in the `main` view
 * modifier, again as the last line of `NEGATIVE_PROMPT`, and one genuine cause was found and fixed
 * (the modifier used to ask for "filling most of the frame"). Products still came back cropped.
 *
 * At that point more prompt language is the wrong tool. A generative model gives no guarantees, so
 * the guarantee has to come from OUTSIDE it: look at every finished picture, and re-roll the ones
 * that failed. That is what this does, and it is the difference between promising the owner a
 * property and actually delivering it across 724 images nobody will inspect one at a time.
 *
 * ── How ─────────────────────────────────────────────────────────────────────
 * The cheapest Flash model, asked one closed question about the image, answering with a tiny JSON
 * object. Image input is a little over a thousand tokens and the reply is a handful, so a check
 * costs a small fraction of a cent against ~$0.05 to generate the image — cheap enough that
 * checking everything and re-rolling the failures is far better value than generating more
 * carefully and hoping.
 *
 * It is deliberately ONE question with a bias toward passing. A checker that fires on anything
 * debatable would re-roll a third of the catalog at full price, and the `detail` view is a macro
 * shot whose whole job is to crop — so that view is never checked (see `shouldCheck`).
 */

const API = 'https://generativelanguage.googleapis.com/v1beta';
/**
 * Flash, not flash-lite. Measured 2026-08-12: lite was asked the same question about five images
 * with known answers and got the two that mattered backwards — it passed a rug running off the
 * frame and failed a dress that was entirely inside it. The check is worth a fraction of a cent
 * either way, and a checker that is wrong in both directions is worse than no checker, because it
 * re-buys good images and ships bad ones while reporting that it looked.
 */
const CHECK_MODEL = 'gemini-3.1-flash-image';

const QUESTION =
  'You are checking a product photograph for an online shop before it is published.\n\n'
  + 'First, identify the single PRODUCT being sold — the object the photo exists to advertise.\n'
  + 'Then trace its outline. Does that outline stay fully inside the picture, or is it interrupted '
  + 'anywhere by the top, bottom, left or right border?\n\n'
  + 'cropped=true means part of the PRODUCT ITSELF is missing because it continues past a border.\n'
  + 'cropped=false in every other case, including all of these:\n'
  + '  - a person is wearing or holding the product and the PERSON is cut off (head, legs, arms) '
  + 'while the product itself is whole — this is normal and correct, answer false;\n'
  + '  - a garment ends near the bottom edge but you can see its complete hem;\n'
  + '  - the table, floor, wall, shadow or background touches or runs past an edge;\n'
  + '  - you are unsure.\n\n'
  + 'Reply with nothing but JSON: {"cropped": true|false, "why": "<six words or fewer>"}';

/** The `detail` view is a deliberate macro of the material and is SUPPOSED to fill the frame. */
export const shouldCheck = (key) => !key.includes('#detail');

/**
 * @returns {Promise<{cropped: boolean, why: string} | null>} null when the check itself failed —
 * which is treated as a PASS by callers, because an image must never be re-bought over a checker
 * error.
 */
export async function checkFraming(apiKey, jpegBuffer) {
  let res;
  try {
    res = await fetch(`${API}/models/${CHECK_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data: jpegBuffer.toString('base64') } },
            { text: QUESTION },
          ],
        }],
        generationConfig: { responseModalities: ['TEXT'], temperature: 0 },
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('') ?? '';
  // The reply is usually bare JSON and occasionally fenced; take the first object either way.
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return { cropped: parsed.cropped === true, why: String(parsed.why ?? '').slice(0, 60) };
  } catch {
    return null;
  }
}
