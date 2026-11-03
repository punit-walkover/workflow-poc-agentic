'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { compileList, emptyFlow } from '@/lib/list-flow';
import { Button, Card, Toggle } from '@/components/ui';

interface Row { id: string; name: string; when_to_use: string; enabled: boolean; step_count: number; published_at: string | null; has_unpublished_changes: boolean; list_builder: boolean }

// Builder 2: workflows written as a numbered list of steps. Ones drawn on the canvas stay on the Workflows tab.
export default function Builder2Page() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');

  const load = () => api<Row[]>('/workflows').then((r) => setRows(r.filter((w) => w.list_builder))).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  // Saved right away with an empty list, so it is a Builder 2 workflow from the start (and shows in this list).
  const create = async () => {
    const w = await api('/workflows', { method: 'POST', body: {} });
    await api(`/workflows/${w.id}`, { method: 'PUT', body: { name: w.name, when_to_use: '', graph: compileList(emptyFlow()), row_version: w.row_version } });
    router.push(`/builder2/${w.id}`);
  };
  const remove = async (r: Row) => {
    if (!confirm(`Delete "${r.name}"? Conversations already running it will finish, new ones won't use it.`)) return;
    try { await api(`/workflows/${r.id}`, { method: 'DELETE' }); load(); } catch (e: any) { setError(e.message); }
  };
  const toggle = async (r: Row, enabled: boolean) => {
    try { await api(`/workflows/${r.id}`, { method: 'PATCH', body: { enabled } }); load(); } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Builder 2</h1>
          <p className="text-ink-2">Write a workflow as a numbered list of steps. Runs the same way as one drawn on the canvas.</p>
        </div>
        <Button variant="primary" onClick={create}><Plus size={15} /> New workflow</Button>
      </div>
      {error && <div className="mb-4 rounded-lg bg-bad-soft px-3 py-2 text-bad">{error}</div>}
      <div className="space-y-3">
        {rows.map((r) => (
          <Card key={r.id} className="flex items-center gap-4 px-5 py-4">
            <Link href={`/builder2/${r.id}`} className="min-w-0 flex-1">
              <div className="font-medium">{r.name}</div>
              <div className="truncate text-ink-2">{r.when_to_use || 'No "when to use" yet'}</div>
              <div className="mt-1 text-xs text-ink-3">
                {r.step_count} steps · {r.published_at ? 'live' : 'never published'}
                {r.has_unpublished_changes && r.published_at ? ' · unpublished changes' : ''}
              </div>
            </Link>
            <Toggle on={r.enabled} onChange={(v) => toggle(r, v)} disabled={!r.published_at} />
            <button title="Delete workflow" onClick={() => remove(r)} className="rounded p-1.5 text-ink-3 hover:bg-hover hover:text-bad"><Trash2 size={16} /></button>
          </Card>
        ))}
        {!rows.length && !error && <div className="text-ink-3">No Builder 2 workflows yet. Workflows drawn on the canvas stay on the Workflows tab.</div>}
      </div>
    </div>
  );
}
