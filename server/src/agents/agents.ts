// The supervisor (reads every customer message, routes it) and one workflow agent per published workflow.
// One turn per inbox event; only one agent writes the customer's reply per turn.
import { createHash } from 'crypto';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { config } from '../config';
import { one, q } from '../db';
import { buildMap } from '../engine/map';
import { WorkflowGraph } from '../types';
import { needsApproval } from '../workflows/workflows.service';
import { loadTranscript } from '../runner/context';
import { addEvent } from '../runner/events';
import { ACTIVE } from '../types';
import { model } from './mastra';
import { BASE_PROMPT, supervisorPrompt, turnContext, workflowPrompt } from './prompts';
import { wfTools } from './tools';
import { trackedGenerate } from './usage';
import { agentRunState, controlAgentRun, decideAgentApproval, wfHandoff, wfStart, wfSwitchWorkflow } from './wf-tools';

// Shared across the supervisor and the workflow agent it delegates to (runId changes on start/switch).
// seenId: the newest customer message the agents have read this turn (a newer one makes the reply stale).
export interface Turn { conversationId: string; messageId: string | null; runId: string | null; delegated: boolean; yielded?: string; seenId?: string }
const turnOf = (ctx: { requestContext: { get(k: string): unknown } }) => ctx.requestContext.get('turn') as Turn;
const sysNote = (conversationId: string, text: string) => q(`insert into message (conversation_id, role, text) values ($1, 'system', $2)`, [conversationId, text]);

// The chat so far, as model messages (system notes left out). Notes on the turn which customer messages were read.
async function history(turn: Turn) {
  const rows = await loadTranscript(turn.conversationId);
  const last = [...rows].reverse().find((m: any) => m.role === 'customer') as { id?: string } | undefined;
  if (last?.id) turn.seenId = last.id;
  return rows.slice(-20).map((m: any) => ({
    role: m.role === 'customer' ? 'user' as const : 'assistant' as const,
    content: `${m.role === 'team' ? '[Teammate] ' : ''}${m.text || '(attachment)'}${m.attachments?.length ? ` [${m.attachments.length} attachment(s)]` : ''}`,
  }));
}

// ── Workflow agents ──

// The workflow agent gives the turn back when the customer wants something its workflow can't do; the supervisor picks again.
const wfYield = createTool({
  id: 'wf_yield', description: 'The customer now wants something this workflow does not cover: give the turn back to the supervisor. Write nothing after it.',
  inputSchema: z.object({ reason: z.string() }),
  execute: async (a, ctx) => {
    const turn = turnOf(ctx);
    if (turn.yielded) return { ok: false, reason: 'Already handed back once this turn', fix: 'Continue the workflow or call wf_handoff.' };
    turn.yielded = a.reason;
    await addEvent(turn.runId!, null, 'ai', 'yielded', { reason: a.reason });
    return { ok: true, note: 'The supervisor takes over. Write nothing.' };
  },
});
const workflowTools = { wf_save_input: wfTools.wf_save_input, wf_choose_case: wfTools.wf_choose_case, wf_complete_step: wfTools.wf_complete_step,
                        call_action: wfTools.call_action, wf_handoff: wfTools.wf_handoff, wf_yield: wfYield };
const agents = new Map<string, { agent: Agent; prompt: string; name: string }>();

// One agent per workflow graph a run started on, built from its map (cached; a new publish gets a new agent).
async function workflowAgent(run: { workflow_id: string; workflow_name: string; graph: WorkflowGraph }) {
  const key = `${run.workflow_id}:${createHash('sha1').update(JSON.stringify(run.graph)).digest('hex')}`;
  const hit = agents.get(key);
  if (hit) return hit;
  const w = await one<{ when_to_use: string; published_when_to_use: string | null }>('select when_to_use, published_when_to_use from workflow where id = $1', [run.workflow_id]);
  const map = buildMap(run.graph, { name: run.workflow_name, whenToUse: w?.published_when_to_use ?? w?.when_to_use ?? '' }, await needsApproval()).text;
  const prompt = workflowPrompt(map);
  const entry = { name: run.workflow_name, prompt, agent: new Agent({ id: `workflow-${run.workflow_id}`, name: `workflow: ${run.workflow_name}`, instructions: prompt, model: () => model(), tools: workflowTools }) };
  agents.set(key, entry);
  return entry;
}

// Runs the workflow agent on the turn's run and sends its reply (bubbles checked).
export async function workflowTurn(rc: RequestContext, intent: string, note?: string) {
  const turn = rc.get('turn') as Turn;
  const runId = turn.runId!;
  const run = await one<{ workflow_id: string; workflow_name: string; graph: WorkflowGraph }>('select workflow_id, workflow_name, graph from workflow_run where id = $1', [runId]);
  const wf = await workflowAgent(run!);
  const s = await agentRunState(runId);
  const messages = await history(turn);
  if (!turn.messageId) messages.push({ role: 'user', content: '(No new customer message. Continue the workflow and tell the customer what happened.)' });
  const started = Date.now();
  await addEvent(runId, s.next?.id ?? null, 'ai', 'agent_turn', { agent: `workflow: ${wf.name}`, intent, note: note ?? null });
  const out = await trackedGenerate(wf.agent, messages, { agent: `workflow: ${wf.name}`, conversationId: turn.conversationId, runId }, {
    instructions: `${wf.prompt}\n\n${turnContext({ card: s.next, progress: s.progress, intent, note, pending: s.say, actions: s.actions ?? [] })}`,
    requestContext: rc, maxSteps: 24, // one tool round per block
  });
  await addEvent(runId, null, 'ai', 'agent_replied', { agent: `workflow: ${wf.name}`, ms: Date.now() - started, tokens: out.totalUsage?.totalTokens ?? null, usage_id: out.usageId });
  if (turn.yielded) return; // handed back: the supervisor replies or switches; pending bubbles wait
  await deliver(turn, runId, out.text?.trim() ?? '', wf.agent);
  await markWaiting(runId);
}

// The customer wrote something this turn never read: its reply answers an old chat, so the next turn answers everything.
const newerMessage = async (turn: Turn) =>
  !!(await one(`select 1 from message where conversation_id = $1 and role = 'customer'
    and ($2::uuid is null or created_at > (select created_at from message where id = $2)) limit 1`, [turn.conversationId, turn.seenId ?? null]));

// Bubble check: the reply must contain each pending bubble word for word. One rewrite, then the server adds what's missing.
async function deliver(turn: Turn, runId: string, text: string, agent: Agent) {
  const conversationId = turn.conversationId;
  if (await newerMessage(turn)) {
    return void (await addEvent(runId, null, 'system', 'reply_dropped', { reason: 'the customer wrote again during this turn', text })); // bubbles stay pending
  }
  const run = await one<{ outbox: any[] }>('select outbox from workflow_run where id = $1', [runId]);
  const pending: string[] = (run?.outbox ?? []).map((o) => o.text);
  let reply = text;
  const missing = () => pending.filter((b) => !reply.includes(b));
  if (reply && missing().length) {
    const fix = await trackedGenerate(agent, `Rewrite this reply so it contains each line below word for word, in order, and keeps the rest. Reply with the new text only.\nREPLY:\n${reply}\nLINES:\n${missing().join('\n')}`,
      { agent: 'bubble-fix', conversationId, runId }, { instructions: BASE_PROMPT, activeTools: [], maxSteps: 1 });
    if (fix.text?.trim()) reply = fix.text.trim();
    await addEvent(runId, null, 'system', 'bubble_fixed', { by: 'rewrite', still_missing: missing().length, usage_id: fix.usageId });
  }
  if (missing().length) {
    await addEvent(runId, null, 'system', 'bubble_fixed', { by: 'server', added: missing() });
    reply = [reply, ...missing()].filter(Boolean).join('\n\n');
  }
  if (reply) await send(conversationId, runId, reply);
  await q(`update workflow_run set outbox = '[]'::jsonb where id = $1`, [runId]);
}

export async function send(conversationId: string, runId: string | null, text: string) {
  await q(`insert into message (conversation_id, role, text, run_id) values ($1, 'bot', $2, $3)`, [conversationId, text, runId]);
  if (runId) await addEvent(runId, null, 'ai', 'message_sent', { text });
}

// After a turn, an active run waits for the customer, with the reminder and expiry timers the sweeper checks.
async function markWaiting(runId: string) {
  const now = Date.now();
  const s = await agentRunState(runId);
  if (s.status !== 'running') return;
  const waiting = { type: 'customer', node_id: s.next?.id ?? null, expects: s.next?.collects ? [s.next.collects.name] : [],
                    remind_at: now + config.remindAfterSec * 1000, expires_at: now + config.expireAfterSec * 1000, reminded: false };
  await q(`update workflow_run set status = 'waiting_customer', waiting_for = $2, updated_at = now() where id = $1 and status = 'running'`, [runId, JSON.stringify(waiting)]);
}

// ── Supervisor ──

const DELEGATE = ['answer', 'not_an_answer', 'off_topic'] as const;
const supervisorTools = {
  start_workflow: createTool({
    id: 'start_workflow', description: 'Start a published workflow (no workflow may be active). Confidence 0.7 or more.',
    inputSchema: z.object({ workflow_id: z.string(), confidence: z.number(),
      reason: z.string().describe('One sentence on what the customer wants. The first one becomes the ticket summary.') }),
    execute: async (a, ctx) => {
      const turn = turnOf(ctx);
      const r = await wfStart(turn.conversationId, a);
      if (r.ok) {
        turn.runId = r.run_id;
        // The ticket summary is set once, from the first workflow start, and never rewritten.
        await q('update conversation set summary = $2 where id = $1 and summary is null', [turn.conversationId, a.reason.trim()]);
        await sysNote(turn.conversationId, `Supervisor: started a workflow (confidence ${a.confidence.toFixed(2)}). ${a.reason}`);
        if (turn.messageId) await addEvent(r.run_id, null, 'customer', 'customer_message', { messageId: turn.messageId });
      }
      return r.ok ? { ok: true, run_started: true } : r;
    },
  }),
  switch_workflow: createTool({
    id: 'switch_workflow', description: 'End the active workflow and start another the customer clearly asked for. Confidence 0.8 or more.',
    inputSchema: z.object({ workflow_id: z.string(), confidence: z.number(), reason: z.string() }),
    execute: async (a, ctx) => {
      const turn = turnOf(ctx);
      if (!turn.runId) return { ok: false, reason: 'No active workflow', fix: 'Use start_workflow.' };
      const r = await wfSwitchWorkflow(turn.runId, a);
      if (r.ok) {
        turn.runId = r.run_id;
        await sysNote(turn.conversationId, `Supervisor: switched workflow (confidence ${a.confidence.toFixed(2)}). ${a.reason}`);
        if (turn.messageId) await addEvent(r.run_id, null, 'customer', 'customer_message', { messageId: turn.messageId });
      }
      return r.ok ? { ok: true, switched: true } : r;
    },
  }),
  delegate_to_workflow: createTool({
    id: 'delegate_to_workflow', description: 'Hand this turn to the active workflow agent. It writes the reply to the customer.',
    inputSchema: z.object({ intent: z.enum(DELEGATE), note: z.string().optional() }),
    execute: async (a, ctx) => {
      const turn = turnOf(ctx);
      if (!turn.runId) return { ok: false, reason: 'No active workflow', fix: 'Use start_workflow first, or reply yourself.' };
      if (turn.delegated) return { ok: false, reason: 'Already delegated this turn', fix: 'Write nothing more.' };
      turn.delegated = true;
      await addEvent(turn.runId, null, 'ai', 'supervisor_delegated', { intent: a.intent, note: a.note ?? null });
      await workflowTurn(ctx.requestContext as RequestContext, a.intent, a.note);
      if (turn.yielded) {
        turn.delegated = false;
        return { ok: false, yielded: turn.yielded, fix: 'The workflow agent handed back. Use switch_workflow and delegate again, or reply yourself.' };
      }
      return { ok: true, delivered: true };
    },
  }),
  hand_off: createTool({
    id: 'hand_off', description: 'The customer wants a person: hand the conversation to a teammate.',
    inputSchema: z.object({ reason: z.string() }),
    execute: async (a, ctx) => {
      const turn = turnOf(ctx);
      if (turn.runId) await wfHandoff(turn.runId, a);
      await sysNote(turn.conversationId, `Escalated to a human: ${a.reason}`);
      return { ok: true };
    },
  }),
};
const supervisor = new Agent({ id: 'supervisor', name: 'supervisor', instructions: BASE_PROMPT, model: () => model(), tools: supervisorTools });

// A customer message: the supervisor decides; it either delegates (the workflow agent replies) or replies itself.
export async function customerTurn(conversationId: string, messageId: string): Promise<string | undefined> {
  const active = await one<{ id: string; name: string; status: string }>(`select r.id, r.status, r.workflow_name as name from workflow_run r
    where r.conversation_id = $1 and r.status = any($2)`, [conversationId, ACTIVE]);
  if (!active) {
    const last = await one<{ status: string }>('select status from workflow_run where conversation_id = $1 order by started_at desc limit 1', [conversationId]);
    if (last?.status === 'escalated') return void (await sysNote(conversationId, 'Escalated to a human: the bot stays quiet on this conversation.'));
  }
  // A paused run keeps the message; the bot answers again after a teammate resumes it.
  if (active?.status === 'paused') {
    await addEvent(active.id, null, 'customer', 'customer_message', { messageId });
    return void (await sysNote(conversationId, 'The workflow is paused: the bot will reply after a teammate resumes it.'));
  }
  const turn: Turn = { conversationId, messageId, runId: active?.id ?? null, delegated: false };
  const rc = new RequestContext();
  rc.set('turn', turn);
  let desc = 'none';
  if (active) {
    await addEvent(active.id, null, 'customer', 'customer_message', { messageId });
    const s = await agentRunState(active.id);
    desc = `"${active.name}" — current step: ${s.next ? `${s.next.type} "${s.next.text}"` : 'none'}; ${s.progress}`;
  }
  // Routing uses the published "when to use", so draft edits don't change it until they're published.
  const workflows = await q<{ id: string; name: string; when_to_use: string }>(`select id, name, coalesce(published_when_to_use, '') as when_to_use from workflow
    where enabled and archived_at is null and published_graph is not null order by name`);
  const supStarted = Date.now();
  const out = await trackedGenerate(supervisor, await history(turn), { agent: 'supervisor', conversationId, runId: turn.runId }, {
    instructions: supervisorPrompt(workflows, desc), requestContext: rc, maxSteps: 6,
  });
  // The supervisor's own call (its time includes the workflow agent it delegated to).
  if (turn.runId) await addEvent(turn.runId, null, 'ai', 'supervisor_replied', { ms: Date.now() - supStarted, tokens: out.totalUsage?.totalTokens ?? null, usage_id: out.usageId });
  if (turn.delegated) return turn.seenId;
  const text = out.text?.trim();
  if (text && await newerMessage(turn)) { await sysNote(conversationId, 'Supervisor reply dropped: the customer wrote again.'); return turn.seenId; }
  if (text) await send(conversationId, turn.runId, text);
  await sysNote(conversationId, 'Supervisor: replied directly (no workflow agent).');
  return turn.seenId;
}

// A teammate's run panel control (pause / resume / cancel / retry). After a successful retry the agent tells the customer.
export async function controlTurn(conversationId: string, p: { runId: string; op: 'pause' | 'resume' | 'cancel' | 'retry'; by: string }) {
  const r = await controlAgentRun(p.runId, p.op, p.by);
  if (!r.ok) return void (await sysNote(conversationId, `${p.op} failed: ${r.reason}`));
  if (!r.turn) return;
  const rc = new RequestContext();
  const turn: Turn = { conversationId, messageId: null, runId: p.runId, delegated: true };
  rc.set('turn', turn);
  await workflowTurn(rc, 'resume', p.op === 'retry' ? 'A teammate retried the step that failed.' : undefined);
  return turn.seenId;
}

// The team decided an approval: the engine applies it, then the workflow agent tells the customer.
// A rejection escalates the run, so the customer gets one fixed line and the bot stays quiet after it.
export async function approvalTurn(conversationId: string, p: { runId: string; taskId: string; approved: boolean; by: string; note?: string }) {
  const r = await decideAgentApproval(p.runId, p.taskId, p.approved, p.by, p.note);
  if (!r.ok) return void (await send(conversationId, p.runId, 'Sorry, I hit a problem on my side. A teammate will take a look and follow up.'));
  if (!p.approved) return void (await send(conversationId, p.runId, "The team couldn't approve this request, so a teammate will follow up with you directly."));
  const rc = new RequestContext();
  const turn: Turn = { conversationId, messageId: null, runId: p.runId, delegated: true };
  rc.set('turn', turn);
  await workflowTurn(rc, 'resume', `The team ${p.approved ? 'approved' : 'rejected'} the request${p.note ? `: ${p.note}` : ''}.`);
  return turn.seenId;
}
