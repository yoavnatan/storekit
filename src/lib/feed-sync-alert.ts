import { createNotification, deleteNotificationsByRelatedIds, existingNotificationRelatedIds } from './notifications.js';
import type { Store } from './stores.js';

/**
 * Tell the seller when the UNATTENDED inventory pull stopped working.
 *
 * **Why this exists (owner, 2026-08-19: *"הסנכרון מגיע מבחוץ, אז הוא לא באמת יכול להסתכל על זה
 * בזמן אמת, אולי צריך התראה או נקודה אדומה?"*).** Everything the sync could say about a problem was
 * said in a preview — and a preview is something a person reads while pressing a button. The
 * scheduled pull has no person: a feed whose URL died, whose sku column got renamed, or whose rows
 * are being refused one by one, simply stops moving stock. The storefront then keeps selling from
 * numbers that were true the last time the pull worked, which is the same shape as an oversell, and
 * nothing anywhere says so. A seller finds out from a customer.
 *
 * Three rules, all of them about not becoming noise — a badge nobody trusts is worse than none:
 *
 *   • **Once per problem per day.** The job runs hourly; the same dead URL must not be 24 alerts.
 *   • **A DIFFERENT problem is different news** — the key carries the reason, so a feed that starts
 *     failing a new way says so instead of hiding behind yesterday's alert.
 *   • **A clean run clears them.** The alert is a claim about the CURRENT state, so the moment a
 *     pull succeeds with nothing refused, every one of this store's sync alerts is deleted. Nobody
 *     should have to dismiss a warning about a problem that fixed itself.
 *
 * Only the scheduled trigger alerts. A seller pressing "sync now" is looking at the answer.
 */
export type FeedSyncProblem = 'unreachable' | 'no-matcher-column' | 'empty-file' | 'file-rejected' | 'rows-refused';

const ALL_PROBLEMS: readonly FeedSyncProblem[] = ['unreachable', 'no-matcher-column', 'empty-file', 'file-rejected', 'rows-refused'];

/** One alert per problem per store per day. The pull runs hourly (jobs/registry.ts). */
const REPEAT_AFTER_HOURS = 24;

const relatedIdFor = (storeId: string, problem: FeedSyncProblem): string => `feed-sync:${storeId}:${problem}`;

/** Every key this store could hold — what a clean run deletes. */
const feedSyncAlertIds = (storeId: string): string[] => ALL_PROBLEMS.map((p) => relatedIdFor(storeId, p));

/**
 * When a batch of failures stops being the sellers' problem and starts being ours.
 *
 * **One dead feed URL is not an admin's business** (owner asked, 2026-08-19), and making it one is
 * how the Alerts tab becomes unreadable: at a thousand sellers, a handful of broken vendor links on
 * any given day is the normal state of the world, and the person who can actually fix each one is
 * already being told (the notification above). An admin alert per store would bury the entries that
 * do need a human here.
 *
 * What no seller can see, and what nothing else would report, is MOST of them failing at once —
 * two hundred vendors do not go down together, so that shape means our network, our fetch guard, or
 * our code. The job counts its own outcomes anyway, so this costs one comparison per run.
 *
 * Three stores minimum, because "one of one failed" is a single broken link expressed as 100%, and
 * paging someone for it would be the same noise by another route.
 */
export function isPlatformWideFeedFailure(total: number, failed: number): boolean {
  return total >= 3 && failed >= Math.ceil(total / 2);
}

/**
 * What a finished pull amounts to, in the seller's terms rather than the route's.
 *
 * `undefined` means the run was fine. `rows-refused` is the partial case the counts alone hide: the
 * run reports `ok`, `lastSyncAt` is stamped, and some products were never touched.
 */
export function classifyFeedSyncOutcome(status: number, body: Record<string, unknown>): FeedSyncProblem | undefined {
  if (status === 200 && body.ok) {
    const results = Array.isArray(body.results) ? body.results : [];
    const refused = results.filter((r) => (r as { action?: string }).action === 'error').length;
    return refused > 0 ? 'rows-refused' : undefined;
  }
  const error = String(body.error ?? '');
  // A feed the store never configured is not a failure to report — the job does not pick those up,
  // and a seller who cleared their URL asked for exactly this.
  if (error === 'no-feed-url') return undefined;
  if (error.startsWith('feed-')) return 'unreachable';
  if (error === 'no-matcher-column') return 'no-matcher-column';
  if (error === 'empty-file') return 'empty-file';
  return 'file-rejected';
}

/**
 * Title + body per problem. Each says what happened and what the seller can do — never a code,
 * and every title names its SUBJECT (owner, 2026-08-19: *"המוכר לא יודע על מה מדובר, זה מחוץ
 * להקשר"*). A bell notification arrives with no surroundings at all: "המלאי לא מתעדכן מהקישור"
 * assumes the reader already has "the link" in mind, and the one person who does not is the
 * seller who set it up once, months ago, and has not thought about it since.
 *
 * Exported because the products tab says the SAME thing in a card at the top of the page: a bell
 * notification is read once and dismissed, and the sync stays broken long after. Two wordings for
 * one situation is how a seller ends up believing the milder of them.
 */
export function feedSyncProblemCopy(problem: FeedSyncProblem): { title: string; body: string } {
  switch (problem) {
    case 'unreachable':
      return {
        title: 'המלאי המסונכרן לא מתעדכן',
        body: 'לא הצלחנו למשוך את קובץ המלאי מהקישור שהגדרתם. עד שהקישור יעבוד שוב, המלאי באתר נשאר כפי שהיה בסנכרון האחרון.',
      };
    case 'no-matcher-column':
      return {
        title: 'המלאי המסונכרן עצר — אין מק"ט בקובץ',
        body: 'בקובץ שמגיע מהקישור אין עמודת מק"ט, ולכן אי אפשר להתאים שורות למוצרים. פתחו את פאנל הסנכרון והתאימו את העמודות מחדש.',
      };
    case 'empty-file':
      return {
        title: 'המלאי המסונכרן עצר — הקובץ שהגיע ריק',
        body: 'הקישור החזיר קובץ בלי שורות, והמלאי לא עודכן. בדקו את הייצוא במערכת שממנה הקובץ מגיע.',
      };
    case 'file-rejected':
      return {
        title: 'המלאי המסונכרן עצר — הקובץ לא נקרא',
        body: 'הקובץ שהגיע מהקישור לא בפורמט שאפשר לקרוא. פתחו את פאנל הסנכרון ולחצו "סנכרן עכשיו" כדי לראות מה חסר בו.',
      };
    case 'rows-refused':
      return {
        title: 'חלק מהמלאי המסונכרן לא עודכן',
        body: 'הסנכרון רץ, אבל חלק מהשורות בקובץ נדחו והמוצרים שלהן לא עודכנו. פתחו את פאנל הסנכרון ולחצו "סנכרן עכשיו" כדי לראות אילו.',
      };
  }
}

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3600_000).toISOString();

/**
 * Raise, keep quiet, or clear — the whole decision for one store's scheduled pull.
 *
 * Never throws: it is called from a job that must finish its batch, and a badge is not worth a
 * store's sync. The caller does not await a result because there is nothing to decide on.
 */
export async function alertOnScheduledSync(store: Store, status: number, body: Record<string, unknown>): Promise<void> {
  const problem = classifyFeedSyncOutcome(status, body);

  if (!problem) {
    // Self-healing, and deliberately unconditional: cheaper than reading first, and it is the same
    // statement either way — this store has no sync problem right now.
    await deleteNotificationsByRelatedIds(feedSyncAlertIds(store.id), store.sellerId);
    return;
  }

  const relatedId = relatedIdFor(store.id, problem);
  const alreadySaid = await existingNotificationRelatedIds([relatedId], hoursAgo(REPEAT_AFTER_HOURS));
  if (alreadySaid.has(relatedId)) return;

  const { title, body: text } = feedSyncProblemCopy(problem);
  await createNotification({
    userId: store.sellerId,
    role: 'seller',
    type: 'feed_status',
    title,
    body: text,
    relatedId,
    storeSlug: store.slug,
    storeName: store.name,
  });
}
