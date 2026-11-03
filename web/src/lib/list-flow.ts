// Builder 2: a workflow written as a numbered list of steps (with If / Else and "Go to step"), compiled into the
// same canvas graph the server validates and runs. The list itself is stashed in the graph (`builder2`) so the
// editor can show it again; the canvas ignores that key.
import { CaseKind, EdgeFrom, GraphEdge, GraphGroup, GraphItem, tidy, WorkflowGraph } from './graph';
import { Inline, rid } from './inline';

export interface ListCase { id: string; kind: CaseKind; condition: Inline[]; steps: ListStep[] }
export type ListStep =
  | { id: string; type: 'step'; content: Inline[] }
  | { id: string; type: 'condition'; cases: ListCase[] }
  | { id: string; type: 'goto'; target: string; maxVisits: number }; // target: a plain step's id
export interface ListFlow { steps: ListStep[] }
export type ListGraph = WorkflowGraph & { builder2?: ListFlow };

export const MAX_LIST_STEPS = 15;
export const DEFAULT_GOTO_VISITS = 3;

export const newListStep = (): ListStep => ({ id: rid(), type: 'step', content: [] });
export const newListCondition = (): ListStep => ({ id: rid(), type: 'condition', cases: [
  { id: rid(), kind: 'if', condition: [], steps: [] }, { id: rid(), kind: 'else', condition: [], steps: [] }] });
export const newListGoto = (): ListStep => ({ id: rid(), type: 'goto', target: '', maxVisits: DEFAULT_GOTO_VISITS });
export const emptyFlow = (): ListFlow => ({ steps: [newListStep()] });

// Plain steps count toward the limit (conditions and jumps don't), same as the server's rule for graph items.
export const listStepCount = (steps: ListStep[]): number =>
  steps.reduce((n, s) => n + (s.type === 'step' ? 1 : s.type === 'condition' ? s.cases.reduce((m, c) => m + listStepCount(c.steps), 0) : 0), 0);

// Every step with its label ("3", "2a.1" = inside case a of step 2) and depth, in reading order.
export interface Labelled { step: ListStep; label: string; depth: number }
export function labelSteps(steps: ListStep[], prefix = '', depth = 0, out: Labelled[] = []): Labelled[] {
  steps.forEach((s, i) => {
    const label = `${prefix}${i + 1}`;
    out.push({ step: s, label, depth });
    if (s.type === 'condition') s.cases.forEach((c, ci) => labelSteps(c.steps, `${label}${String.fromCharCode(97 + ci)}.`, depth + 1, out));
  });
  return out;
}
export const labelOf = (steps: ListStep[], id: string) => labelSteps(steps).find((l) => l.step.id === id)?.label;
// Plain steps a "Go to step" may point at.
export const gotoTargets = (steps: ListStep[]) => labelSteps(steps).filter((l) => l.step.type === 'step');

// Immutable edits, applied anywhere in the tree.
const mapSteps = (steps: ListStep[], fn: (s: ListStep[]) => ListStep[]): ListStep[] =>
  fn(steps).map((s) => (s.type === 'condition' ? { ...s, cases: s.cases.map((c) => ({ ...c, steps: mapSteps(c.steps, fn) })) } : s));
export const replaceStep = (steps: ListStep[], id: string, next: ListStep) => mapSteps(steps, (l) => l.map((s) => (s.id === id ? next : s)));
export const updateStep = (steps: ListStep[], id: string, patch: (s: ListStep) => ListStep) => mapSteps(steps, (l) => l.map((s) => (s.id === id ? patch(s) : s)));
export const removeStep = (steps: ListStep[], id: string) => mapSteps(steps, (l) => l.filter((s) => s.id !== id));
export const insertAfter = (steps: ListStep[], id: string, next: ListStep) =>
  mapSteps(steps, (l) => l.flatMap((s) => (s.id === id ? [s, next] : [s])));
// Append to the top level, or to one case of a condition.
export const appendStep = (steps: ListStep[], next: ListStep, caseId?: string): ListStep[] =>
  caseId ? mapSteps(steps, (l) => l.map((s) => (s.type === 'condition' && s.cases.some((c) => c.id === caseId)
    ? { ...s, cases: s.cases.map((c) => (c.id === caseId ? { ...c, steps: [...c.steps, next] } : c)) } : s))) : [...steps, next];
export const setCaseCondition = (steps: ListStep[], caseId: string, condition: Inline[]) =>
  mapSteps(steps, (l) => l.map((s) => (s.type === 'condition' ? { ...s, cases: s.cases.map((c) => (c.id === caseId ? { ...c, condition } : c)) } : s)));
export const addListCase = (steps: ListStep[], stepId: string, kind: 'else_if' | 'else') => updateStep(steps, stepId, (s) => {
  if (s.type !== 'condition') return s;
  const c: ListCase = { id: rid(), kind, condition: [], steps: [] };
  const e = s.cases.findIndex((x) => x.kind === 'else');
  if (kind === 'else') return e >= 0 ? s : { ...s, cases: [...s.cases, c] };
  return e >= 0 ? { ...s, cases: [...s.cases.slice(0, e), c, ...s.cases.slice(e)] } : { ...s, cases: [...s.cases, c] };
});
export const removeListCase = (steps: ListStep[], stepId: string, caseId: string) =>
  updateStep(steps, stepId, (s) => (s.type === 'condition' ? { ...s, cases: s.cases.filter((c) => c.id !== caseId) } : s));

// What the editor can tell before saving (the server checks the compiled graph again on save and publish).
export function listIssues(steps: ListStep[], enabledActions: string[]): string[] {
  const issues: string[] = [];
  const all = labelSteps(steps);
  const targets = new Set(all.filter((l) => l.step.type === 'step').map((l) => l.step.id));
  const text = (c: Inline[]) => c.map((p) => (p.t === 'text' ? p.v : 'x')).join('').trim();
  if (!steps.length) issues.push('Add at least one step');
  for (const { step, label } of all) {
    if (step.type === 'step') {
      if (!text(step.content)) issues.push(`Step ${label} is empty`);
      step.content.forEach((p) => { if (p.t === 'action' && !enabledActions.includes(p.key)) issues.push(`Step ${label}: @${p.key} doesn't exist or is disabled`); });
    } else if (step.type === 'condition') {
      step.cases.forEach((c, i) => {
        if (c.kind !== 'else' && !text(c.condition)) issues.push(`Step ${label}: the ${c.kind === 'if' ? 'If' : 'Else if'} condition is empty`);
        if (c.kind === 'else' && i !== step.cases.length - 1) issues.push(`Step ${label}: Else must be last`);
      });
    } else if (!step.target || !targets.has(step.target)) issues.push(`Step ${label}: choose which step to go to`);
  }
  // Anything after a jump in the same list never runs.
  const after = (list: ListStep[], prefix: string) => list.forEach((s, i) => {
    if (s.type === 'goto' && i < list.length - 1) issues.push(`Step ${prefix}${i + 2} never runs: it comes after a Go to step`);
    if (s.type === 'condition') s.cases.forEach((c, ci) => after(c.steps, `${prefix}${i + 1}${String.fromCharCode(97 + ci)}.`));
  });
  after(steps, '');
  const n = listStepCount(steps);
  if (n > MAX_LIST_STEPS) issues.push(`Too many steps: ${n} of ${MAX_LIST_STEPS}`);
  return issues;
}

// List → graph. Consecutive plain steps share a group; a condition ends its group and each case with steps gets its
// own chain; a case without steps falls through to the group's "then" arrow; "Go to step" is an arrow back to that
// step with a repeat limit. Ids are derived from the list, so the same list always compiles to the same graph.
export function compileList(flow: ListFlow): ListGraph {
  const groups: GraphGroup[] = [];
  const edges: GraphEdge[] = [];
  const where = new Map<string, { groupId: string; first: boolean }>();
  const labels = new Map(labelSteps(flow.steps).map((l) => [l.step.id, l.label]));
  const jumps: { from: EdgeFrom[]; target: string; maxVisits: number }[] = [];
  const edgeId = (f: EdgeFrom, t: { groupId: string; itemId?: string }) => `${f.groupId}:${f.itemId ?? ''}:${f.port ?? ''}>${t.groupId}:${t.itemId ?? ''}`;
  const connect = (from: EdgeFrom[], to: { groupId: string; itemId?: string }, extra?: Partial<GraphEdge>) =>
    from.forEach((f) => edges.push({ id: edgeId(f, to), from: f, to, ...extra }));
  const group = (title: string, id: string): GraphGroup => { const g = { id, title, x: 0, y: 0, items: [] as GraphItem[] }; groups.push(g); return g; };

  const walk = (steps: ListStep[], open: EdgeFrom[]): EdgeFrom[] => {
    let cur: GraphGroup | null = null;
    for (const s of steps) {
      if (s.type === 'step') {
        if (!cur) { cur = group(`Step ${labels.get(s.id)}`, `g_${s.id}`); connect(open, { groupId: cur.id }); open = []; }
        where.set(s.id, { groupId: cur.id, first: cur.items.length === 0 });
        cur.items.push({ id: s.id, type: 'step', content: s.content });
      } else if (s.type === 'condition') {
        if (!cur) { cur = group(`Step ${labels.get(s.id)}`, `g_${s.id}`); connect(open, { groupId: cur.id }); open = []; }
        cur.items.push({ id: s.id, type: 'condition', cases: s.cases.map((c) => ({ id: c.id, kind: c.kind, condition: c.condition })) });
        const outs: EdgeFrom[] = [];
        let fallThrough = false;
        for (const c of s.cases) {
          if (!c.steps.length) { fallThrough = true; continue; }
          outs.push(...walk(c.steps, [{ groupId: cur.id, itemId: s.id, port: c.id }]));
        }
        if (fallThrough) outs.push({ groupId: cur.id });
        open = outs; cur = null;
      } else {
        jumps.push({ from: cur ? [{ groupId: cur.id }] : open, target: s.target, maxVisits: s.maxVisits });
        open = []; cur = null;
      }
    }
    return cur ? [{ groupId: cur.id }] : open;
  };
  walk(flow.steps, []);
  for (const j of jumps) {
    const t = where.get(j.target);
    if (t) connect(j.from, t.first ? { groupId: t.groupId } : { groupId: t.groupId, itemId: j.target }, { maxVisits: j.maxVisits });
  }
  if (!groups.length) group('Step 1', 'start');
  return { ...tidy({ start: groups[0].id, groups, edges, variables: [] }), builder2: flow };
}

// Reads the list back from a saved graph. `stale`: the canvas changed the graph since the list was saved, so the list
// no longer describes what runs. `canvasOnly`: there's no list at all (the workflow was drawn on the canvas).
export function readList(graph: ListGraph): { flow: ListFlow; stale: boolean; canvasOnly: boolean } {
  const blank = graph.groups.length === 1 && !graph.groups[0].items.length && !graph.edges.length;
  if (!graph.builder2) return { flow: emptyFlow(), stale: false, canvasOnly: !blank };
  const flow = graph.builder2;
  return { flow, stale: shape(compileList(flow)) !== shape(graph), canvasOnly: false };
}
// The graph without positions (dragging a card around on the canvas isn't a change of meaning), with keys in a fixed
// order: Postgres stores the graph as jsonb and hands the keys back in its own order.
const shape = (g: WorkflowGraph) => canon({
  start: g.start,
  groups: [...g.groups].sort((a, b) => a.id.localeCompare(b.id)).map(({ x: _x, y: _y, ...rest }) => rest),
  edges: [...g.edges].sort((a, b) => a.id.localeCompare(b.id)).map((e) => ({ from: e.from, to: e.to, maxVisits: e.maxVisits ?? null, fresh: !!e.fresh })),
});
const canon = (v: unknown): string => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => (v as any)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`
  : JSON.stringify(v);
