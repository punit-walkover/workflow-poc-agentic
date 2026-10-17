// wf_* moves on agent runs. Each one checks the move against the run's saved state with the engine, applies it,
// and returns the next step card, or rejects it with a reason and a fix. Agents never write run state directly.
import { executeAction, getAction } from '../actions/execute';
import { one, q } from '../db';
import {
  approvalTask, ruleValues, chooseByRules, bubbleText, checkAnswer, completeError, countAsk, EngineEvent, flowOf, follow, Jump, LIMIT, planCall, ranOutput, reachableInput, recordCase,
  saveAnswer, saveResponse, settle, Settled, shownVars, stepCard, StepCard, varsFor, visitOf, askText,
} from '../engine/engine';
import { baseVars, loadRun, saveRun } from '../runner/context';
import { addEvent } from '../runner/events';
import { openTask } from '../runner/tasks';
import { RunRow, RunStatus, StepNode, WorkflowGraph } from '../types';
import { stepActions } from '../workflows/inline';

export type ToolOk = { ok: true; run_id: string; status: RunStatus; progress: string; next: StepCard | null; actions?: string[]; say: string[]; result?: unknown };
export type ToolErr = { ok: false; reason: string; fix: string };
export type ToolResult = ToolOk | ToolErr;

const reject = (reason: string, fix: string): ToolErr => ({ ok: false, reason, fix });
const TERMINAL: RunStatus[] = ['completed', 'escalated', 'expired', 'cancelled'];

// One move at a time per run (Stage 2 replaces this with the per-ticket inbox lock).
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, run.catch(() => undefined));
  return run;
}

type Ctx = Awaited<ReturnType<typeof load>>;

async function load(runId: string) {
  const { run, flow } = await loadRun(runId);
  const conv = await one<{ customer_name: string; customer_email: string }>('select customer_name, customer_email from conversation where id = $1', [run.conversation_id]);
  const declared = run.graph.variables ?? [];
  return { run: { ...run, outbox: [...run.outbox] } as RunRow, flow, base: baseVars(conv!), declared };
}

const shown = (c: Ctx) => shownVars(c.declared, varsOf(c));
const varsOf = (c: Ctx) => varsFor(c.base, c.declared, c.run.facts);

// Short progress line the agent reads with every result.
function progress(r: RunRow): string {
  const vals = Object.entries(r.facts.vars ?? {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return vals.length ? `Collected: ${vals.join(', ')}` : 'Nothing collected yet';
}

const pendingSay = (r: RunRow) => r.outbox.map((o) => o.text);

// Every result carries the next step card and, for an AI step, the args its actions take.
async function ok(c: Ctx, result?: unknown): Promise<ToolOk> {
  const r = c.run;
  const next = TERMINAL.includes(r.status) ? null : stepCard(c.flow, r.current_node_id, shown(c), r.facts);
  const actions = next?.tools.length ? (await q<any>('select key, input_schema from action where key = any($1)', [next.tools])).map((x) => `${x.key}(${argSpec(x)})`) : [];
  return { ok: true, run_id: r.id, status: r.status, progress: progress(r), next, ...(actions.length ? { actions } : {}),
           say: pendingSay(r), ...(result === undefined ? {} : { result }) };
}

async function log(runId: string, events: EngineEvent[], actor = 'system') {
  for (const e of events) await addEvent(runId, e.nodeId, actor, e.type, e.data);
}

// Save where the engine landed: the next node for the agent, or the end of the run. Bubbles wait in the outbox.
async function commit(c: Ctx, s: Settled, events: EngineEvent[], result?: unknown): Promise<ToolOk> {
  const r = c.run;
  r.current_node_id = s.end?.status === 'completed' ? null : s.at;
  r.waiting_for = null;
  r.status = s.end ? s.end.status : 'running';
  await saveRun(r.id, { ...r, ended: !!s.end, end_reason: s.end?.reason });
  await log(r.id, events);
  if (s.end) {
    await q(`update approval_task set status = 'cancelled' where run_id = $1 and status = 'pending'`, [r.id]);
    await addEvent(r.id, null, 'system', s.end.status === 'completed' ? 'run_completed' : `run_${s.end.status}`, { reason: s.end.reason });
  }
  return ok(c, result);
}

// Leave `from` along `jump` (a loop back counts a visit); the run then waits at the next block for the agent.
function advance(c: Ctx, from: string, jump: Jump, result?: unknown) {
  const j = follow(c.run.facts, from, jump);
  const s: Settled = j.to === LIMIT
    ? { at: from, events: [], end: { status: 'escalated', reason: 'loop_limit' } }
    : settle(j.to);
  return commit(c, s, [...j.events, ...s.events], result);
}

const end = (c: Ctx, status: 'escalated' | 'cancelled', reason: string) =>
  commit(c, { at: c.run.current_node_id, events: [], end: { status, reason } }, []);

// Guard shared by every move: an agent run that is active and not waiting on the team.
async function active(runId: string): Promise<Ctx | ToolErr> {
  const c = await load(runId);
  if (TERMINAL.includes(c.run.status)) return reject(`The run has ended (${c.run.status})`, 'Start a new run.');
  if (c.run.status === 'waiting_approval') return reject('The run is waiting for team approval', 'Tell the customer the team is checking; do nothing else.');
  return c;
}

const notCurrent = (c: Ctx, id: string) => {
  const card = stepCard(c.flow, c.run.current_node_id, shown(c));
  return reject(`${id} is not the current step`, card ? `Handle the current step ${card.id} (${card.type}): ${card.text}` : 'There is no current step.');
};

// ── Tools ──

// Every rejected move is logged, so evals can count invalid-move attempts.
function logged<A>(tool: string, fn: (runId: string, a: A) => Promise<ToolResult>) {
  return async (runId: string, a: A): Promise<ToolResult> => {
    const r = await fn(runId, a);
    if (!r.ok) await addEvent(runId, null, 'ai', 'move_rejected', { tool, reason: r.reason, args: a });
    return r;
  };
}

export const wfSaveInput = logged('wf_save_input', (runId: string, a: { input_id: string; value: string }) => serial(runId, async (): Promise<ToolResult> => {
  const c = await active(runId);
  if ('ok' in c) return c;
  const node = c.flow.node(a.input_id);
  if (node?.type !== 'ask') return reject(`${a.input_id} is not an input`, 'Use the input id from the step card.');
  const cur = c.run.current_node_id!;
  if (a.input_id !== cur && !reachableInput(c.flow, cur, a.input_id)) return reject(`${a.input_id} can't be answered yet`, 'Finish the current step first.');
  const v = checkAnswer(node.format, String(a.value ?? ''));
  if (!v.ok) {
    await addEvent(runId, node.id, 'ai', 'input_invalid', { [node.saveAs]: a.value, format: node.format });
    if (countAsk(c.run.facts, node.id)) return end(c, 'escalated', 'no valid answer after 3 tries');
    await saveRun(runId, c.run);
    return reject(`"${a.value}" is not a valid ${node.format}`, `Ask again: ${askText(node, true, shown(c))}`);
  }
  saveAnswer(c.run.facts, node, v.value);
  await addEvent(runId, node.id, 'ai', 'input_received', { [node.saveAs]: v.value, format: node.format });
  if (a.input_id !== cur) { await saveRun(runId, c.run); return ok(c); } // saved ahead; the engine skips that input later
  return advance(c, cur, c.flow.next(cur));
}));

export const wfChooseCase = logged('wf_choose_case', (runId: string, a: { condition_id: string; case_id: string; reason: string }) => serial(runId, async (): Promise<ToolResult> => {
  const c = await active(runId);
  if ('ok' in c) return c;
  const node = c.flow.node(a.condition_id);
  if (a.condition_id !== c.run.current_node_id || node?.type !== 'branch') return notCurrent(c, a.condition_id);
  if (!node.cases.some((x) => x.id === a.case_id)) return reject(`${a.case_id} is not a case of this condition`, `Pick one of: ${node.cases.map((x) => x.id).join(', ')}`);
  // Rules conditions: the agent picks, the server checks the pick against the rules.
  if (node.mode === 'rules') {
    const want = chooseByRules(node, ruleValues(c.run.facts, varsOf(c)));
    if (want.case_id !== a.case_id) return reject(`The rules pick ${want.case_id ?? 'no case'} (${want.reason})`, want.case_id ? `Choose ${want.case_id}.` : 'Check the collected values.');
  }
  recordCase(c.run.facts, node.id, a.case_id, a.reason ?? '');
  await addEvent(runId, node.id, 'ai', 'case_chosen', { case_id: a.case_id, reason: a.reason });
  return advance(c, node.id, c.flow.afterCase(node.id, a.case_id));
}));

export const wfCompleteStep = logged('wf_complete_step', (runId: string, a: { step_id: string; summary: string }) => serial(runId, async (): Promise<ToolResult> => {
  const c = await active(runId);
  if ('ok' in c) return c;
  const node = c.flow.node(a.step_id);
  if (a.step_id !== c.run.current_node_id || !node) return notCurrent(c, a.step_id);
  if (node.type === 'branch') return reject('A condition is completed by choosing a case', 'Use wf_choose_case.');
  if (node.type === 'say') { // text bubble: queued word for word; the reply must contain it
    const text = bubbleText(node, shown(c));
    if (text) c.run.outbox.push({ text, verbatim: true, nodeId: node.id });
    await addEvent(runId, node.id, 'ai', 'step_completed', { summary: a.summary || 'bubble sent' });
    return advance(c, node.id, c.flow.next(node.id));
  }
  if (node.type === 'ask') {
    if (!(node.id in c.run.facts.outputs)) return reject(`${node.saveAs} is not saved yet`, 'Save the answer with wf_save_input, or ask the customer for it.');
    await addEvent(runId, node.id, 'ai', 'step_completed', { summary: a.summary || 'already answered' });
    return advance(c, node.id, c.flow.next(node.id));
  }
  const error = completeError(node, c.run.facts);
  if (error) {
    return reject(error, `Call ${stepActions(node.content).join(' or ')} first.`);
  }
  await addEvent(runId, node.id, 'ai', 'step_completed', { summary: a.summary });
  return advance(c, node.id, c.flow.next(node.id));
}));

export const wfCallAction = logged('call_action', (runId: string, a: { action_key: string; args?: Record<string, unknown> }) => serial(runId, async (): Promise<ToolResult> => {
  const c = await active(runId);
  if ('ok' in c) return c;
  const nodeId = c.run.current_node_id!;
  const node = c.flow.node(nodeId);
  if (node?.type !== 'step') return reject('The current step is not an AI step', 'Only AI steps call actions.');
  const action = stepActions(node.content).includes(a.action_key) ? await getAction(a.action_key) : null;
  const plan = planCall(node, a.action_key, action, a.args);
  if (!plan.ok) {
    return reject(plan.error, action ? `Call ${a.action_key} with ${argSpec(action)}` : `This step allows: ${stepActions(node.content).join(', ') || 'no actions'}`);
  }
  const done = ranOutput(c.run.facts, nodeId);
  if (done) return ok(c, { already_ran: true, output: done }); // idempotent: never runs twice in one visit
  await addEvent(runId, nodeId, 'ai', 'action_called', { key: a.action_key, args: plan.args });
  if (plan.kind === 'escalate') return end(c, 'escalated', String(plan.args.reason ?? 'escalate_to_human'));
  if (plan.kind === 'evidence' || plan.kind === 'approval') {
    const taskId = await openTask(c.run, nodeId, plan.kind === 'evidence'
      ? { kind: 'evidence', summary: String(plan.args.summary ?? ''), evidence: { facts: c.run.facts.outputs } }
      : { kind: 'action', ...approvalTask(action!), action_key: a.action_key, action_args: plan.args, evidence: { facts: c.run.facts.outputs } });
    const task = await one<{ due_at: Date }>('select due_at from approval_task where id = $1', [taskId]);
    c.run.facts.outputs[nodeId] = { approval_task_id: taskId };
    c.run.status = 'waiting_approval';
    c.run.waiting_for = { type: 'approval', node_id: nodeId, task_id: taskId, due_at: new Date(task!.due_at).getTime() };
    await saveRun(runId, c.run);
    await addEvent(runId, nodeId, 'system', 'waiting', { for: 'approval', task_id: taskId });
    return ok(c, { waiting: 'team approval', task_id: taskId });
  }
  const res = await executeAction(action!, plan.args, { runId, nodeId, mode: 'auto', visit: visitOf(c.run.facts) });
  await addEvent(runId, nodeId, 'system', 'action_result', res);
  if (!res.ok) return reject(`${a.action_key} failed: ${res.error}`, 'Check the arguments and try once more, or hand off.');
  c.run.facts.outputs[nodeId] = res.result; // the step's action has run: completes it, and a repeat returns this
  await keep(c, node, res.result);
  await saveRun(runId, c.run);
  return ok(c, res.result);
}));

export const wfHandoff = logged('wf_handoff', (runId: string, a: { reason: string }) => serial(runId, async (): Promise<ToolResult> => {
  const c = await load(runId);
  if (TERMINAL.includes(c.run.status)) return reject('No active run', 'Nothing to hand off.');
  await addEvent(runId, c.run.current_node_id, 'ai', 'handoff', { reason: a.reason });
  return end(c, 'escalated', a.reason || 'handoff');
}));

export const SWITCH_CONFIDENCE = 0.8;

export const wfSwitchWorkflow = logged('wf_switch_workflow', (runId: string, a: { workflow_id: string; confidence: number; reason: string }) => serial(runId, async (): Promise<ToolResult> => {
  const c = await load(runId);
  if (TERMINAL.includes(c.run.status)) return reject('No active run', 'Start a workflow instead.');
  if (!(a.confidence >= SWITCH_CONFIDENCE)) return reject(`Confidence ${a.confidence} is below ${SWITCH_CONFIDENCE}`, 'Stay in the current workflow, or ask the customer what they want.');
  const to = await one<{ name: string }>(`select name from workflow
    where id = $1 and enabled and archived_at is null and published_graph is not null`, [a.workflow_id]);
  if (!to) return reject(`${a.workflow_id} is not a published workflow`, 'Pick a workflow from the published list.');
  if (a.workflow_id === c.run.workflow_id) return reject('That is the current workflow', 'Continue the current step.');
  await addEvent(runId, c.run.current_node_id, 'ai', 'workflow_switched', { to: to.name, confidence: a.confidence, reason: a.reason });
  await end(c, 'cancelled', `switched to ${to.name}`);
  return startAgentRun(c.run.conversation_id, a.workflow_id, `switched from another workflow: ${a.reason}`);
}));

// "order_id: string (required), amount: integer": what an action's args look like, for the agent.
export const argSpec = (a: { input_schema: { properties: Record<string, { type: string }>; required?: string[] } }) =>
  Object.entries(a.input_schema.properties).map(([k, v]) => `${k}: ${v.type}${a.input_schema.required?.includes(k) ? ' (required)' : ''}`).join(', ') || 'no args';

// ── Runs and approvals ──

export const START_CONFIDENCE = 0.7;

// Supervisor: start a workflow on a conversation that has no active run.
export async function wfStart(conversationId: string, a: { workflow_id: string; confidence: number; reason: string }): Promise<ToolResult> {
  if (!(a.confidence >= START_CONFIDENCE)) return reject(`Confidence ${a.confidence} is below ${START_CONFIDENCE}`, 'Ask the customer one short question to be sure.');
  const busy = await one(`select 1 from workflow_run where conversation_id = $1 and status = any($2)`, [conversationId, ['running', 'waiting_customer', 'waiting_approval', 'paused', 'failed']]);
  if (busy) return reject('A workflow is already running', 'Delegate to it, or switch workflow.');
  const ok = await one(`select 1 from workflow where id = $1 and enabled and archived_at is null and published_graph is not null`, [a.workflow_id]);
  if (!ok) return reject(`${a.workflow_id} is not a published workflow`, 'Pick a workflow from the published list.');
  return startAgentRun(conversationId, a.workflow_id, `${a.reason} (confidence ${a.confidence})`);
}

// Creates an agent run at the first block of the workflow's published graph; the run keeps its own copy of that graph.
export async function startAgentRun(conversationId: string, workflowId: string, reason: string): Promise<ToolResult> {
  const v = await one<{ graph: WorkflowGraph; name: string }>('select published_graph as graph, name from workflow where id = $1 and published_graph is not null', [workflowId]);
  if (!v) return reject('This workflow is not published', 'Pick a published workflow.');
  const conv = await one<{ customer_name: string; customer_email: string }>('select customer_name, customer_email from conversation where id = $1', [conversationId]);
  const facts = { collected: { customer_name: conv!.customer_name, email: conv!.customer_email }, outputs: {}, cases: {}, attempts: {}, visits: {} };
  const row = await one<{ id: string }>(`insert into workflow_run (conversation_id, workflow_id, workflow_name, graph, current_node_id, facts)
                                         values ($1, $2, $3, $4, $5, $6) returning id`,
    [conversationId, workflowId, v.name, JSON.stringify(v.graph), flowOf(v).first(), JSON.stringify(facts)]);
  await addEvent(row!.id, null, 'system', 'run_started', { workflow: v.name, reason });
  return serial(row!.id, async () => {
    const c = await load(row!.id);
    const s = settle(c.run.current_node_id);
    return commit(c, s, s.events);
  });
}

// The team decided an approval on an agent run: run the approved action, then move on.
// Any rejection (action or evidence review) escalates the run to a person; the workflow never continues past it.
export const decideAgentApproval = (runId: string, taskId: string, approved: boolean, by: string, note?: string) => serial(runId, async (): Promise<ToolResult> => {
  const c = await load(runId);
  const w = c.run.waiting_for;
  if (c.run.status !== 'waiting_approval' || w?.type !== 'approval' || w.task_id !== taskId) return reject('The run is not waiting for this approval', 'Nothing to do.');
  const task = await one('select * from approval_task where id = $1', [taskId]);
  const node = c.flow.node(w.node_id) as StepNode;
  await addEvent(runId, node.id, `user:${by}`, 'approval_decided', { task_id: taskId, approved });
  c.run.facts.outputs[node.id] = { approved, reviewed_by: by, reviewer_note: note ?? '' };
  if (!approved) return end(c, 'escalated', `approval rejected by ${by}${note ? `: ${note}` : ''}`);
  if (task.kind === 'action') return runApproved(c, node, task);
  await keep(c, node, c.run.facts.outputs[node.id]); // a review's decision can be saved to variables too
  c.run.status = 'running';
  return advance(c, node.id, c.flow.next(node.id), { approved });
});

// Runs an approved action (same idempotency key, so a retry after a failure never runs it twice), then moves on.
// A failure leaves the run "failed" at that step for a teammate to retry.
async function runApproved(c: Ctx, node: StepNode, task: { id: string; action_key: string; action_args: Record<string, unknown> }): Promise<ToolResult> {
  const res = await executeAction((await getAction(task.action_key))!, task.action_args, { runId: c.run.id, nodeId: node.id, mode: 'approved', taskId: task.id, visit: visitOf(c.run.facts) });
  await addEvent(c.run.id, node.id, 'system', 'action_result', res);
  if (!res.ok) {
    c.run.status = 'failed'; c.run.waiting_for = null;
    await saveRun(c.run.id, c.run);
    await addEvent(c.run.id, node.id, 'system', 'run_failed', { error: res.error });
    return reject(`${task.action_key} failed: ${res.error}`, 'A teammate needs to look at this.');
  }
  c.run.facts.outputs[node.id] = res.result;
  await keep(c, node, res.result);
  c.run.status = 'running';
  return advance(c, node.id, c.flow.next(node.id), { approved: true });
}

// Run panel controls on an agent run. `turn`: the workflow agent should speak next (after a resume or a retry).
export const controlAgentRun = (runId: string, op: 'pause' | 'resume' | 'cancel' | 'retry', by: string) => serial(runId, async (): Promise<ToolResult & { turn?: boolean }> => {
  const c = await load(runId);
  const r = c.run;
  if (TERMINAL.includes(r.status)) return reject(`The run has ended (${r.status})`, 'Nothing to do.');
  await addEvent(runId, r.current_node_id, `user:${by}`, 'signal', { type: op === 'retry' ? 'retry_step' : op, by });
  if (op === 'cancel') return end(c, 'cancelled', `cancelled by ${by}`);
  if (op === 'pause') {
    if (r.status === 'paused') return reject('Already paused', 'Resume it instead.');
    r.paused_from = { status: r.status, waiting_for: r.waiting_for };
    r.status = 'paused'; r.waiting_for = null;
    await saveRun(runId, r);
    return ok(c);
  }
  if (op === 'resume') {
    if (r.status !== 'paused') return reject('The run is not paused', 'Nothing to resume.');
    const from = r.paused_from ?? { status: 'running' as const, waiting_for: null };
    r.status = from.status; r.waiting_for = from.waiting_for; r.paused_from = null;
    await saveRun(runId, r);
    return { ...(await ok(c)), turn: false };
  }
  if (r.status !== 'failed') return reject('Only a failed run can be retried', 'Nothing to retry.');
  const node = c.flow.node(r.current_node_id!) as StepNode;
  const taskId = (r.facts.outputs[node.id] as { approval_task_id?: string } | undefined)?.approval_task_id;
  const task = taskId ? await one(`select * from approval_task where id = $1 and status = 'approved' and kind = 'action'`, [taskId]) : null;
  r.facts.attempts['!' + node.id] = 0;
  if (task) {
    const res = await runApproved(c, node, task);
    return res.ok ? { ...res, turn: true } : res;
  }
  r.status = 'running'; r.waiting_for = null; // nothing approved to re-run: the agent tries the step again
  await saveRun(runId, r);
  return { ...(await ok(c)), turn: true };
});

async function keep(c: Ctx, step: StepNode, output: unknown) {
  if (!step.save?.length) return;
  const { saved, missing } = saveResponse(c.run.facts, step.id, step.save, output);
  await addEvent(c.run.id, step.id, 'system', 'response_saved', { saved, missing });
}

export async function agentRunState(runId: string) {
  const c = await load(runId);
  const events = await q('select node_id, actor, type, data, at from run_event where run_id = $1 order by id', [runId]);
  return { ...(await ok(c)), facts: c.run.facts, events };
}
