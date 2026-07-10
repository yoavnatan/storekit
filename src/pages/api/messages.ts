export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession, getSellerById } from '../../lib/seller-auth.js';
import {
  createMessage,
  getMessagesByBuyer,
  getMessagesBySeller,
  getMessageReplies,
  getMessageById,
  markThreadReadBySeller,
  markThreadReadByBuyer,
  deleteMessageThread,
} from '../../lib/messages.js';
import { createNotification, deleteNotificationsByRelatedIds } from '../../lib/notifications.js';

export const GET: APIRoute = async ({ request, cookies }) => {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  const url = new URL(request.url);
  const role = url.searchParams.get('role') ?? 'buyer';
  const repliesFor = url.searchParams.get('repliesFor');
  const storeId = url.searchParams.get('storeId');

  if (repliesFor) {
    const replies = getMessageReplies(repliesFor);
    return new Response(JSON.stringify({ replies }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (url.searchParams.get('unread') === '1') {
    const json = { 'Content-Type': 'application/json' };
    if (role === 'seller') {
      let originals = getMessagesBySeller(userId).filter((m) => !m.replyToId);
      if (storeId) originals = originals.filter((m) => m.toStoreId === storeId);
      const unreadIds = originals
        .filter((m) => !m.readBySeller || getMessageReplies(m.id).some((r) => r.toSellerId === userId && !r.readBySeller))
        .map((m) => m.id);
      return new Response(JSON.stringify({ unreadIds }), { headers: json });
    } else {
      const originals = getMessagesByBuyer(userId).filter((m) => !m.replyToId);
      const unreadIds = originals
        .filter((m) => getMessageReplies(m.id).some((r) => r.fromUserId !== userId && !r.readByBuyer))
        .map((m) => m.id);
      return new Response(JSON.stringify({ unreadIds }), { headers: json });
    }
  }

  const messages = role === 'seller'
    ? getMessagesBySeller(userId)
    : getMessagesByBuyer(userId);

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
    toSellerId?: string;
    toStoreName?: string;
    subject?: string;
    content?: string;
    productRef?: { productId: string; productName: string; productSlug: string; storeSlug: string };
    replyToId?: string;
    id?: string;
  };

  if (body.action === 'mark-read' && body.id) {
    const replies = getMessageReplies(body.id);
    const relatedIds = [body.id, ...replies.map((r) => r.id)];
    deleteNotificationsByRelatedIds(relatedIds, userId);
    markThreadReadBySeller(body.id, userId);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'mark-read-buyer' && body.id) {
    const replies = getMessageReplies(body.id);
    const relatedIds = [body.id, ...replies.map((r) => r.id)];
    deleteNotificationsByRelatedIds(relatedIds, userId);
    markThreadReadByBuyer(body.id);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'delete' && body.id) {
    const msg = getMessageById(body.id);
    if (!msg) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    const canDelete = msg.fromUserId === userId || msg.toSellerId === userId;
    if (!canDelete) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 403 });
    deleteMessageThread(body.id);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  const seller = getSellerById(userId);
  if (!seller) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });

  // Reply to an existing message (seller→buyer or buyer follow-up)
  if (body.replyToId && body.content?.trim()) {
    const original = getMessageById(body.replyToId);
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

    const reply = createMessage({
      fromUserId: userId,
      fromName: seller.name,
      fromEmail: seller.email,
      toStoreId: '',
      toSellerId: toId,
      toStoreName: toName,
      subject: `Re: ${original.subject}`,
      content: body.content.trim(),
      replyToId: body.replyToId,
    });

    createNotification({
      userId: toId,
      role: isSeller ? 'buyer' : 'seller',
      type: isSeller ? 'seller_reply' : 'new_message',
      title: isSeller ? 'יש לך הודעה חדשה ממוכר' : 'יש לך הודעה חדשה מקונה',
      body: '',
      relatedId: reply.id,
    });

    return new Response(JSON.stringify({ ok: true, message: reply }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Buyer sending a new message to a seller
  const { toStoreId, toSellerId, toStoreName, subject, content, productRef } = body;
  if (!toStoreId || !toSellerId || !subject?.trim() || !content?.trim()) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
  }

  const msg = createMessage({
    fromUserId: userId,
    fromName: seller.name,
    fromEmail: seller.email,
    toStoreId,
    toSellerId,
    toStoreName: toStoreName ?? '',
    subject: subject.trim(),
    content: content.trim(),
    productRef,
  });

  createNotification({
    userId: toSellerId,
    role: 'seller',
    type: 'new_message',
    title: 'יש לך הודעה חדשה מקונה',
    body: '',
    relatedId: msg.id,
  });

  return new Response(JSON.stringify({ ok: true, message: msg }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
