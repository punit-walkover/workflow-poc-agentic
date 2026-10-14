// The step engine: pure workflow rules behind the agent tools. No DB or AI in here.
// Functions that take `facts` update that object in place; callers load it and save it.
import { ActionRow, BranchNode, Facts, GraphEdge, Inline, InputFormat, Rule, SaveField, StepNode, WorkflowGraph } from '../types';
import { renderInline, stepActions } from '../workflows/inline';

// ── Flow: a canvas graph as blocks and the moves between them ──

// A text bubble says its text; an input asks and saves the reply.
export interface SayNode { id: string; type: 'say'; content: Inline[] }
export interface AskNode { id: string; type: 'ask'; prompt: Inline[]; saveAs: string; format: InputFormat; retry?: string }
export type FlowNode = StepNode | BranchNode | SayNode | AskNode;
export interface Jump { to: string | null; edge?: GraphEdge }
export interface Flow {
  first(): string | null;
  node(id: string): FlowNode | undefined;
  next(id: string): Jump;                           // after a step (or a condition with no case taken)
  afterCase(id: string, caseId: string | null): Jump;
}

export function graphFlow(g: WorkflowGraph): Flow {
  const at = new Map<string, { groupId: string; idx: number }>();
  g.groups.forEach((grp) => grp.items.forEach((it, idx) => at.set(it.id, { groupId: grp.id, idx })));
  const groups = new Map(g.groups.map((grp) => [grp.id, grp]));
  const target = (e: GraphEdge): Jump => ({ to: e.to.itemId ?? groups.get(e.to.groupId)?.items[0]?.id ?? null, edge: e });
  const next = (id: string): Jump => {
    const { groupId, idx } = at.get(id)!;
    const following = groups.get(groupId)!.items[idx + 1];
    if (following) return { to: following.id };
    const out = g.edges.find((e) => e.from.groupId === groupId && !e.from.itemId);
    return out ? target(out) : { to: null };
  };
  return {
    first: () => groups.get(g.start)?.items[0]?.id ?? null,
    node: (id) => {
      const p = at.get(id);
      const it = p && groups.get(p.groupId)!.items[p.idx];
      if (!it) return undefined;
      switch (it.type) {
        case 'step': return { id, type: 'step', content: it.content, save: it.save };
        case 'bubble': return { id, type: 'say', content: it.content };
        case 'input': return { id, type: 'ask', prompt: it.prompt, saveAs: it.saveAs, format: it.format, retry: it.retry };
        // A condition item runs exactly like a branch whose cases lead out through edges.
        case 'condition': return { id, type: 'branch', mode: it.mode, cases: it.cases };
      }
    },
    next,
    afterCase: (id, caseId) => {
      const e = g.edges.find((x) => x.from.itemId === id && x.from.port === caseId);
      return e ? target(e) : next(id); // an unconnected case falls through to what follows the condition
    },
  };
}

export function flowOf(v: { graph: WorkflowGraph | null }): Flow {
  if (!v.graph) throw new Error('This workflow has no canvas graph');
  return graphFlow(v.graph);
}

// ── Values ──

// What {{name}} shows: built-in values plus the workflow's own variables that have a value (older runs used facts.collected).
export function varsFor(base: Record<string, string>, declared: string[], facts: Facts): Record<string, string> {
  const vars = { ...base };
  for (const k of declared) {
    const v = facts.vars?.[k] ?? facts.collected[k];
    if (v !== undefined) vars[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return vars;
}

// Words the customer reads: a declared variable with no value yet shows as nothing, not as {{name}}.
export const shownVars = (declared: string[], vars: Record<string, string>) => ({ ...Object.fromEntries(declared.map((k) => [k, ''])), ...vars });

// Values rule conditions compare against.
export const ruleValues = (facts: Facts, vars: Record<string, string>) => ({ ...facts.collected, ...vars, ...facts.vars });

// ── Input blocks ──

export const MAX_ASKS = 3;

// Checks a customer's reply to an input block. Returns the value to save, or why it doesn't fit.
export function checkAnswer(format: InputFormat, raw: string): { ok: true; value: string | number } | { ok: false } {
  const text = raw.trim();
  if (!text) return { ok: false };
  switch (format) {
    case 'email': {
      const m = text.match(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i);
      return m ? { ok: true, value: m[0].toLowerCase() } : { ok: false };
    }
    case 'number': {
      const m = text.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
      return m ? { ok: true, value: Number(m[0]) } : { ok: false };
    }
    case 'phone': {
      const digits = text.replace(/[^\d+]/g, '');
      return /^\+?\d{7,15}$/.test(digits) ? { ok: true, value: digits } : { ok: false };
    }
    default: return { ok: true, value: text };
  }
}

export const RETRY: Record<InputFormat, string> = {
  text: "Sorry, I didn't get that. Could you answer the question above?",
  email: "That doesn't look like an email address. Could you check it?",
  number: 'Could you send that as a number?',
  phone: "That doesn't look like a phone number. Could you check it?",
};

// Saves an input's answer into its variable.
export function saveAnswer(facts: Facts, node: AskNode, value: string | number) {
  (facts.vars ??= {})[node.saveAs] = value;
  (facts.varsBy ??= {})[node.id] = [node.saveAs];
  facts.outputs[node.id] = { [node.saveAs]: value };
  delete facts.asked?.[node.id]; // answer used: a later visit asks again
}

// Counts one more ask for a node; true once it has asked more than MAX_ASKS times.
export function countAsk(facts: Facts, nodeId: string): boolean {
  facts.attempts[nodeId] = (facts.attempts[nodeId] ?? 0) + 1;
  return facts.attempts[nodeId] > MAX_ASKS;
}

// What an input says: its prompt, or after a bad answer its retry text. Empty is fine (a bubble before it may ask).
export const askText = (node: AskNode, invalid: boolean, shown: Record<string, string>) =>
  invalid ? node.retry?.trim() || RETRY[node.format] : renderInline(node.prompt, shown);

export const bubbleText = (node: SayNode, shown: Record<string, string>) => renderInline(node.content, shown);

// ── Conditions ──

// One rule against the run's values. Text compares ignore case; > and < compare numbers.
function test(r: Rule, values: Record<string, unknown>): boolean {
  const v = values[r.var];
  const left = v === undefined || v === null ? '' : String(v).trim();
  const other = r.ref ? values[r.ref] : r.value;
  const right = other === undefined || other === null ? '' : String(other).trim();
  switch (r.op) {
    case 'empty': return left === '';
    case 'not_empty': return left !== '';
    case '=': return left.toLowerCase() === right.toLowerCase();
    case '!=': return left.toLowerCase() !== right.toLowerCase();
    case 'contains': return left.toLowerCase().includes(right.toLowerCase());
    case '>': return left !== '' && Number(left) > Number(right);
    case '<': return left !== '' && Number(left) < Number(right);
  }
}

// A rules-mode condition: the first case whose rules match wins; Else catches the rest.
export function chooseByRules(b: BranchNode, values: Record<string, unknown>): { case_id: string | null; reason: string } {
  for (const c of b.cases) {
    if (c.kind === 'else') return { case_id: c.id, reason: 'no rule matched' };
    const rules = c.rules ?? [];
    const hit = rules.length > 0 && (c.join === 'or' ? rules.some((r) => test(r, values)) : rules.every((r) => test(r, values)));
    if (hit) return { case_id: c.id, reason: rules.map((r) => `${r.var} ${r.op} ${r.ref ? `{{${r.ref}}}` : r.value}`.trim()).join(c.join === 'or' ? ' or ' : ' and ') };
  }
  return { case_id: null, reason: 'no rule matched' };
}

export function recordCase(facts: Facts, nodeId: string, caseId: string | null, reason: string) {
  facts.cases[nodeId] = { case_id: caseId, reason };
}

// ── Steps and actions ──

// Reads a field from an action response: "delivered_at", "items[0].name", "items.0.name", "items.length"; "$" is the whole response.
export function getPath(obj: unknown, path: string): unknown {
  if (path.trim() === '$') return obj;
  const keys = path.trim().replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: any = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined) return undefined;
    cur = k === 'length' && (Array.isArray(cur) || typeof cur === 'string') ? cur.length : cur[k];
  }
  return cur;
}

// "Save response": copies the mapped fields into workflow variables. Returns what was saved and which paths were missing.
export function saveResponse(facts: Facts, nodeId: string, save: SaveField[] | undefined, output: unknown) {
  const saved: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const m of save ?? []) {
    if (!m.path || !m.var) continue;
    const v = getPath(output, m.path);
    if (v === undefined) { missing.push(m.path); continue; }
    saved[m.var] = v;
  }
  if (Object.keys(saved).length) {
    Object.assign((facts.vars ??= {}), saved);
    (facts.varsBy ??= {})[nodeId] = Object.keys(saved);
  }
  return { saved, missing };
}

// Required fields present and of the right type; numeric strings are coerced for integer fields.
export function validateArgs(action: ActionRow, raw: Record<string, unknown> | undefined) {
  const args: Record<string, unknown> = { ...(raw ?? {}) };
  for (const [name, spec] of Object.entries(action.input_schema.properties)) {
    const v = args[name];
    if (v === undefined || v === null || v === '') { delete args[name]; continue; }
    if (spec.type === 'integer') {
      const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
      if (!Number.isInteger(n)) return { ok: false as const, error: `${name} must be an integer` };
      args[name] = n;
    } else if (spec.type === 'string') args[name] = String(v);
  }
  const missing = (action.input_schema.required ?? []).filter((r) => args[r] === undefined);
  if (missing.length) return { ok: false as const, error: `missing ${missing.join(', ')}` };
  return { ok: true as const, args };
}

// What an action call at a step turns into: rejected, or run / escalate / evidence review / approval first.
export type CallPlan =
  | { ok: false; error: string }
  | { ok: true; args: Record<string, unknown>; kind: 'escalate' | 'evidence' | 'approval' | 'run' };

export function planCall(step: StepNode, key: string, action: ActionRow | null, rawArgs: Record<string, unknown> | undefined): CallPlan {
  if (!stepActions(step.content).includes(key)) return { ok: false, error: `${key || 'action'} is not allowed in this step` };
  if (!action?.enabled) return { ok: false, error: `${key} is disabled` };
  const v = validateArgs(action, rawArgs);
  if (!v.ok) return v;
  if (key === 'escalate_to_human') return { ok: true, args: v.args, kind: 'escalate' };
  if (key === 'request_approval') return { ok: true, args: v.args, kind: 'evidence' };
  return { ok: true, args: v.args, kind: action.requires_approval ? 'approval' : 'run' };
}

// The step's action already ran (not just requested approval): return its output so it never runs twice.
export function ranOutput(facts: Facts, nodeId: string) {
  const done = facts.outputs[nodeId] as Record<string, unknown> | undefined;
  return done && !('approval_task_id' in done) ? done : undefined;
}

// A step that mentions an action only completes once that action has run.
export function completeError(step: StepNode, facts: Facts): string | null {
  return stepActions(step.content).length && !(step.id in facts.outputs) ? 'step completed without calling its action' : null;
}

// Approval task for an action that needs one: what the team reads (the arguments are on the task too).
export const approvalTask = (action: ActionRow) => ({ summary: action.name });

// ── Loops ──

export interface EngineEvent { nodeId: string | null; type: string; data: object }
export const LIMIT = Symbol('loop limit');

// Each Go to step jump starts a new visit, so a re-run action gets a fresh idempotency key.
export const visitOf = (f: Facts) => 1 + Object.values(f.visits ?? {}).reduce((a, b) => a + b - 1, 0);

// Repeat bookkeeping for a jump back: count the visit and clear what re-runs (results kept as "previous").
// Returns the visit number, or false once a limited jump has been taken too often.
export function rerun(facts: Facts, key: string, max: number | undefined, fresh: boolean | undefined, ids: string[], at = new Date().toISOString()): number | false {
  facts.visits ??= {};
  const visit = (facts.visits[key] ?? 1) + 1;
  if (max && visit > max) return false;
  facts.visits[key] = visit; // also feeds visitOf, so a re-run tool call gets a fresh idempotency key
  facts.since ??= {};
  facts.previous ??= {};
  for (const id of ids) {
    if (id in facts.outputs) facts.previous[id] = facts.outputs[id];
    delete facts.outputs[id]; delete facts.cases[id]; delete facts.attempts[id]; delete facts.attempts['!' + id];
    delete facts.asked?.[id];
    facts.since[id] = { at, fresh: !!fresh };
    // "Ask again": the customer's earlier answers to these steps no longer count.
    if (fresh) for (const k of facts.collectedBy?.[id] ?? []) delete facts.collected[k];
    if (fresh) for (const k of facts.varsBy?.[id] ?? []) delete facts.vars?.[k];
  }
  return visit;
}

// Leave `from` along `jump`. Canvas runs keep a trail of finished items: an arrow back to one already on it is a loop.
export function follow(facts: Facts, from: string, jump: Jump): { to: string | null | typeof LIMIT; events: EngineEvent[] } {
  facts.attempts[from] = 0;
  facts.attempts['!' + from] = 0;
  const trail = [...(facts.trail ?? []), from];
  facts.trail = trail;
  if (!jump.to || !jump.edge) return { to: jump.to, events: [] };
  const back = trail.lastIndexOf(jump.to);
  if (back < 0) return { to: jump.to, events: [] };
  const e = jump.edge;
  const visit = rerun(facts, e.id, e.maxVisits, e.fresh, trail.slice(back));
  if (visit === false) return { to: LIMIT, events: [{ nodeId: from, type: 'goto_limit', data: { target: jump.to, max_visits: e.maxVisits } }] };
  facts.trail = trail.slice(0, back);
  return { to: jump.to, events: [{ nodeId: from, type: 'goto_jumped', data: { target: jump.to, visit, max_visits: e.maxVisits ?? null, direction: 'back' } }] };
}

// ── Agent runs ──

// Where a run stands after a move: the next block for the agent, or the end of the run.
export interface Settled {
  at: string | null;
  events: EngineEvent[];
  end?: { status: 'completed' | 'escalated' | 'cancelled'; reason: string };
}

// Full agentic: nothing runs on its own. The run waits at `at` for the agent, or ends when no block is left.
export const settle = (at: string | null): Settled =>
  at ? { at, events: [] } : { at, events: [], end: { status: 'completed', reason: 'completed' } };

const MAX_WALK = 200;

// True when `target` comes after `from` with no condition, jump or AI step in between (a value given early can be kept).
export function reachableInput(flow: Flow, from: string, target: string): boolean {
  let at: string | null = from;
  for (let i = 0; at && i < MAX_WALK; i++) {
    if (at === target) return true;
    const node = flow.node(at);
    if (!node || (node.type !== 'say' && node.type !== 'ask')) return false;
    at = flow.next(at).to;
  }
  return false;
}

// ── Step card: what the agent sees for the node it must handle now ──

export interface StepCard {
  id: string;
  type: 'ai_step' | 'input' | 'ai_condition' | 'rules_condition' | 'bubble';
  text: string;                                        // instruction, question, condition prompt or bubble text
  collects?: { name: string; format: InputFormat };
  answered?: unknown;                                  // input already saved (given earlier): just complete it
  cases?: { id: string; kind: string; when: string }[];
  tools: string[];                                     // actions this step may call
}

export function stepCard(flow: Flow, nodeId: string | null, shown: Record<string, string>, facts?: Facts): StepCard | null {
  const node = nodeId ? flow.node(nodeId) : undefined;
  if (!node) return null;
  const answered = facts?.outputs[node.id] as Record<string, unknown> | undefined;
  if (node.type === 'step') return { id: node.id, type: 'ai_step', text: renderInline(node.content, shown), tools: stepActions(node.content) };
  if (node.type === 'ask') return { id: node.id, type: 'input', text: renderInline(node.prompt, shown), collects: { name: node.saveAs, format: node.format }, tools: [],
                                      ...(answered ? { answered: answered[node.saveAs] } : {}) };
  if (node.type === 'say') return { id: node.id, type: 'bubble', text: bubbleText(node, shown), tools: [] };
  if (node.type === 'branch' && node.mode === 'rules') return {
    id: node.id, type: 'rules_condition', text: 'Check the rules against the collected values; the first case that matches wins.', tools: [],
    cases: node.cases.map((c) => ({ id: c.id, kind: c.kind, when: c.kind === 'else' ? 'none of the others'
      : (c.rules ?? []).map((r) => `${r.var} ${r.op}${r.op === 'empty' || r.op === 'not_empty' ? '' : ` ${r.ref ? `{{${r.ref}}}` : JSON.stringify(r.value)}`}`).join(c.join === 'or' ? ' or ' : ' and ') })),
  };
  if (node.type === 'branch') return {
    id: node.id, type: 'ai_condition', text: 'Pick the case that fits the conversation.', tools: [],
    cases: node.cases.map((c) => ({ id: c.id, kind: c.kind, when: c.kind === 'else' ? 'none of the others' : renderInline(c.condition, shown) })),
  };
  return null;
}
