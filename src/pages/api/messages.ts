export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession, getSellerById } from '../../lib/seller-auth.js';
import {
  createMessage,
  getMessagesByBuyer,
  getMessagesBySeller,
  getMessageReplies,
  getMessageById,
  getUnreadThreadIdsForSeller,
  getUnreadThreadIdsForBuyer,
  MAX_MESSAGE_SUBJECT_LEN,
  MAX_MESSAGE_CONTENT_LEN,
  markThreadReadBySeller,
  markThreadReadByBuyer,
  deleteMessageThread,
} from '../../lib/messages.js';
import { getStoreById } from '../../lib/stores.js';
import { createNotification, deleteNotificationsByRelatedIds } from '../../lib/notifications.js';
import { withTransaction } from '../../lib/db.js';

export const GET: APIRoute = async ({ request, cookies }) => {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  const url = new URL(request.url);
  const role = url.searchParams.get('role') ?? 'buyer';
  const repliesFor = url.searchParams.get('repliesFor');
  const storeId = url.searchParams.get('storeId');

  // Bound to a participant, not just to a signed-in account. A thread id is hard to guess, and the
  // repo's rule is that hard to guess is not a permission (lib/checkout-idempotency.ts) — these are
  // private conversations between one buyer and one seller, so the root has to name the asker.
  if (repliesFor) {
    const original = await getMessageById(repliesFor);
    const mayRead = original && (original.fromUserId === userId || original.toSellerId === userId);
    const replies = mayRead ? await getMessageReplies(repliesFor) : [];
    return new Response(JSON.stringify({ replies }), { headers: { 'Content-Type': 'application/json' } });
  }

  // The header polls this on a timer for every open tab. It used to read every message the person
  // is party to and then look up each thread's replies one at a time; both sides are now a single
  // statement that answers only the question asked (messages.ts).
  if (url.searchParams.get('unread') === '1') {
    const json = { 'Content-Type': 'application/json' };
    const unreadIds = role === 'seller'
      ? await getUnreadThreadIdsForSeller(userId, storeId ?? undefined)
      : await getUnreadThreadIdsForBuyer(userId);
    return new Response(JSON.stringify({ unreadIds }), { headers: json });
  }

  const messages = role === 'seller'
    ? await getMessagesBySeller(userId)
    : await getMessagesByBuyer(userId);

  return new Response(JSON.stringify({ messages }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  const body = await request.json() as {
    action?: string;
    toStoreId?: string;
    subject?: string;
    content?: string;
    productRef?: { productId: string; productName: string; productSlug: string; storeSlug: string };
    replyToId?: string;
    id?: string;
  };

  if (body.action === 'mark-read' && body.id) {
    const replies = await getMessageReplies(body.id);
    const relatedIds = [body.id, ...replies.map((r) => r.id)];
    await deleteNotificationsByRelatedIds(relatedIds, userId);
    await markThreadReadBySeller(body.id, userId);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'mark-read-buyer' && body.id) {
    const replies = await getMessageReplies(body.id);
    const relatedIds = [body.id, ...replies.map((r) => r.id)];
    await deleteNotificationsByRelatedIds(relatedIds, userId);
    // Bound to the thread's author inside the statement — see markThreadReadByBuyer.
    await markThreadReadByBuyer(body.id, userId);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'delete' && body.id) {
    const msg = await getMessageById(body.id);
    if (!msg) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    const canDelete = msg.fromUserId === userId || msg.toSellerId === userId;
    if (!canDelete) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 403 });
    await deleteMessageThread(body.id);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  const seller = await getSellerById(userId);
  if (!seller) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });

  // Reply to an existing message (seller→buyer or buyer follow-up)
  if (body.replyToId && body.content?.trim()) {
    const original = await getMessageById(body.replyToId);
    if (!original) return new Response(JSON.stringify({ error: 'Message not found' }), { status: 404 });

    // Determine direction: if userId is the original seller (toSellerId), reply goes to buyer
    // If userId is the original buyer (fromUserId), reply goes to seller
    const isSeller = original.toSellerId === userId;
    const isBuyer  = original.fromUserId === userId;
    if (!isSeller && !isBuyer) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 403 });
    }

    const toId   = isSeller ? original.fromUserId : original.toSellerId;
    const toName = isSeller ? original.fromName   : original.toStoreName;
    const content = body.content.trim();
    if (content.length > MAX_MESSAGE_CONTENT_LEN) {
      return new Response(JSON.stringify({ error: 'Content too long' }), { status: 400 });
    }

    // One transaction: a reply with no notification leaves its recipient with no badge, and a
    // notification with no reply is a deep-link into nothing. `toStoreId` is deliberately empty —
    // a reply is addressed to a person, not to a shop front — and lands as NULL (messages.ts).
    const reply = await withTransaction(async (tx) => {
      const written = await createMessage({
        fromUserId: userId,
        fromName: seller.name,
        fromEmail: seller.email,
        toStoreId: '',
        toSellerId: toId,
        toStoreName: toName,
        subject: `Re: ${original.subject}`,
        content,
        replyToId: body.replyToId,
      }, tx);

      await createNotification({
        userId: toId,
        role: isSeller ? 'buyer' : 'seller',
        type: isSeller ? 'seller_reply' : 'new_message',
        title: isSeller ? 'יש לך הודעה חדשה ממוכר' : 'יש לך הודעה חדשה מקונה',
        body: '',
        relatedId: written.id,
        storeName: original.toStoreName,
      }, tx);

      return written;
    });

    return new Response(JSON.stringify({ ok: true, message: reply }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Buyer sending a new message to a seller.
  //
  // The recipient is DERIVED from the store, never taken from the request. The body used to carry
  // `toSellerId` and `toStoreName` alongside the store id, which meant a hand-made post could file
  // a message under one shop's name and deliver it to a different seller — and, now that the
  // columns are foreign keys, could also name an account that does not exist at all.
  // The size caps are the SERVER's, not the compose form's: `maxlength` is a courtesy to whoever is
  // typing, and a plain fetch reaches this endpoint without ever seeing it (the same lesson
  // MAX_CATEGORY_NAME_LENGTH taught). The reply box above has no attribute at all.
  const { toStoreId, subject, content, productRef } = body;
  if (!toStoreId || !subject?.trim() || !content?.trim()) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
  }
  if (subject.trim().length > MAX_MESSAGE_SUBJECT_LEN || content.trim().length > MAX_MESSAGE_CONTENT_LEN) {
    return new Response(JSON.stringify({ error: 'Subject or content too long' }), { status: 400 });
  }
  const store = await getStoreById(toStoreId);
  if (!store) return new Response(JSON.stringify({ error: 'Store not found' }), { status: 404 });

  const msg = await withTransaction(async (tx) => {
    const written = await createMessage({
      fromUserId: userId,
      fromName: seller.name,
      fromEmail: seller.email,
      toStoreId: store.id,
      toSellerId: store.sellerId,
      toStoreName: store.name,
      subject: subject.trim(),
      content: content.trim(),
      productRef,
    }, tx);

    await createNotification({
      userId: store.sellerId,
      role: 'seller',
      type: 'new_message',
      title: 'יש לך הודעה חדשה מקונה',
      body: '',
      relatedId: written.id,
      storeName: store.name,
    }, tx);

    return written;
  });

  return new Response(JSON.stringify({ ok: true, message: msg }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
