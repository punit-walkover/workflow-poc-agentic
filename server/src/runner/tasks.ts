import { config } from '../config';
import { one } from '../db';
import { RunRow } from '../types';
import { addEvent } from './events';

// Opens an approval task for a run's node, or returns the one already pending there.
export async function openTask(run: Pick<RunRow, 'id' | 'conversation_id'>, nodeId: string, t: {
  kind: 'evidence' | 'action'; summary: string; evidence: object; action_key?: string; action_args?: object;
}): Promise<string> {
  const due = new Date(Date.now() + config.approvalTimeoutSec * 1000);
  const existing = await one<{ id: string }>(`select id from approval_task where run_id = $1 and node_id = $2 and status = 'pending'`, [run.id, nodeId]);
  if (existing) return existing.id;
  const row = await one<{ id: string }>(`insert into approval_task (run_id, conversation_id, node_id, kind, action_key, action_args, summary, evidence, due_at)
                                         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [run.id, run.conversation_id, nodeId, t.kind, t.action_key ?? null, t.action_args ? JSON.stringify(t.action_args) : null,
     t.summary, JSON.stringify(t.evidence), due]);
  await addEvent(run.id, nodeId, 'system', 'approval_requested', { task_id: row!.id, kind: t.kind, summary: t.summary });
  return row!.id;
}
