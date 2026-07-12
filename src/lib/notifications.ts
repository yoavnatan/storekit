import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NOTIFS_PATH = path.join(process.cwd(), 'data/notifications.json');

export type NotificationType = 'new_message' | 'seller_reply' | 'new_order' | 'order_update' | 'low_stock' | 'out_of_stock';
export type NotificationRole = 'buyer' | 'seller';

export interface Notification {
  id: string;
  userId: string;
  role: NotificationRole;
  type: NotificationType;
  title: string;
  body: string;
  read: boolean;
  relatedId?: string;
  createdAt: string;
}

function readNotifs(): Notification[] {
  try { return JSON.parse(fs.readFileSync(NOTIFS_PATH, 'utf8')) as Notification[]; }
  catch { return []; }
}

function writeNotifs(notifs: Notification[]): void {
  fs.writeFileSync(NOTIFS_PATH, JSON.stringify(notifs, null, 2));
}

export function createNotification(
  input: Omit<Notification, 'id' | 'read' | 'createdAt'>
): Notification {
  const notifs = readNotifs();
  const notif: Notification = {
    ...input,
    id: crypto.randomUUID(),
    read: false,
    createdAt: new Date().toISOString(),
  };
  notifs.push(notif);
  writeNotifs(notifs);
  return notif;
}

export function getNotificationsForUser(userId: string, since?: string): Notification[] {
  return readNotifs()
    .filter((n) => {
      if (n.userId !== userId) return false;
      if (since) return new Date(n.createdAt) > new Date(since);
      return true;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50);
}

export function getUnreadCountForUser(userId: string): number {
  return readNotifs().filter((n) => n.userId === userId && !n.read).length;
}

export function getUnreadSellerReplyCount(userId: string): number {
  return readNotifs().filter((n) => n.userId === userId && n.type === 'seller_reply' && !n.read).length;
}

export function markNotificationRead(id: string, userId: string): boolean {
  const notifs = readNotifs();
  const idx = notifs.findIndex((n) => n.id === id && n.userId === userId);
  if (idx === -1) return false;
  notifs[idx]!.read = true;
  writeNotifs(notifs);
  return true;
}

export function markAllReadForUser(userId: string): void {
  const notifs = readNotifs();
  notifs.forEach((n) => { if (n.userId === userId) n.read = true; });
  writeNotifs(notifs);
}

export function deleteNotificationsByRelatedIds(relatedIds: string[], userId: string): void {
  const notifs = readNotifs();
  const filtered = notifs.filter((n) => !(n.userId === userId && n.relatedId && relatedIds.includes(n.relatedId)));
  if (filtered.length !== notifs.length) writeNotifs(filtered);
}
