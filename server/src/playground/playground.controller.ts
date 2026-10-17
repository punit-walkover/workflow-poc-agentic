import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Res } from '@nestjs/common';
import { createReadStream } from 'fs';
import type { Response } from 'express';
import { one, q } from '../db';
import { priceOf } from '../agents/usage';
import { NewFile, openTicket, postCustomerMessage, saveAttachment } from './conversations';

@Controller()
export class PlaygroundController {
  @Get('conversations')
  list() {
    return q(`select c.*, (select status from workflow_run r where r.conversation_id = c.id order by started_at desc limit 1) as run_status,
                     (select text from message m where m.conversation_id = c.id and m.role <> 'system' order by created_at desc limit 1) as last_text,
                     (select count(*)::int from approval_task t where t.conversation_id = c.id and t.status = 'pending') as pending_approvals
              from conversation c order by c.created_at desc`);
  }

  // A new ticket starts with the customer's first message: both are created in this one call.
  @Post('conversations')
  async create(@Body() b: { customer_name?: string; customer_email?: string; text?: string; files?: NewFile[] }) {
    const { conversation } = await openTicket(
      { name: b.customer_name?.trim() || 'Alex Kim', email: b.customer_email?.trim() || 'alex@example.com', channel: 'playground' }, b);
    return conversation;
  }

  // One AI call's full exchange: per round, the request sent to the model and its response.
  @Get('ai-calls/:id')
  async aiCall(@Param('id') id: string) {
    const u = await one(`select id, conversation_id, run_id, agent, model, input_tokens, output_tokens, cost_usd,
                                started_at, trace from llm_usage where id::text = $1`, [id]);
    if (!u) throw new NotFoundException();
    return { ...u, cost_usd: u.cost_usd === null ? priceOf(u.model, u.input_tokens, u.output_tokens) : Number(u.cost_usd) };
  }

  // Everything the playground screen shows, in one poll.
  @Get('conversations/:id')
  async get(@Param('id') id: string) {
    const conversation = await one('select * from conversation where id = $1', [id]);
    if (!conversation) throw new NotFoundException();
    const messages = await q(`select m.*, coalesce(json_agg(json_build_object('id', a.id, 'file_name', a.file_name, 'mime_type', a.mime_type))
                                filter (where a.id is not null), '[]') as attachments
                              from message m left join attachment a on a.id = any(m.attachment_ids)
                              where m.conversation_id = $1 group by m.id order by m.created_at`, [id]);
    const runs = await q(`select r.* from workflow_run r
                          where r.conversation_id = $1 order by r.started_at desc`, [id]);
    // Every run's events (a topic switch starts a new run; the timeline shows both), newest 500, in order.
    const events = runs.length
      ? (await q('select * from run_event where run_id = any($1) order by id desc limit 500', [runs.map((r: any) => r.id)])).reverse()
      : [];
    const approvals = await q(`select * from approval_task where conversation_id = $1 order by created_at desc`, [id]);
    const actionRuns = runs[0] ? await q('select * from action_run where run_id = $1 order by started_at', [runs[0].id]) : [];
    // Every model call of this conversation (supervisor, workflow agents, runner), with cost where known.
    // In the order the calls started.
    const calls = (await q(`select id, agent, model, input_tokens, output_tokens, cost_usd, started_at from llm_usage
                            where conversation_id = $1 order by started_at, id`, [id])).map((u: any) => ({
      ...u, cost_usd: u.cost_usd === null ? priceOf(u.model, u.input_tokens, u.output_tokens) : Number(u.cost_usd) }));
    const ai_usage = {
      calls, count: calls.length,
      input_tokens: calls.reduce((n: number, u: any) => n + (u.input_tokens ?? 0), 0),
      output_tokens: calls.reduce((n: number, u: any) => n + (u.output_tokens ?? 0), 0),
      cost_usd: calls.reduce((n: number, u: any) => n + (u.cost_usd ?? 0), 0),
      unpriced: [...new Set(calls.filter((u: any) => u.cost_usd === null).map((u: any) => u.model))],
    };
    return { conversation, messages, runs, events, approvals, action_runs: actionRuns, ai_usage };
  }

  @Post('conversations/:id/messages')
  send(@Param('id') id: string, @Body() b: { text?: string; attachment_ids?: string[] }) {
    return postCustomerMessage(id, b);
  }

  // A teammate writes in the chat. It is part of the transcript but does not wake the run.
  @Post('conversations/:id/team-messages')
  async teamSend(@Param('id') id: string, @Body() b: { text?: string }) {
    if (!b.text?.trim()) throw new BadRequestException('empty message');
    return one(`insert into message (conversation_id, role, text) values ($1, 'team', $2) returning *`, [id, b.text.trim()]);
  }

  @Post('attachments')
  upload(@Body() b: { conversation_id: string } & NewFile) {
    return saveAttachment(b.conversation_id, b);
  }

  @Get('attachments/:id')
  async file(@Param('id') id: string, @Res() res: Response) {
    const a = await one('select * from attachment where id = $1', [id]);
    if (!a) throw new NotFoundException();
    res.setHeader('Content-Type', a.mime_type);
    createReadStream(a.path).pipe(res);
  }
}
