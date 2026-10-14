import { one, q } from '../db';
import { RunRow } from '../types';
import { flowOf } from '../engine/engine';

export interface Transcript { id: string; role: 'customer' | 'bot' | 'team'; text: string; created_at: string; attachments: { id: string; file_name: string }[] }

// A run and the flow of the graph it started on, read fresh.
export async function loadRun(runId: string) {
  const run = await one<RunRow>('select * from workflow_run where id = $1', [runId]);
  if (!run) throw new Error(`run ${runId} not found`);
  return { run, flow: flowOf(run) };
}

// The built-in {{variables}} every workflow can use.
export const baseVars = (conv: { customer_name: string; customer_email: string }): Record<string, string> =>
  ({ 'customer.name': conv.customer_name, 'customer.email': conv.customer_email, today: new Date().toISOString().slice(0, 10) });

export async function loadTranscript(conversationId: string): Promise<Transcript[]> {
  const rows = await q(`select m.id, m.role, m.text, m.created_at, coalesce(json_agg(json_build_object('id', a.id, 'file_name', a.file_name))
                          filter (where a.id is not null), '[]') as attachments
                        from message m left join attachment a on a.id = any(m.attachment_ids)
                        where m.conversation_id = $1 and m.role <> 'system' group by m.id order by m.created_at`, [conversationId]);
  return rows as Transcript[];
}

export async function saveRun(runId: string, run: Partial<RunRow> & { ended?: boolean; end_reason?: string }) {
  await q(`update workflow_run set status = $2, current_node_id = $3, facts = $4, waiting_for = $5, outbox = $6, paused_from = $7,
             updated_at = now(), ended_at = case when $8 then now() else ended_at end, end_reason = coalesce($9, end_reason)
           where id = $1`,
    [runId, run.status, run.current_node_id ?? null, JSON.stringify(run.facts), run.waiting_for ? JSON.stringify(run.waiting_for) : null,
     JSON.stringify(run.outbox ?? []), run.paused_from ? JSON.stringify(run.paused_from) : null, !!run.ended, run.end_reason ?? null]);
}
