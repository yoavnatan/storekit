import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MESSAGES_PATH = path.join(process.cwd(), 'data/messages.json');

export interface MessageProductRef {
  productId: string;
  productName: string;
  productSlug: string;
  storeSlug: string;
}

export interface Message {
  id: string;
  fromUserId: string;
  fromName: string;
  fromEmail: string;
  toStoreId: string;
  toSellerId: string;
  toStoreName: string;
  subject: string;
  content: string;
  productRef?: MessageProductRef;
  replyToId?: string;
  readBySeller: boolean;
  readByBuyer?: boolean;
  createdAt: string;
}

function readMessages(): Message[] {
  try { return JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8')) as Message[]; }
  catch { return []; }
}

function writeMessages(messages: Message[]): void {
  fs.writeFileSync(MESSAGES_PATH, JSON.stringify(messages, null, 2));
}

export function createMessage(
  input: Omit<Message, 'id' | 'createdAt' | 'readBySeller'>
): Message {
  const messages = readMessages();
  const msg: Message = {
    ...input,
    id: crypto.randomUUID(),
    readBySeller: false,
    createdAt: new Date().toISOString(),
  };
  messages.push(msg);
  writeMessages(messages);
  return msg;
}

export function getMessagesByBuyer(userId: string): Message[] {
  return readMessages()
    .filter((m) => m.fromUserId === userId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function getMessagesBySeller(sellerId: string): Message[] {
  return readMessages()
    .filter((m) => m.toSellerId === sellerId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function markMessageReadBySeller(id: string): void {
  const messages = readMessages();
  const idx = messages.findIndex((m) => m.id === id);
  if (idx !== -1) { messages[idx]!.readBySeller = true; writeMessages(messages); }
}

export function markThreadReadBySeller(originalId: string, sellerId: string): void {
  const messages = readMessages();
  let changed = false;
  messages.forEach((m) => {
    if ((m.id === originalId || m.replyToId === originalId) && m.toSellerId === sellerId && !m.readBySeller) {
      m.readBySeller = true;
      changed = true;
    }
  });
  if (changed) writeMessages(messages);
}

export function getUnreadCountBySeller(sellerId: string): number {
  return readMessages().filter((m) => m.toSellerId === sellerId && !m.readBySeller).length;
}

export function getMessageReplies(messageId: string): Message[] {
  return readMessages()
    .filter((m) => m.replyToId === messageId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export function getMessageById(id: string): Message | null {
  return readMessages().find((m) => m.id === id) ?? null;
}

export function markMessageReadByBuyer(messageId: string): void {
  const messages = readMessages();
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx !== -1) { messages[idx]!.readByBuyer = true; writeMessages(messages); }
}

export function markThreadReadByBuyer(originalId: string): void {
  const messages = readMessages();
  let changed = false;
  messages.forEach((m) => {
    if ((m.id === originalId || m.replyToId === originalId) && !m.readByBuyer) {
      m.readByBuyer = true;
      changed = true;
    }
  });
  if (changed) writeMessages(messages);
}

export function deleteMessageThread(messageId: string): boolean {
  const messages = readMessages();
  const original = messages.find((m) => m.id === messageId);
  if (!original) return false;
  const filtered = messages.filter((m) => m.id !== messageId && m.replyToId !== messageId);
  writeMessages(filtered);
  return true;
}
