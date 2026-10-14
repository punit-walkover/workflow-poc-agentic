// Read-only workflow map for agents, built from a published canvas graph. Pure: no DB or AI.
import { GraphCase, GraphEdge, GraphItem, InputFormat, Rule, WorkflowGraph } from '../types';
import { renderInline, stepActions } from '../workflows/inline';

export interface MapCase { id: string; kind: string; when: string; goes: string }
export interface MapItem {
  ref: string;                                   // "2.1" = group 2, item 1
  id: string;
  type: 'ai_step' | 'bubble' | 'input' | 'condition';
  text: string;
  collects?: { name: string; format: InputFormat };
  tools?: { key: string; needsApproval: boolean }[];
  save?: { path: string; var: string }[];
  mode?: 'ai' | 'rules';
  cases?: MapCase[];
}
export interface MapGroup { ref: string; id: string; title: string; reachable: boolean; items: MapItem[]; then: string }
export interface MapLoop { from: string; to: string; maxVisits: number | null; fresh: boolean }
export interface WorkflowMap { name: string; whenToUse: string; start: string; groups: MapGroup[]; loops: MapLoop[]; text: string }

const ruleText = (r: Rule) => (r.op === 'empty' || r.op === 'not_empty' ? `${r.var} ${r.op}` : `${r.var} ${r.op} ${r.ref ? `{{${r.ref}}}` : JSON.stringify(r.value)}`);
const caseWhen = (c: GraphCase, mode?: 'ai' | 'rules') =>
  c.kind === 'else' ? 'otherwise' : mode === 'rules' ? (c.rules ?? []).map(ruleText).join(c.join === 'or' ? ' or ' : ' and ') : renderInline(c.condition);

export function buildMap(g: WorkflowGraph, meta: { name: string; whenToUse: string }, needsApproval: Set<string> = new Set()): WorkflowMap {
  const byId = new Map(g.groups.map((grp) => [grp.id, grp]));
  // Number groups in the order a run meets them (breadth-first from the start); unreachable ones go last.
  const order: string[] = [];
  const queue = byId.has(g.start) ? [g.start] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (order.includes(id)) continue;
    order.push(id);
    for (const it of byId.get(id)!.items) for (const e of g.edges.filter((x) => x.from.groupId === id && x.from.itemId === it.id)) queue.push(e.to.groupId);
    for (const e of g.edges.filter((x) => x.from.groupId === id && !x.from.itemId)) queue.push(e.to.groupId);
  }
  const reachable = new Set(order);
  for (const grp of g.groups) if (!reachable.has(grp.id)) order.push(grp.id);

  const groupRef = new Map(order.map((id, i) => [id, String(i + 1)]));
  const itemRef = new Map<string, string>();
  for (const id of order) byId.get(id)!.items.forEach((it, i) => itemRef.set(it.id, `${groupRef.get(id)}.${i + 1}`));
  const to = (e: GraphEdge) => (e.to.itemId ? itemRef.get(e.to.itemId) : groupRef.get(e.to.groupId)) ?? '?';
  const loops: MapLoop[] = g.edges.filter((e) => e.maxVisits).map((e) => ({
    from: e.from.itemId ? `${itemRef.get(e.from.itemId)}` : groupRef.get(e.from.groupId)!, to: to(e), maxVisits: e.maxVisits ?? null, fresh: !!e.fresh,
  }));
  const goes = (e: GraphEdge | undefined) => (e ? (e.maxVisits ? `${to(e)} (loop)` : to(e)) : 'next');

  const item = (it: GraphItem, ref: string): MapItem => {
    switch (it.type) {
      case 'step': return {
        ref, id: it.id, type: 'ai_step', text: renderInline(it.content),
        tools: stepActions(it.content).map((key) => ({ key, needsApproval: needsApproval.has(key) })),
        ...(it.save?.length ? { save: it.save.map((s) => ({ path: s.path, var: s.var })) } : {}),
      };
      case 'bubble': return { ref, id: it.id, type: 'bubble', text: renderInline(it.content) };
      case 'input': return { ref, id: it.id, type: 'input', text: renderInline(it.prompt), collects: { name: it.saveAs, format: it.format } };
      case 'condition': return {
        ref, id: it.id, type: 'condition', text: '', mode: it.mode === 'rules' ? 'rules' : 'ai',
        cases: it.cases.map((c) => ({ id: c.id, kind: c.kind, when: caseWhen(c, it.mode), goes: goes(g.edges.find((e) => e.from.itemId === it.id && e.from.port === c.id)) })),
      };
    }
  };
  const groups: MapGroup[] = order.map((id) => {
    const grp = byId.get(id)!;
    const exit = g.edges.find((e) => e.from.groupId === id && !e.from.itemId);
    return { ref: groupRef.get(id)!, id, title: grp.title, reachable: reachable.has(id), items: grp.items.map((it) => item(it, itemRef.get(it.id)!)), then: exit ? goes(exit) : 'end' };
  });
  const start = groupRef.get(g.start) ?? '1';
  return { name: meta.name, whenToUse: meta.whenToUse, start, groups, loops, text: mapText(meta, groups, loops) };
}

// The map as prompt text, one line per item.
function mapText(meta: { name: string; whenToUse: string }, groups: MapGroup[], loops: MapLoop[]): string {
  const line = (it: MapItem) => {
    switch (it.type) {
      case 'ai_step': {
        const tools = it.tools?.length ? `  tools: ${it.tools.map((t) => `${t.key}${t.needsApproval ? ' (needs approval)' : ''}`).join(', ')}` : '';
        const save = it.save?.length ? `  save: ${it.save.map((s) => `${s.path} → ${s.var}`).join(', ')}` : '';
        return `${it.ref} [${it.id}] ai_step "${it.text}"${tools}${save}`;
      }
      case 'bubble': return `${it.ref} [${it.id}] bubble "${it.text}"`;
      case 'input': return `${it.ref} [${it.id}] input saves ${it.collects!.name} (${it.collects!.format})${it.text ? ` "${it.text}"` : ''}`;
      case 'condition': return `${it.ref} [${it.id}] condition (${it.mode}) ${it.cases!.map((c) => `${c.kind === 'else' ? `else [${c.id}]` : `if ${c.when} [${c.id}]`} → ${c.goes}`).join(' · ')}`;
    }
  };
  const out = [`WORKFLOW: ${meta.name}`, `When to use: ${meta.whenToUse || '(not set)'}`, '', 'WORKFLOW MAP'];
  for (const grp of groups) {
    out.push(`${grp.ref} ${grp.title}${grp.reachable ? '' : ' (not reachable)'}`);
    for (const it of grp.items) out.push(`  ${line(it)}`);
    out.push(`  then → ${grp.then}`);
  }
  for (const l of loops) out.push(`loop ${l.from} → ${l.to}: max ${l.maxVisits ?? '∞'} visits${l.fresh ? ', ask again' : ', keep answers'}`);
  return out.join('\n');
}
