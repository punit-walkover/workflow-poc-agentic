import { BadRequestException } from '@nestjs/common';
import { one, q } from '../db';
import { enqueue } from '../agents/inbox';

// A customer message from any channel (playground or widget). The inbox hands it to the supervisor; screens poll.
export async function postCustomerMessage(conversationId: string, b: { text?: string; attachment_ids?: string[] }) {
  if (!b.text?.trim() && !b.attachment_ids?.length) throw new BadRequestException('empty message');
  const m = await one(`insert into message (conversation_id, role, text, attachment_ids) values ($1, 'customer', $2, $3) returning *`,
    [conversationId, b.text?.trim() ?? '', b.attachment_ids ?? []]);
  enqueue(conversationId, 'customer_message', { messageId: m.id }).catch(async (e) => {
    await q(`insert into message (conversation_id, role, text) values ($1, 'system', $2)`, [conversationId, `Error: ${e.message}`]);
  });
  return m;
}
