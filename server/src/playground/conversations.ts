import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { PoolClient } from 'pg';
import { one, pool, q, tx } from '../db';
import { enqueue } from '../agents/inbox';

export const UPLOADS = process.env.UPLOADS_DIR || join(process.cwd(), 'uploads');
mkdirSync(UPLOADS, { recursive: true });

export interface NewFile { file_name: string; mime_type?: string; data_base64: string }

// Saves one uploaded file for a conversation (inside the caller's transaction when given one).
export async function saveAttachment(conversationId: string, f: NewFile, db: Pick<PoolClient, 'query'> = pool) {
  const data = Buffer.from(f.data_base64 ?? '', 'base64');
  if (!data.length || data.length > 5_000_000) throw new BadRequestException('file must be 1 byte to 5 MB');
  const mime = f.mime_type || 'application/octet-stream';
  const row = (await db.query(`insert into attachment (conversation_id, file_name, mime_type, size_bytes, sha256, path)
                               values ($1, $2, $3, $4, $5, '') returning id`,
    [conversationId, f.file_name, mime, data.length, createHash('sha256').update(data).digest('hex')])).rows[0];
  const path = join(UPLOADS, row.id);
  writeFileSync(path, data);
  await db.query('update attachment set path = $2 where id = $1', [row.id, path]);
  return { id: row.id as string, file_name: f.file_name, mime_type: mime };
}

const queue = (conversationId: string, messageId: string) =>
  enqueue(conversationId, 'customer_message', { messageId }).catch(async (e) => {
    await q(`insert into message (conversation_id, role, text) values ($1, 'system', $2)`, [conversationId, `Error: ${e.message}`]);
  });

// A new ticket: the conversation is created together with the customer's first message, in one transaction.
export async function openTicket(who: { name: string; email: string; channel: 'playground' | 'widget' }, b: { text?: string; files?: NewFile[] }) {
  const text = b.text?.trim() ?? '';
  if (!text && !b.files?.length) throw new BadRequestException('empty message');
  const { conversation, message } = await tx(async (db) => {
    const conversation = (await db.query(`insert into conversation (customer_name, customer_email, channel) values ($1, $2, $3) returning *`,
      [who.name, who.email, who.channel])).rows[0];
    const ids: string[] = [];
    for (const f of b.files ?? []) ids.push((await saveAttachment(conversation.id, f, db)).id);
    const message = (await db.query(`insert into message (conversation_id, role, text, attachment_ids) values ($1, 'customer', $2, $3) returning *`,
      [conversation.id, text, ids])).rows[0];
    return { conversation, message };
  });
  queue(conversation.id, message.id);
  return { conversation, message };
}

// A customer message from any channel (playground or widget). The inbox hands it to the supervisor; screens poll.
export async function postCustomerMessage(conversationId: string, b: { text?: string; attachment_ids?: string[] }) {
  if (!b.text?.trim() && !b.attachment_ids?.length) throw new BadRequestException('empty message');
  const m = await one(`insert into message (conversation_id, role, text, attachment_ids) values ($1, 'customer', $2, $3) returning *`,
    [conversationId, b.text?.trim() ?? '', b.attachment_ids ?? []]);
  queue(conversationId, m.id);
  return m;
}
