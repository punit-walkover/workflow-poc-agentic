'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronLeft, Trash2, Workflow } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { compileList, emptyFlow, ListGraph, listIssues, listStepCount, ListStep, MAX_LIST_STEPS, readList } from '@/lib/list-flow';
import { ListBuilder } from '@/components/list-builder';
import { Button, Toggle } from '@/components/ui';

interface Wf {
  id: string; name: string; when_to_use: string; graph: ListGraph; enabled: boolean;
  row_version: number; published_at: string | null; has_unpublished_changes: boolean;
  validation: { issues: string[] };
}
interface Draft { name: string; when_to_use: string; steps: ListStep[] }

// Builder 2's editor: "When to use" plus a numbered list of steps. Saving compiles the list into the canvas graph the
// server runs, so a workflow written here publishes and runs like one drawn on the canvas.
export default function Builder2EditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [wf, setWf] = useState<Wf | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [source, setSource] = useState<{ stale: boolean; canvasOnly: boolean }>({ stale: false, canvasOnly: false });
  const [actions, setActions] = useState<{ key: string; name: string; enabled: boolean }[]>([]);
  const [variables, setVariables] = useState<{ key: string; label: string }[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string; issues?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (w: Wf) => {
    const { flow, stale, canvasOnly } = readList(w.graph);
    setWf(w); setDraft({ name: w.name, when_to_use: w.when_to_use, steps: flow.steps }); setSource({ stale, canvasOnly }); setDirty(false);
  };
  useEffect(() => {
    api<Wf>(`/workflows/${id}`).then(apply);
    api('/actions').then(setActions);
    api('/variables').then(setVariables);
  }, [id]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const edit = (patch: Partial<Draft>) => { setDraft((d) => (d ? { ...d, ...patch } : d)); setDirty(true); };
  const body = () => ({ name: draft!.name, when_to_use: draft!.when_to_use, graph: compileList({ steps: draft!.steps }), row_version: wf!.row_version });
  const run = async (fn: () => Promise<Wf>, ok: string) => {
    setBusy(true); setMsg(null);
    try { apply(await fn()); setMsg({ kind: 'ok', text: ok }); }
    catch (e: any) { setMsg({ kind: 'bad', text: e.message, issues: e instanceof ApiError ? e.issues : undefined }); }
    finally { setBusy(false); }
  };
  const save = () => run(() => api(`/workflows/${id}`, { method: 'PUT', body: body() }), 'Saved as draft. Live runs are unaffected until you publish.');
  const publish = () => run(async () => {
    if (dirty || source.stale) apply(await api<Wf>(`/workflows/${id}`, { method: 'PUT', body: body() }));
    return api(`/workflows/${id}/publish`, { method: 'POST' });
  }, 'Published. New conversations use it; chats already running finish on what they started with.');
  const patch = (b: object) => run(() => api(`/workflows/${id}`, { method: 'PATCH', body: b }), 'Updated.');
  const remove = async () => {
    if (!confirm(`Delete "${wf!.name}"? Conversations already running it will finish, new ones won't use it.`)) return;
    setDirty(false);
    await api(`/workflows/${id}`, { method: 'DELETE' });
    router.push('/builder2');
  };
  const openCanvas = (e: React.MouseEvent) => {
    if (dirty && !confirm('You have unsaved changes. Leave without saving?')) e.preventDefault();
  };
  const startOver = () => { edit({ steps: emptyFlow().steps }); setSource({ stale: false, canvasOnly: false }); };

  const enabledKeys = useMemo(() => actions.filter((a) => a.enabled).map((a) => a.key), [actions]);
  if (!wf || !draft || !actions.length) return <div className="p-8 text-ink-3">Loading…</div>;
  const issues = source.canvasOnly ? [] : listIssues(draft.steps, enabledKeys);
  const count = listStepCount(draft.steps);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-6 py-3">
        <Link href="/builder2" className="rounded p-1 hover:bg-hover"><ChevronLeft size={18} /></Link>
        <input value={draft.name} onChange={(e) => edit({ name: e.target.value })}
               className="min-w-0 flex-1 rounded-md px-2 py-1 text-base font-semibold outline-none hover:bg-hover focus:bg-hover" />
        <span className="text-xs text-ink-3">
          {wf.published_at ? 'Live' : 'Never published'}
          {(dirty || (wf.has_unpublished_changes && wf.published_at)) ? ' · unpublished changes' : ''}
        </span>
        <label className="flex items-center gap-2 text-sm text-ink-2">Enabled <Toggle on={wf.enabled} disabled={!wf.published_at} onChange={(v) => patch({ enabled: v })} /></label>
        <Link href={`/workflows/${id}`} onClick={openCanvas}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-3 py-1.5 text-sm font-medium hover:bg-hover">
          <Workflow size={15} /> Open in canvas
        </Link>
        <Button onClick={save} disabled={busy || !dirty || source.canvasOnly}>Save changes</Button>
        <Button variant="primary" onClick={publish} disabled={busy}>Publish</Button>
        <button title="Delete workflow" onClick={remove} className="rounded p-1.5 text-ink-3 hover:bg-hover hover:text-bad"><Trash2 size={16} /></button>
      </header>

      <div className="mx-auto w-full max-w-3xl px-8 py-6">
        {msg && (
          <div className={`mb-4 rounded-lg px-4 py-3 ${msg.kind === 'ok' ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}>
            {msg.text}
            {msg.issues && <ul className="mt-1 list-disc pl-5">{msg.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
          </div>
        )}
        {source.canvasOnly && (
          <div className="mb-5 flex gap-2 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-warn">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">This workflow was drawn on the canvas.</div>
              <div>Builder 2 can't show a canvas drawing as a list. Keep editing it on the canvas, or start over here (that replaces the drawing when you save).</div>
              <div className="mt-2 flex gap-2">
                <Link href={`/workflows/${id}`} className="rounded-md border border-warn/40 px-2.5 py-1 text-sm font-medium hover:bg-warn/10">Open in canvas</Link>
                <button type="button" onClick={startOver} className="rounded-md border border-warn/40 px-2.5 py-1 text-sm font-medium hover:bg-warn/10">Start over here</button>
              </div>
            </div>
          </div>
        )}
        {source.stale && !dirty && (
          <div className="mb-5 flex gap-2 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-warn">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div><div className="font-medium">This workflow was changed on the canvas after it was written here.</div>
              The list below is the last version written in Builder 2. Saving from here replaces the canvas changes.</div>
          </div>
        )}
        {!source.canvasOnly && issues.length > 0 && (
          <div className="mb-5 flex gap-2 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-warn">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div><div className="font-medium">This workflow can't be published yet:</div>
              <ul className="list-disc pl-5">{issues.map((i) => <li key={i}>{i}</li>)}</ul></div>
          </div>
        )}

        <label className="mb-1 block font-semibold">When to use</label>
        <textarea value={draft.when_to_use} onChange={(e) => edit({ when_to_use: e.target.value })} rows={3}
                  placeholder="Describe the customer's request this workflow handles, e.g. 'the customer wants money back for a paid order'."
                  className="mb-6 w-full resize-y rounded-lg border border-line bg-panel px-3 py-2.5 outline-none placeholder:text-ink-3 focus:border-ink-3" />

        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-semibold">Steps</span>
          <span className={`text-xs ${count > MAX_LIST_STEPS ? 'text-bad' : 'text-ink-3'}`}>{Math.max(0, MAX_LIST_STEPS - count)} of {MAX_LIST_STEPS} steps remaining</span>
        </div>
        <div className={`rounded-xl border border-line bg-panel px-3 py-3 ${source.canvasOnly ? 'pointer-events-none opacity-50' : ''}`}>
          <ListBuilder steps={draft.steps} onChange={(steps) => edit({ steps })} actions={actions} variables={variables} />
        </div>
        <p className="mt-2 text-xs text-ink-3">
          Type <b>@</b> to reference actions, <b>{'{{'}</b> to insert a variable, <b>Enter</b> for a new step.
          Choose <b>Condition</b> from the @ menu to turn a step into If / Else. Use <b>Go to step</b> to repeat an earlier step.
        </p>
      </div>
    </div>
  );
}
