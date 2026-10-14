import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { one, q } from '../db';
import { enqueue } from '../agents/inbox';

// Which run statuses each teammate control accepts.
const ALLOWED: Record<string, string[]> = {
  pause: ['running', 'waiting_customer', 'waiting_approval'], resume: ['paused'], retry: ['failed'],
  cancel: ['running', 'waiting_customer', 'waiting_approval', 'paused', 'failed'],
};

@Controller()
export class RunsController {
  // Teammate controls on a run: pause | resume | cancel | retry. Checked now, applied by the inbox in order with agent turns.
  @Post('runs/:id/:op')
  async control(@Param('id') id: string, @Param('op') op: string, @Body() b: { by?: string }) {
    if (!ALLOWED[op]) throw new BadRequestException('unknown operation');
    const run = await one<{ status: string; conversation_id: string }>('select status, conversation_id from workflow_run where id = $1', [id]);
    if (!run) throw new NotFoundException('run not found');
    if (!ALLOWED[op].includes(run.status)) throw new BadRequestException(`"${op}" is not allowed while the run is ${run.status}`);
    await enqueue(run.conversation_id, 'control', { runId: id, op, by: b?.by || 'teammate' });
    return { ok: true };
  }

  @Get('approvals')
  approvals(@Query('status') status = 'pending') {
    return q(`select t.*, c.customer_name, c.customer_email, r.workflow_name,
                     coalesce((select json_agg(json_build_object('id', a.id, 'file_name', a.file_name, 'mime_type', a.mime_type))
                               from attachment a where a.id::text in (select jsonb_array_elements_text(t.evidence->'attachment_ids'))), '[]') as attachments
              from approval_task t join conversation c on c.id = t.conversation_id
              join workflow_run r on r.id = t.run_id
              where ($1 = 'all' or t.status = $1) order by t.created_at desc`, [status]);
  }

  // The inbox applies the decision, then the workflow agent tells the customer.
  @Post('approvals/:id/decide')
  async decide(@Param('id') id: string, @Body() b: { approved: boolean; note?: string; by?: string }) {
    const t = await one(`update approval_task set status = $2, decided_by = coalesce($3, 'Team'), decided_at = now(),
                           decision_note = $4 where id = $1 and status = 'pending' returning *`,
      [id, b.approved ? 'approved' : 'rejected', b.by?.trim() || null, b.note ?? null]);
    if (!t) throw new NotFoundException('task not pending');
    await enqueue(t.conversation_id, 'approval_decided', { runId: t.run_id, taskId: id, approved: !!b.approved, by: t.decided_by, note: b.note });
    return t;
  }
}
