/**
 * The whole Hebrew dictionary, flattened to `dotted.key → string`, for the DEV-ONLY inline copy
 * editor to match against what is on screen.
 *
 * **Why the whole thing, when `BaseLayout` is careful to ship only slices of it.** That care is
 * about the page a visitor downloads: `#i18n-data` is gated per surface because an anonymous
 * shopper must not pay for the seller dashboard's strings. This map is the opposite case — it
 * exists only under `astro dev`, is never in a production build (the one caller renders behind
 * `import.meta.env.DEV`, which is a compile-time constant, so the bundler drops both), and its
 * whole purpose is to answer "which key produced this text?" for text the editor cannot predict.
 * A gated slice would silently make half the screen uneditable, which is the failure that would
 * send the owner back to grepping strings by hand.
 *
 * Computed once at module load rather than per request: it is the same dictionary every time.
 */
import { translations } from '../i18n/translations';

function flatten(node: unknown, prefix: string, out: Record<string, string>): void {
  if (typeof node === 'string') {
    out[prefix] = node;
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => flatten(item, `${prefix}.${index}`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  }
}

function build(): Record<string, string> {
  const out: Record<string, string> = {};
  flatten(translations.he, '', out);
  return out;
}

export const devCopyMap: Record<string, string> = build();
