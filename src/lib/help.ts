/**
 * The help centre's shape and its lookups. The articles themselves are `help-articles.ts`.
 *
 * ── The decision this implements (owner, CURRENT_TASK סשן ב׳) ──
 * *"תשתית של תמיכה, במתכונת של מינימום מגע... תלות מינימלית בי... אוטומטי... לא גימיקי, לא מסובך,
 * ולא מפוזר."*
 *
 * Four constraints, and the last one decides the architecture. **"לא מפוזר" — not scattered.** Help
 * on this platform already existed in three unconnected forms: `InfoTip` tooltips beside individual
 * fields, `TabHint` lines inside panels, and the onboarding checklist. Each answers one question at
 * one spot and none of them can answer "how does this work". Adding a fourth scattered surface
 * would have been the obvious move and the wrong one. So there is exactly ONE place — `/help` —
 * every article lives in it, and everything else LINKS there rather than repeating it.
 *
 * ── Why not an AI assistant, yet ──
 * The owner asked ("אולי ai?"). Against eleven articles a chatbot is worse than a search box in
 * every way that matters: it is slower, it can be wrong about money, and it hides the corpus behind
 * a prompt so a seller cannot tell whether an answer exists at all. What makes it worth building
 * LATER is scale, and the corpus is written for that — each article is a self-contained answer with
 * its own title, summary and body, which is the shape a retrieval layer needs
 * (memory `project_ai_onboarding_assistant`: Claude + RAG, after the core flows). Nothing here has
 * to be rewritten when that day comes; it is the same data with a different reader.
 *
 * ── What an article is allowed to say ──
 * **Only what a seller can do today.** A help page describing a feature that does not exist yet is
 * the "misrepresentation" class that suspends a Merchant Center ACCOUNT — one account for every
 * seller on this platform — and it is also the fastest way to turn the one surface built to REDUCE
 * support contact into the thing generating it. Where an article describes a decided model rather
 * than a working screen (how the money reaches a seller), it says the model and never a date.
 */
import { HELP_ARTICLES, type HelpArticle, type HelpGroupId } from './help-articles.js';

export type { HelpArticle, HelpGroupId };

/** The groups, in the order a seller meets them — opening a shop, filling it, running it, being
 *  paid, being found. Not alphabetical and not by article count: the index is read top to bottom by
 *  somebody on their first day, and that is the order of their week. */
export const HELP_GROUPS: readonly { id: HelpGroupId; title: string }[] = [
  { id: 'start', title: 'פתיחת חנות' },
  { id: 'catalog', title: 'מוצרים ומלאי' },
  { id: 'orders', title: 'הזמנות והחזרות' },
  { id: 'money', title: 'כסף וחיובים' },
  { id: 'growth', title: 'קידום ופרסום' },
];

/** Articles of one group, in the order they are written in the table — which is the order they are
 *  meant to be read in, so it is deliberately not sorted here. */
export function articlesInGroup(group: HelpGroupId): HelpArticle[] {
  return HELP_ARTICLES.filter((a) => a.group === group);
}

export function getHelpArticle(slug: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((a) => a.slug === slug);
}

/**
 * The articles this one points at, resolved and with anything dangling dropped.
 *
 * Dropped rather than rendered as a dead link: `tests/help-articles.test.ts` fails on a `related`
 * slug that names nothing, so a dangling one is a bug caught in the suite — and if one ever reaches
 * a reader anyway, a missing link is a smaller failure than a 404 on the page built to stop someone
 * writing in.
 */
export function relatedArticles(article: HelpArticle): HelpArticle[] {
  return (article.related ?? []).map(getHelpArticle).filter((a): a is HelpArticle => !!a);
}

/**
 * Free-text search over the whole corpus — title, summary and body.
 *
 * Runs in the browser over the rendered index, so this exists for the tests and for any future
 * server-side reader; the page needs no endpoint and no index. Substring rather than fuzzy: with
 * eleven articles a fuzzy match mostly returns everything, and "everything" is the answer a seller
 * came here to avoid.
 */
export function searchHelp(rawQuery: string): HelpArticle[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return [];
  return HELP_ARTICLES.filter((a) =>
    [a.title, a.summary, ...a.body].some((text) => text.toLowerCase().includes(q)));
}
