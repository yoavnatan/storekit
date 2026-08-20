export const prerender = false;
import type { APIRoute } from 'astro';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import {
  createAdminThread,
  deleteAdminThread,
  getAdminThreadById,
  getAdminThreadsPage,
  markAdminThreadReadByAdmin,
  replyToAdminThread,
  setAdminThreadStatus,
  MAX_ADMIN_CONTENT_LEN,
  MAX_ADMIN_SUBJECT_LEN,
} from '../../../lib/admin-messages.js';
import { createNotification, deleteNotificationsByRelatedIds } from '../../../lib/notifications.js';
import { getSellerById } from '../../../lib/seller-auth.js';
import { withTransaction, type Queryable } from '../../../lib/db.js';
import { ADMIN_PAGE_SIZE } from '../../../lib/pagination.js';
import { sendMessageReplyEmail } from '../../../lib/email/message-reply-email.js';
import { store as platform } from '../../../config/store.config.js';

const json = { 'Content-Type': 'application/json' };

// relatedId is the THREAD id, not the message id — it's what the header's
// notification deep-link matches against a dashboard row's data-msg-id.
async function notifySeller(sellerId: string, subject: string, content: string, threadId: string, tx?: Queryable): Promise<void> {
  await createNotification({
    userId: sellerId,
    role: 'seller',
    type: 'admin_message',
    title: subject,
    body: content.slice(0, 120),
    relatedId: threadId,
  }, tx);
}

export const GET: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const threadId = new URL(request.url).searchParams.get('threadId');
  if (threadId) {
    const thread = await getAdminThreadById(threadId);
    if (!thread) return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    return new Response(JSON.stringify({ messages: thread.messages }), { headers: json });
  }
  // The newest page of threads, not all of them (§3, 2026-08-03). Its only caller is the Messages
  // tab's poll, and it acts on exactly two kinds of thread: one already in the page's DOM that has
  // a new message, and — on page 1 — one that is brand new. Both are, by definition, at the top of
  // the recency order the moment they change, so a page of the most recently active threads is
  // everything the poll can use. It used to fetch every system message on the platform, with every
  // thread's full message array, on a timer.
  const page = await getAdminThreadsPage({ sortCol: 'recent', unreadOnly: false, role: 'all', status: 'all' }, 1, ADMIN_PAGE_SIZE);
  return new Response(JSON.stringify({ threads: page.threads }), { headers: json });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const read = await readJsonBody<Record<string, unknown>>(request, BODY_LIMIT.form);
  if (!read.ok) return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: read.status, headers: json });
  const body = read.value;

  const threadId = String(body.threadId ?? '');

  if (body.action === 'mark-read') {
    if (!threadId || !(await getAdminThreadById(threadId))) {
      return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    }
    await markAdminThreadReadByAdmin(threadId);
    return new Response(JSON.stringify({ ok: true }), { headers: json });
  }

  // "Done with this", which is not the same as "read" — read is attention, this is the work. The
  // reports list had it and the threads did not, so a thread the admin had opened and not yet acted
  // on was indistinguishable from one already dealt with.
  if (body.action === 'set-status') {
    if (!(await setAdminThreadStatus(threadId, body.handled === true))) {
      return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    }
    return new Response(JSON.stringify({ ok: true, handled: body.handled === true }), { headers: json });
  }

  // Deleting is admin-only and removes the thread for both sides — the
  // seller's notification for it goes too, otherwise the header would keep
  // deep-linking to a conversation that no longer exists.
  if (body.action === 'delete') {
    const thread = threadId ? await getAdminThreadById(threadId) : null;
    if (!thread) return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    await withTransaction(async (tx) => {
      await deleteAdminThread(threadId, tx);
      await deleteNotificationsByRelatedIds([threadId], thread.sellerId, tx);
    });
    return new Response(JSON.stringify({ ok: true }), { headers: json });
  }

  const content = String(body.content ?? '').trim();
  if (!content || content.length > MAX_ADMIN_CONTENT_LEN) {
    return new Response(JSON.stringify({ error: 'Invalid content' }), { status: 400, headers: json });
  }

  // Reply inside an existing thread…
  if (threadId) {
    const thread = await getAdminThreadById(threadId);
    if (!thread) return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    // One transaction, same reason as the buyer↔seller side: a system message with no notification
    // never reaches the seller's header, and a notification with no message deep-links to nothing.
    // **Who is on the other end decides how the answer travels** (owner, 2026-08-19). A SELLER has a
    // dashboard, so a notification lands somewhere they will see it. A buyer or a guest does not —
    // for them the platform mails it, exactly as it does when a seller answers a guest. The earlier
    // cut offered a `mailto:` here instead, which the owner rejected and was right to: it leaves
    // the product, sends from a private address, and leaves the thread with no record of the reply.
    // **Keyed on whether a seller ACCOUNT is attached, not on the role** (סשן ד׳). The two used to
    // be the same question and are not any more: a fault report from a seller deliberately carries
    // `party_role: 'seller'` and no `seller_id`, because it must not land in his Messages tab
    // (`platform-inquiries.ts` says why). Read off the role, this would have called `notifySeller`
    // with an empty id — a notification row nobody can read, and an answer that left through no
    // door. `thread.sellerId` is the column the seller's own inbox selects by, so it is also the
    // exact answer to "will a dashboard notification reach them".
    const byEmail = !thread.sellerId;
    const replyTo = thread.root.partyEmail ?? '';
    // Nothing to send and nowhere to send it — refused rather than written, so a thread never shows
    // an answer that left the building through no door.
    if (byEmail && !replyTo) {
      return new Response(JSON.stringify({ error: 'לפונה אין כתובת לחזרה' }), { status: 409, headers: json });
    }

    const message = await withTransaction(async (tx) => {
      const written = await replyToAdminThread(threadId, 'admin', content, tx);
      // `thread.sellerId` is '' for a buyer or a guest, and a notification addressed to it is a row
      // nobody can read — the same dead-row shape `senderHasAccount` closed on the buyer↔seller side.
      if (written && !byEmail) await notifySeller(thread.sellerId, thread.subject, content, threadId, tx);
      return written;
    });
    if (!message) return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });

    // Outside the transaction: the reply is committed, and a mail provider having a bad minute must
    // never turn a written answer into an error the admin retries — which would post it twice.
    if (byEmail) {
      await sendMessageReplyEmail({
        to: replyTo,
        storeName: platform.name,
        replyTo: platform.business.email,
        subject: `Re: ${thread.subject}`,
        body: content,
      });
    }
    return new Response(JSON.stringify({ ok: true, message, threadId, sentByEmail: byEmail }), { headers: json });
  }

  // …or open a new one, which is the only place a subject is set.
  const sellerId = String(body.sellerId ?? '');
  const subject = String(body.subject ?? '').trim();
  if (!sellerId || !subject || subject.length > MAX_ADMIN_SUBJECT_LEN) {
    return new Response(JSON.stringify({ error: 'Missing or invalid sellerId/subject' }), { status: 400, headers: json });
  }
  const seller = await getSellerById(sellerId);
  if (!seller) return new Response(JSON.stringify({ error: 'Seller not found' }), { status: 404, headers: json });

  const message = await withTransaction(async (tx) => {
    const written = await createAdminThread(sellerId, subject, content, tx);
    await notifySeller(sellerId, subject, content, written.id, tx);
    return written;
  });
  return new Response(JSON.stringify({ ok: true, message, threadId: message.id }), { headers: json });
};
