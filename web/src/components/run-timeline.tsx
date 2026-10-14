'use client';

import {
  AlertTriangle, Check, ChevronRight, Clock, CornerUpLeft, GitBranch, MessageSquare, Save, ShieldCheck, User, Wrench, X,
} from 'lucide-react';
import { useState } from 'react';
import { usd } from '@/lib/api';
import type { WorkflowGraph } from '@/lib/graph';
import { inlineText } from '@/lib/inline';
import { StatusChip } from './ui';

export interface TimelineEvent { id: string; run_id: string; node_id: string | null; actor: string; type: string; data: any; at: string }
export interface TimelineMessage { id: string; text: string; attachments?: { id: string }[] }
export interface TimelineRun { id: string; status: string; workflow_name: string; graph: WorkflowGraph; end_reason: string | null; started_at?: string }

const cut = (s: string, n = 32) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const value = (v: unknown) => cut(typeof v === 'object' ? JSON.stringify(v) : String(v), 40);

// Block id → readable label from the graph the run started on: "Start › 2 · Asks for order_id".
export function nodeLabels(run: Pick<TimelineRun, 'graph'>): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of run.graph.groups) g.items.forEach((it, i) => {
    const what = it.type === 'step' || it.type === 'bubble' ? cut(inlineText(it.content))
      : it.type === 'input' ? `Asks for ${it.saveAs || '…'}` : it.mode === 'rules' ? 'Condition' : 'AI condition';
    m.set(it.id, `${g.title} › ${i + 1} · ${what}`);
  });
  return m;
}

// ---- Simple view: one plain sentence per meaningful event; plumbing (signals, duplicate waits) is left out.
type Tone = 'ai' | 'bot' | 'customer' | 'tool' | 'ok' | 'bad' | 'wait' | 'muted';
const TONE: Record<Tone, string> = {
  ai: 'text-action', bot: 'text-ink-2', customer: 'text-ink', tool: 'text-warn', ok: 'text-ok', bad: 'text-bad', wait: 'text-ink-3', muted: 'text-ink-3',
};
type Line = { icon: typeof Check; tone: Tone; text: string } | null;

// Events of the same customer turn, after or before `e` (a customer message starts a new turn).
function sameTurn(e: TimelineEvent, all: TimelineEvent[], dir: 'after' | 'before') {
  const i = all.indexOf(e);
  const out: TimelineEvent[] = [];
  for (let j = dir === 'after' ? i + 1 : i - 1; j >= 0 && j < all.length; j += dir === 'after' ? 1 : -1) {
    if (all[j].type === 'customer_message') break;
    out.push(all[j]);
  }
  return out;
}

function sentence(e: TimelineEvent, all: TimelineEvent[], messages: Map<string, TimelineMessage>, costs: Map<string, number | null>): Line {
  const cost = (id?: string) => (id && costs.has(String(id)) ? ` · ${usd(costs.get(String(id)))}` : '');
  const d = e.data ?? {};
  switch (e.type) {
    case 'message_sent': return { icon: MessageSquare, tone: 'bot', text: `Bot: “${cut(String(d.text ?? ''), 90)}”` };
    case 'signal': // a teammate's run panel control
      return { icon: User, tone: 'muted', text: `${String(d.type).replace('_step', '')}${d.by ? ` by ${d.by}` : ''}` };
    case 'customer_message': {
      const m = messages.get(d.messageId);
      const files = m?.attachments?.length ? ` · ${m.attachments.length} attachment${m.attachments.length > 1 ? 's' : ''}` : '';
      return { icon: User, tone: 'customer', text: m ? `Customer: “${cut(m.text || '(no text)', 90)}”${files}` : 'Customer wrote' };
    }
    // One line per supervisor call: its decision, with the cost of that call (logged later, once the call finished).
    case 'supervisor_delegated': {
      const done = sameTurn(e, all, 'after').find((x) => x.type === 'supervisor_replied');
      return { icon: GitBranch, tone: 'ai', text: `Supervisor → workflow agent (${String(d.intent).replace(/_/g, ' ')})${d.note ? `: ${cut(d.note, 50)}` : ''}${cost(done?.data?.usage_id)}` };
    }
    case 'agent_replied': return { icon: MessageSquare, tone: 'muted', text: `Workflow agent replied in ${(Number(d.ms) / 1000).toFixed(1)} s${d.tokens ? ` · ${d.tokens} tokens` : ''}${cost(d.usage_id)}` };
    case 'supervisor_replied': // shown on its decision line; a turn it answered itself gets its own line
      return sameTurn(e, all, 'before').some((x) => x.type === 'supervisor_delegated') ? null
        : { icon: GitBranch, tone: 'ai', text: `Supervisor replied directly${d.tokens ? ` · ${d.tokens} tokens` : ''}${cost(d.usage_id)}` };
    case 'step_completed': return { icon: Check, tone: 'ai', text: `Step done: ${cut(String(d.summary ?? ''), 70)}` };
    case 'move_rejected': return { icon: AlertTriangle, tone: 'bad', text: `Engine rejected ${d.tool}: ${cut(String(d.reason ?? ''), 60)}` };
    case 'workflow_switched': return { icon: GitBranch, tone: 'ai', text: `Switching to ${d.to}` };
    case 'handoff': return { icon: AlertTriangle, tone: 'bad', text: `Handoff: ${cut(String(d.reason ?? ''), 60)}` };
    case 'bubble_fixed': return { icon: MessageSquare, tone: 'muted', text: d.by === 'server' ? 'Missing bubble text added by the server' : `Reply rewritten to include the bubble text${cost(d.usage_id)}` };
    case 'approval_decided': return { icon: ShieldCheck, tone: d.approved ? 'ok' : 'bad', text: `Team ${d.approved ? 'approved' : 'rejected'}` };
    case 'yielded': return { icon: GitBranch, tone: 'ai', text: `Workflow agent handed back: ${cut(String(d.reason ?? ''), 60)}` };
    case 'reply_dropped': return { icon: MessageSquare, tone: 'muted', text: 'Reply not sent: the customer wrote again, the next reply answers both' };
    case 'agent_turn': return null;
    case 'waiting': {
      // "Waiting" right after the question it waits on adds nothing; keep it for approvals and silent waits.
      if (d.for === 'approval') return { icon: Clock, tone: 'wait', text: 'Waiting for the team to approve' };
      const asked = all.some((x) => x.type === 'message_sent' && x.node_id === e.node_id && Math.abs(+new Date(x.at) - +new Date(e.at)) < 5000);
      return asked ? null : { icon: Clock, tone: 'wait', text: `Waiting for the customer${d.expects?.length ? ` (${d.expects.join(', ')})` : ''}` };
    }
    case 'action_called': return null; // the result line says it ran
    case 'action_result':
      return d.ok ? { icon: Wrench, tone: 'tool', text: `Tool ran successfully` } : { icon: Wrench, tone: 'bad', text: `Tool failed: ${cut(String(d.error ?? ''), 60)}` };
    case 'approval_requested': return { icon: ShieldCheck, tone: 'wait', text: `Asked the team to approve: ${cut(String(d.summary ?? ''), 60)}` };
    case 'input_received': {
      const [k, v] = Object.entries(d).find(([key]) => key !== 'format') ?? [];
      return { icon: Save, tone: 'ok', text: k ? `Saved ${k} = ${value(v)}` : 'Answer saved' };
    }
    case 'input_invalid': return { icon: X, tone: 'bad', text: d.reason === 'not an answer to the question' ? "Reply wasn't an answer, asked again" : "Answer didn't fit, asked again" };
    case 'response_saved': {
      const saved = Object.entries(d.saved ?? {}).map(([k, v]) => `${k} = ${value(v)}`);
      const missing = (d.missing ?? []) as string[];
      return { icon: Save, tone: missing.length && !saved.length ? 'bad' : 'ok', text: [saved.length ? `Saved ${saved.join(', ')}` : '', missing.length ? `not in response: ${missing.join(', ')}` : ''].filter(Boolean).join(' · ') };
    }
    case 'case_chosen': return { icon: GitBranch, tone: 'ai', text: d.case_id ? `Condition matched: ${cut(String(d.reason ?? ''), 70)}` : 'No condition matched' };
    case 'goto_jumped': return { icon: CornerUpLeft, tone: 'ai', text: `Went back (try ${d.visit} of ${d.max_visits ?? '∞'})` };
    case 'goto_limit': return { icon: AlertTriangle, tone: 'bad', text: 'Repeat limit reached, handed to a person' };
    case 'reminder_sent': return { icon: Clock, tone: 'wait', text: 'Sent a reminder' };
    case 'error': return { icon: AlertTriangle, tone: 'bad', text: `Error: ${cut(String(d.error ?? ''), 70)}` };
    case 'run_completed': return { icon: Check, tone: 'ok', text: 'Workflow finished' };
    case 'run_escalated': return { icon: AlertTriangle, tone: 'bad', text: `Handed to a person${d.reason ? `: ${cut(d.reason, 60)}` : ''}` };
    case 'run_expired': return { icon: Clock, tone: 'muted', text: 'Closed: the customer stopped replying' };
    case 'run_failed': return { icon: AlertTriangle, tone: 'bad', text: `Run failed${d.error ? `: ${cut(d.error, 60)}` : ''}` };
    case 'run_cancelled': return { icon: X, tone: 'muted', text: /switched to/.test(d.reason ?? '') ? 'Ended: switched workflow' : 'Run cancelled' };
    case 'run_started': return null; // the run header covers the start
    default: return null;
  }
}

// A run's end can be logged before its last reply; in the simple view the end comes last.
const ENDS = new Set(['run_completed', 'run_escalated', 'run_expired', 'run_failed', 'run_cancelled']);
const simpleOrder = (list: TimelineEvent[]) => [...list.filter((e) => !ENDS.has(e.type)), ...list.filter((e) => ENDS.has(e.type))];

// The whole conversation's timeline: a header per run (oldest first; a workflow switch starts a new run).
// Older runs start collapsed so the current one stays in focus. Plain sentences only; click a line for its raw event.
export function RunTimeline({ runs, events, messages = [], costs = new Map() }: { runs: TimelineRun[]; events: TimelineEvent[]; messages?: TimelineMessage[]; costs?: Map<string, number | null> }) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const ordered = [...runs].reverse(); // the API sends newest first
  const current = runs[0]?.id;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const labels = new Map(ordered.map((r) => [r.id, nodeLabels(r)]));

  const row = (e: TimelineEvent, line: NonNullable<Line>) => (
    <button key={e.id} type="button" onClick={() => setOpen(open === e.id ? null : e.id)} className="block w-full rounded-md px-1.5 py-1 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-action/40">
      <span className="flex items-start gap-2 text-xs">
        <line.icon size={13} className={`mt-px shrink-0 ${TONE[line.tone]}`} />
        <span className={`min-w-0 flex-1 ${line.tone === 'bot' ? 'text-ink-2' : line.tone === 'muted' ? 'text-ink-3' : 'text-ink'}`}>{line.text}</span>
        <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-3">{clock(e.at)}</span>
      </span>
      {open === e.id && <pre className="mt-1 overflow-auto rounded bg-canvas p-2 text-[11px] text-ink-2">{JSON.stringify(e.data, null, 2)}</pre>}
    </button>
  );

  return (
    <div>
      {ordered.map((r) => {
        const own = events.filter((e) => e.run_id === r.id);
        const isOpen = r.id === current || expanded.has(r.id);
        const runLabels = labels.get(r.id)!;
        // Simple view: consecutive events of the same block form one step box; run-level lines (e.g. the customer's reply)
        // join the step they belong to, and the run's ending gets its own line after the boxes.
        const steps: { node: string | null; items: { e: TimelineEvent; line: NonNullable<Line> }[] }[] = [];
        const tail: { e: TimelineEvent; line: NonNullable<Line> }[] = [];
        for (const e of simpleOrder(own)) {
          const line = sentence(e, own, byId, costs);
          if (!line) continue;
          if (ENDS.has(e.type)) { tail.push({ e, line }); continue; }
          const last = steps[steps.length - 1];
          if (last && (!e.node_id || e.node_id === last.node)) last.items.push({ e, line });
          else steps.push({ node: e.node_id, items: [{ e, line }] });
        }
        return (
          <div key={r.id} className="mb-1">
            {ordered.length > 1 && (
              <button type="button" onClick={() => r.id !== current && setExpanded((s) => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })}
                      className={`mb-1 flex w-full items-center gap-1.5 rounded-md bg-canvas px-2 py-1.5 text-left text-xs ${r.id === current ? 'cursor-default' : 'hover:bg-hover'}`}>
                {r.id !== current && <ChevronRight size={12} className={`shrink-0 text-ink-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />}
                <span className="min-w-0 truncate font-semibold text-ink">{r.workflow_name}</span>
                <span className="ml-auto shrink-0"><StatusChip status={r.status} /></span>
              </button>
            )}
            {isOpen && (
              // A vertical rail with a dot per step: reads as "what happened, in order", unlike the Steps cards above.
              <div className="relative ml-1.5 space-y-2 border-l-2 border-line pl-3.5 pt-0.5">
                {steps.map((st) => {
                  const label = st.node ? runLabels.get(st.node) : undefined;
                  return (
                    <div key={st.items[0].e.id} className="relative">
                      <span className="absolute -left-[21px] top-2 size-2.5 rounded-full border-2 border-panel bg-ink-3" />
                      <div className="rounded-md bg-canvas px-1 pb-0.5 pt-1">
                        {label && <div className="truncate px-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3" title={st.node ?? ''}>{label}</div>}
                        {st.items.map(({ e, line }) => row(e, line))}
                      </div>
                    </div>
                  );
                })}
                {tail.map(({ e, line }) => (
                  <div key={e.id} className="relative">
                    <span className={`absolute -left-[21px] top-2 size-2.5 rounded-full border-2 border-panel ${line.tone === 'ok' ? 'bg-ok' : line.tone === 'bad' ? 'bg-bad' : 'bg-ink-3'}`} />
                    {row(e, line)}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
