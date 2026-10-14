// Per-ticket event inbox: every trigger is a row, handled one at a time per conversation.
// The sweeper turns due reminders, expiries and approval timeouts into timer events.
import { Logger } from '@nestjs/common';
import { one, q } from '../db';
import { addEvent } from '../runner/events';
import { RunRow } from '../types';
import { approvalTurn, controlTurn, customerTurn, send } from './agents';

const log = new Logger('Inbox');
type Kind = 'customer_message' | 'approval_decided' | 'timer' | 'control';

export async function enqueue(conversationId: string, kind: Kind, payload: object) {
  await q(`insert into ticket_event (conversation_id, kind, payload) values ($1, $2, $3)`, [conversationId, kind, JSON.stringify(payload)]);
  kick(conversationId);
}

// One drain loop per conversation at a time; events run in insert order.
const draining = new Set<string>();
function kick(conversationId: string) {
  if (draining.has(conversationId)) return;
  draining.add(conversationId);
  drain(conversationId).catch((e) => log.error(e.message)).finally(() => {
    draining.delete(conversationId);
    // An event may have arrived as the loop finished.
    one(`select 1 from ticket_event where conversation_id = $1 and status = 'pending' limit 1`, [conversationId]).then((more) => more && kick(conversationId));
  });
}

async function drain(conversationId: string) {
  for (;;) {
    const ev = await one<{ id: string; kind: Kind; payload: any }>(`update ticket_event set status = 'working' where id = (
        select id from ticket_event where conversation_id = $1 and status = 'pending' order by id limit 1 for update skip locked) returning id, kind, payload`, [conversationId]);
    if (!ev) return;
    // Several quick messages: answer once, on the latest (the agents read the whole chat).
    if (ev.kind === 'customer_message' && await one(`select 1 from ticket_event where conversation_id = $1 and kind = 'customer_message' and status = 'pending' and id > $2`, [conversationId, ev.id])) {
      await q(`update ticket_event set status = 'done', error = 'merged into a later message', done_at = now() where id = $1`, [ev.id]);
      continue;
    }
    try {
      let seenId: string | undefined;
      if (ev.kind === 'customer_message') seenId = await customerTurn(conversationId, ev.payload.messageId);
      else if (ev.kind === 'approval_decided') seenId = await approvalTurn(conversationId, ev.payload);
      else if (ev.kind === 'control') seenId = await controlTurn(conversationId, ev.payload);
      else await timerTurn(conversationId, ev.payload.runId);
      await q(`update ticket_event set status = 'done', done_at = now() where id = $1`, [ev.id]);
      // Messages that turn already read and answered don't start another turn.
      if (seenId) await q(`update ticket_event e set status = 'done', error = 'answered in an earlier turn', done_at = now()
        where e.conversation_id = $1 and e.kind = 'customer_message' and e.status = 'pending'
          and exists (select 1 from message m where m.id::text = e.payload->>'messageId' and m.created_at <= (select created_at from message where id = $2))`, [conversationId, seenId]);
    } catch (e: any) {
      log.error(`event ${ev.id} (${ev.kind}) failed: ${e.message}`);
      await q(`update ticket_event set status = 'failed', error = $2, done_at = now() where id = $1`, [ev.id, e.message]);
      await q(`insert into message (conversation_id, role, text) values ($1, 'system', $2)`, [conversationId, `Error: ${e.message}`]);
    }
  }
}

// Timers need no AI: fixed reminder, closing and timeout texts.
async function timerTurn(conversationId: string, runId: string) {
  const r = await one<RunRow>('select * from workflow_run where id = $1', [runId]);
  const w = r?.waiting_for;
  const now = Date.now();
  const end = async (status: string, reason: string, text: string) => {
    await q(`update approval_task set status = case when status = 'pending' then $2 else status end where run_id = $1`, [runId, status === 'escalated' ? 'expired' : 'cancelled']);
    await q(`update workflow_run set status = $2, waiting_for = null, ended_at = now(), end_reason = $3, updated_at = now() where id = $1`, [runId, status, reason]);
    await addEvent(runId, null, 'system', `run_${status}`, { reason });
    await send(conversationId, runId, text);
  };
  if (r?.status === 'waiting_customer' && w?.type === 'customer') {
    if (now >= w.expires_at) return end('expired', 'customer did not reply', "I haven't heard back, so I'm closing this for now. Just reply any time to pick it up again.");
    if (now >= w.remind_at && !w.reminded) {
      await q(`update workflow_run set waiting_for = jsonb_set(waiting_for, '{reminded}', 'true') where id = $1`, [runId]);
      await addEvent(runId, w.node_id, 'system', 'reminder_sent', {});
      await send(conversationId, runId, `Just checking in: I still need ${w.expects.length ? w.expects.join(' and ').replace(/_/g, ' ') : 'a reply from you'} to continue.`);
    }
  } else if (r?.status === 'waiting_approval' && w?.type === 'approval' && now >= w.due_at) {
    await end('escalated', 'approval timed out', 'Our team needs a little more time on this. A teammate will follow up with you directly.');
  }
}

// Every 30 s: agent runs with a due reminder, expiry or approval timeout get a timer event (one pending per run).
async function sweep() {
  const due = await q<{ id: string; conversation_id: string }>(`select r.id, r.conversation_id from workflow_run r
    where r.waiting_for is not null and (
      (r.status = 'waiting_customer' and ((not (r.waiting_for->>'reminded')::boolean and (r.waiting_for->>'remind_at')::bigint <= $1)
                                          or (r.waiting_for->>'expires_at')::bigint <= $1))
      or (r.status = 'waiting_approval' and (r.waiting_for->>'due_at')::bigint <= $1))
    and not exists (select 1 from ticket_event e where e.conversation_id = r.conversation_id and e.kind = 'timer' and e.status in ('pending', 'working'))`, [Date.now()]);
  for (const r of due) await enqueue(r.conversation_id, 'timer', { runId: r.id });
}

// Boot: resume events left pending or cut off by a restart, then start the sweeper.
export async function startInbox() {
  await q(`update ticket_event set status = 'pending' where status = 'working'`);
  const open = await q<{ conversation_id: string }>(`select distinct conversation_id from ticket_event where status = 'pending'`);
  open.forEach((o) => kick(o.conversation_id));
  setInterval(() => sweep().catch((e) => log.error(`sweep: ${e.message}`)), 30_000);
}
