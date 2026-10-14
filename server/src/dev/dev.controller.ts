// Dev-only routes (DEV_ENDPOINTS=1): start a test agent run and call each wf_* tool by hand, through the Mastra tool.
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { RequestContext } from '@mastra/core/request-context';
import { config } from '../config';
import { one, q } from '../db';
import { buildMap } from '../engine/map';
import { probeChat } from '../agents/mastra';
import { wfTools, WfToolName } from '../agents/tools';
import { agentRunState, decideAgentApproval, startAgentRun } from '../agents/wf-tools';
import { needsApproval } from '../workflows/workflows.service';

const guard = () => { if (!config.devEndpoints) throw new NotFoundException(); };
const runExists = async (id: string) => {
  if (!(await one('select 1 from workflow_run where id::text = $1', [id]))) throw new NotFoundException('run not found');
};

@Controller('dev')
export class DevController {
  // Body: { workflow_id }. Makes a test conversation and an agent run on the published workflow.
  @Post('agent-runs')
  async start(@Body() b: { workflow_id: string }) {
    guard();
    const w = await one('select 1 from workflow where id = $1 and published_graph is not null', [b.workflow_id]);
    if (!w) throw new BadRequestException('workflow not found or not published');
    const conv = await one<{ id: string }>(`insert into conversation (customer_name, customer_email) values ('Dev tester', 'dev@example.com') returning id`);
    return startAgentRun(conv!.id, b.workflow_id, 'dev endpoint');
  }

  @Get('agent-runs/:id')
  async state(@Param('id') id: string) {
    guard();
    await runExists(id);
    return agentRunState(id);
  }

  // Body: the tool's arguments. Runs the real Mastra tool with runId in the request context.
  @Post('agent-runs/:id/tools/:tool')
  async tool(@Param('id') id: string, @Param('tool') tool: string, @Body() args: Record<string, unknown>) {
    guard();
    await runExists(id);
    const t = wfTools[tool as WfToolName];
    if (!t?.execute) throw new BadRequestException(`unknown tool ${tool}; use one of ${Object.keys(wfTools).join(', ')}`);
    const parsed = (t.inputSchema as any).safeParse(args);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return t.execute(parsed.data, { requestContext: new RequestContext([['runId', id]]) } as any);
  }

  // Body: { approved, note? }. Decides the run's pending approval, as the approvals page does.
  @Post('agent-runs/:id/approval')
  async approval(@Param('id') id: string, @Body() b: { approved: boolean; note?: string }) {
    guard();
    const t = await one<{ id: string }>(`select id from approval_task where run_id = $1 and status = 'pending'`, [id]);
    if (!t) throw new BadRequestException('no pending approval');
    await q(`update approval_task set status = $2, decided_by = 'dev', decided_at = now(), decision_note = $3 where id = $1`, [t.id, b.approved ? 'approved' : 'rejected', b.note ?? null]);
    return decideAgentApproval(id, t.id, !!b.approved, 'dev', b.note);
  }

  // The read-only map an agent gets for a workflow's published graph.
  @Get('workflows/:id/map')
  async map(@Param('id') id: string) {
    guard();
    const w = await one(`select name, published_when_to_use, published_graph from workflow where id = $1 and published_graph is not null`, [id]);
    if (!w) throw new BadRequestException('not published');
    return buildMap(w.published_graph, { name: w.name, whenToUse: w.published_when_to_use ?? '' }, await needsApproval());
  }

  // Body: { message }. One call to the dev probe agent: checks the model key, Mastra memory and llm_usage.
  @Post('llm/probe')
  async probe(@Body() b: { message?: string }) {
    guard();
    const out = await probeChat(b.message || 'Say hello.', 'dev-probe');
    const usage = await q('select agent, model, input_tokens, output_tokens, created_at from llm_usage order by id desc limit 1');
    return { ...out, recorded: usage[0] ?? null };
  }
}
