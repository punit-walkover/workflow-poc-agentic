import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { one, q } from '../db';
import { WorkflowGraph } from '../types';
import { validateGraph } from './graph';

// A workflow is a canvas graph.
const check = (w: { graph: WorkflowGraph }, enabled: string[]) => validateGraph(w.graph, enabled);
const emptyGraph = (): WorkflowGraph => ({ start: 'start', groups: [{ id: 'start', title: 'Start', x: 0, y: 0, items: [] }], edges: [], variables: [] });

// Actions that wait for a teammate; the agent map marks them.
export const needsApproval = async () => new Set((await q<{ key: string }>('select key from action where requires_approval')).map((r) => r.key));

const enabledActionKeys = async () => (await q<{ key: string }>('select key from action where enabled')).map((r) => r.key);

export async function listWorkflows() {
  return q(`select id, name, when_to_use, enabled, step_count, has_unpublished_changes, updated_at, published_at
            from workflow where archived_at is null order by created_at`);
}

export async function getWorkflow(id: string) {
  const w = await one(`select * from workflow where id = $1 and archived_at is null`, [id]);
  if (!w) throw new NotFoundException('workflow not found');
  return { ...w, validation: check(w, await enabledActionKeys()) };
}

export async function createWorkflow(body: { name?: string }) {
  const base = body.name?.trim() || 'Untitled workflow';
  const taken = await q<{ name: string }>('select name from workflow where name like $1 and archived_at is null', [`${base}%`]);
  const name = taken.some((r) => r.name === base) ? `${base} ${taken.length + 1}` : base;
  const graph = emptyGraph();
  const v = check({ graph }, await enabledActionKeys());
  const row = await one(`insert into workflow (name, when_to_use, graph, action_keys, step_count)
                         values ($1, '', $2, $3, $4) returning id`,
    [name, JSON.stringify(graph), v.action_keys, v.step_count]);
  return getWorkflow(row.id);
}

export async function saveWorkflow(id: string, body: { name: string; when_to_use: string; graph?: WorkflowGraph; row_version: number }) {
  if (!body.name?.trim()) throw new BadRequestException('name is required');
  const cur = await one<{ graph: WorkflowGraph }>('select graph from workflow where id = $1', [id]);
  if (!cur) throw new NotFoundException('workflow not found');
  const graph = body.graph ?? cur.graph;
  const v = check({ graph }, await enabledActionKeys());
  const row = await one(`update workflow set name = $2, when_to_use = $3, graph = $4, action_keys = $5, step_count = $6,
                           has_unpublished_changes = true, row_version = row_version + 1, updated_at = now()
                         where id = $1 and row_version = $7 and archived_at is null returning id`,
    [id, body.name.trim(), body.when_to_use ?? '', JSON.stringify(graph), v.action_keys, v.step_count, body.row_version]);
  if (!row) throw new ConflictException('This workflow changed elsewhere — reload to see the latest version.');
  return getWorkflow(id);
}

// Copies the draft over the published copy. New conversations use it; running ones keep the graph they started on.
export async function publishWorkflow(id: string) {
  const w = await getWorkflow(id);
  if (w.validation.issues.length) throw new BadRequestException({ message: 'Fix these before publishing', issues: w.validation.issues });
  await q(`update workflow set published_graph = graph, published_when_to_use = when_to_use, published_action_keys = action_keys,
             published_at = now(), has_unpublished_changes = false, enabled = true, updated_at = now() where id = $1`, [id]);
  return getWorkflow(id);
}

export async function patchWorkflow(id: string, body: { enabled?: boolean }) {
  const w = await getWorkflow(id);
  if (body.enabled && !w.published_graph) throw new BadRequestException('Publish the workflow before enabling it');
  await q(`update workflow set enabled = coalesce($2, enabled), updated_at = now() where id = $1`, [id, body.enabled ?? null]);
  return getWorkflow(id);
}

export async function archiveWorkflow(id: string) {
  await q('update workflow set archived_at = now(), enabled = false where id = $1', [id]);
  return { ok: true };
}
