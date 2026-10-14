import { config } from '../config';
import { GraphGroup, GraphItem, Inline, INPUT_FORMATS, RULE_OPS, VARIABLES, WorkflowGraph } from '../types';

const allItems = (g: WorkflowGraph) => g.groups.flatMap((grp) => grp.items);

export function graphMentions(g: WorkflowGraph) {
  const actions = new Set<string>();
  const vars = new Set<string>();
  const scan = (c: Inline[]) => c.forEach((p) => (p.t === 'action' ? actions.add(p.key) : p.t === 'var' ? vars.add(p.key) : 0));
  for (const it of allItems(g)) {
    if (it.type === 'step' || it.type === 'bubble') { scan(it.content); if (it.type === 'step') it.save?.forEach((m) => vars.add(m.var)); }
    else if (it.type === 'input') { scan(it.prompt); vars.add(it.saveAs); }
    else it.cases.forEach((c) => { scan(c.condition); c.rules?.forEach((r) => { vars.add(r.var); if (r.ref) vars.add(r.ref); }); });
  }
  return { actions: [...actions], vars: [...vars] };
}

// Everything but conditions counts toward the step limit.
export const graphStepCount = (g: WorkflowGraph) => allItems(g).filter((i) => i.type !== 'condition').length;

// Groups that sit on a cycle, as strongly connected components (Tarjan). A loop needs a repeat limit somewhere.
export function cycles(g: WorkflowGraph): string[][] {
  let i = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), stack: string[] = [], out: string[][] = [];
  const next = (id: string) => g.edges.filter((e) => e.from.groupId === id).map((e) => e.to.groupId);
  const visit = (v: string) => {
    idx.set(v, i); low.set(v, i); i++; stack.push(v); on.add(v);
    for (const w of next(v)) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || next(v).includes(v)) out.push(comp);
    }
  };
  g.groups.forEach((grp) => { if (!idx.has(grp.id)) visit(grp.id); });
  return out;
}

export function validateGraph(g: unknown, enabledActions: string[]) {
  const issues: string[] = [];
  const graph = g as WorkflowGraph;
  if (!graph?.groups?.length) return { issues: ['Add at least one group'], action_keys: [], step_count: 0 };
  const groups = new Map(graph.groups.map((x) => [x.id, x]));
  const items = new Map<string, { item: GraphItem; group: GraphGroup }>();
  const text = (c: Inline[]) => c.map((p) => (p.t === 'text' ? p.v : 'x')).join('').trim();
  for (const grp of graph.groups) {
    if (!grp.items.length) issues.push(`"${grp.title}": add at least one step`);
    for (const it of grp.items) {
      if (items.has(it.id)) issues.push(`"${grp.title}": duplicate item id`);
      items.set(it.id, { item: it, group: grp });
      if (it.type === 'step' && !text(it.content)) issues.push(`"${grp.title}": a step is empty`);
      if (it.type === 'step' && it.save?.length) {
        if (!it.content.some((p) => p.t === 'action')) issues.push(`"${grp.title}": "Save response" needs an @action in the step`);
        if (it.save.some((m) => !m.path.trim() || !m.var)) issues.push(`"${grp.title}": each saved field needs a path and a variable`);
        const names = it.save.map((m) => m.var).filter(Boolean);
        if (new Set(names).size !== names.length) issues.push(`"${grp.title}": a variable is saved twice in one step`);
      }
      if (it.type === 'bubble') {
        if (!text(it.content)) issues.push(`"${grp.title}": a text bubble is empty`);
        if (it.content.some((p) => p.t === 'action')) issues.push(`"${grp.title}": a text bubble can't run @actions; use an AI step`);
      }
      if (it.type === 'input') {
        if (!it.saveAs) issues.push(`"${grp.title}": choose a variable to save the answer in`);
        if (!INPUT_FORMATS.includes(it.format)) issues.push(`"${grp.title}": unknown input type`);
      }
      if (it.type === 'condition') {
        if (it.cases[0]?.kind !== 'if') issues.push(`"${grp.title}": a condition must start with If`);
        it.cases.forEach((c, ci) => {
          if (c.kind === 'else' && ci !== it.cases.length - 1) issues.push(`"${grp.title}": Else must be last`);
          if (c.kind === 'else') return;
          if (it.mode !== 'rules' && !text(c.condition)) issues.push(`"${grp.title}": a condition is empty`);
          if (it.mode === 'rules') {
            if (!c.rules?.length) issues.push(`"${grp.title}": add a rule to each case`);
            c.rules?.forEach((r) => {
              if (!r.var) issues.push(`"${grp.title}": a rule has no variable`);
              if (r.ref === '') issues.push(`"${grp.title}": choose the variable to compare with`);
              if (!RULE_OPS.includes(r.op)) issues.push(`"${grp.title}": a rule has an unknown comparison`);
            });
          }
        });
      }
    }
  }
  if (!groups.has(graph.start)) issues.push('The start group is missing');
  const sources = new Set<string>();
  for (const e of graph.edges) {
    const from = groups.get(e.from.groupId);
    if (!from || !groups.has(e.to.groupId)) { issues.push('An arrow points to a group that no longer exists'); continue; }
    if (e.to.itemId && items.get(e.to.itemId)?.group.id !== e.to.groupId) issues.push(`An arrow into "${groups.get(e.to.groupId)!.title}" points to a step that no longer exists`);
    if (e.from.itemId) {
      const c = items.get(e.from.itemId)?.item;
      if (c?.type !== 'condition' || !c.cases.some((x) => x.id === e.from.port)) issues.push(`"${from.title}": an arrow starts from a case that no longer exists`);
    }
    const key = `${e.from.groupId}:${e.from.itemId ?? ''}:${e.from.port ?? ''}`;
    if (sources.has(key)) issues.push(`"${from.title}": one output has two arrows`);
    sources.add(key);
    if (e.maxVisits !== undefined && (!Number.isInteger(e.maxVisits) || e.maxVisits < 1 || e.maxVisits > config.maxVisits))
      issues.push(`"${from.title}": repeat limit must be 1 to ${config.maxVisits}`);
  }
  // Every group must be reachable from the start.
  const seen = new Set<string>([graph.start]);
  const queue = [graph.start];
  while (queue.length) {
    const id = queue.shift();
    for (const e of graph.edges.filter((x) => x.from.groupId === id)) if (!seen.has(e.to.groupId)) { seen.add(e.to.groupId); queue.push(e.to.groupId); }
  }
  graph.groups.filter((x) => !seen.has(x.id)).forEach((x) => issues.push(`"${x.title}" can't be reached from the start`));
  // Every loop needs at least one arrow with a repeat limit.
  for (const comp of cycles(graph)) {
    const inside = graph.edges.filter((e) => comp.includes(e.from.groupId) && comp.includes(e.to.groupId));
    if (!inside.some((e) => e.maxVisits)) issues.push(`Loop through ${comp.map((id) => `"${groups.get(id)?.title}"`).join(', ')} needs a repeat limit on one of its arrows`);
  }
  const step_count = graphStepCount(graph);
  if (step_count > config.maxGraphSteps) issues.push(`Too many steps: ${step_count} of ${config.maxGraphSteps}`);
  const { actions, vars } = graphMentions(graph);
  actions.filter((k) => !enabledActions.includes(k)).forEach((k) => issues.push(`@${k} doesn't exist or is disabled`));
  const own = graph.variables ?? [];
  vars.filter((k) => k && !VARIABLES.some((v) => v.key === k) && !own.includes(k)).forEach((k) => issues.push(`Unknown variable {{${k}}}`));
  own.filter((k) => !/^[a-z][a-z0-9_]*$/.test(k)).forEach((k) => issues.push(`Variable "${k}": use lowercase letters, digits and _`));
  return { issues, action_keys: actions, step_count };
}
