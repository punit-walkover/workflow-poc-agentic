'use client';

import { useEffect, useState } from 'react';
import { Copy, X } from 'lucide-react';
import { api, usd } from '@/lib/api';
import { JsonView } from './json-view';

interface Round { round: number; request: unknown; response: { text: string | null; tool_calls: unknown[]; tool_results: unknown[]; finish_reason: string | null; usage: any } }
interface AiCallDetail {
  id: string; agent: string; model: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; started_at: string;
  trace: { rounds: Round[]; final_text: string | null } | null;
}

// One AI call's full exchange: per model round, the exact request sent to the provider and what came back.
export function AiCallDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [call, setCall] = useState<AiCallDetail | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { api<AiCallDetail>(`/ai-calls/${id}`).then(setCall).catch((e) => setError(e.message)); }, [id]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(call, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-[min(980px,100%)] flex-col overflow-hidden rounded-xl bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{call?.agent ?? 'AI call'}</div>
            {call && <div className="text-xs text-ink-3">{call.model} · {new Date(call.started_at).toLocaleTimeString()} · {call.input_tokens ?? 0} in · {call.output_tokens ?? 0} out · {usd(call.cost_usd)} · {call.trace?.rounds.length ?? 0} round{call.trace?.rounds.length === 1 ? '' : 's'}</div>}
          </div>
          {call?.trace && <button onClick={copy} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-2 hover:text-ink"><Copy size={12} /> {copied ? 'Copied' : 'Copy JSON'}</button>}
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-3 hover:bg-hover hover:text-ink"><X size={18} /></button>
        </header>
        <div className="flex-1 space-y-4 overflow-auto px-5 py-4 text-sm">
          {error && <div className="text-bad">{error}</div>}
          {!call && !error && <div className="text-ink-3">Loading…</div>}
          {call && !call.trace && <div className="text-ink-3">This call was made before full requests were recorded, so only its tokens and cost were kept.</div>}
          {call?.trace?.rounds.map((r) => (
            <section key={r.round} className="rounded-lg border border-line">
              <div className="flex items-center gap-2 border-b border-line bg-hover px-3 py-1.5 text-xs">
                <span className="font-semibold">Round {r.round}</span>
                <span className="text-ink-3">{r.response.finish_reason ?? ''}{r.response.usage ? ` · ${r.response.usage.inputTokens ?? '?'} in · ${r.response.usage.outputTokens ?? '?'} out` : ''}</span>
              </div>
              <div className="grid gap-3 p-3 md:grid-cols-2">
                <div className="min-w-0">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Request sent to the model</div>
                  <JsonView value={r.request} open={2} />
                </div>
                <div className="min-w-0">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Response</div>
                  <JsonView value={r.response} open={3} />
                </div>
              </div>
            </section>
          ))}
          {call?.trace?.final_text && (
            <section>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Final text</div>
              <div className="whitespace-pre-wrap rounded-lg border border-line bg-canvas px-3 py-2">{call.trace.final_text}</div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
