'use client';

import { Plus, Repeat2, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { StepEditor } from './step-editor';
import {
  addListCase, appendStep, DEFAULT_GOTO_VISITS, gotoTargets, insertAfter, ListStep, newListCondition, newListGoto,
  newListStep, removeListCase, removeStep, replaceStep, setCaseCondition, updateStep,
} from '@/lib/list-flow';
import { MAX_VISITS } from '@/lib/graph';

interface Props {
  steps: ListStep[];
  onChange: (steps: ListStep[]) => void;
  actions: { key: string; name: string; enabled: boolean }[];
  variables: { key: string; label: string }[];
}

const KIND = { if: 'If', else_if: 'Else if', else: 'Else' } as const;

// Builder 2's numbered list of steps. Enter adds a step below, Backspace on an empty step removes it, and the @ menu
// turns a step into a Condition (If / Else) or a Go to step.
export function ListBuilder({ steps, onChange, actions, variables }: Props) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const targets = gotoTargets(steps);

  const add = (after?: string, caseId?: string) => {
    const s = newListStep();
    onChange(after ? insertAfter(steps, after, s) : appendStep(steps, s, caseId));
    setFocusId(s.id);
  };
  const remove = (id: string, list: ListStep[], index: number) => {
    onChange(removeStep(steps, id));
    const prev = list[index - 1];
    if (prev?.type === 'step') setFocusId(prev.id);
  };

  const renderList = (list: ListStep[], prefix: string, caseId?: string) => (
    <ol className="space-y-1">
      {list.map((s, i) => {
        const label = `${prefix}${i + 1}`;
        const common = { actions, variables, onEnter: () => add(s.id) };
        const trash = (
          <button type="button" title="Remove step" onClick={() => remove(s.id, list, i)}
                  className="invisible mt-1 shrink-0 rounded p-0.5 text-ink-3 hover:bg-hover hover:text-bad group-hover/s:visible"><Trash2 size={14} /></button>
        );
        if (s.type === 'step') return (
          <li key={s.id} className="group/s flex items-start gap-2 rounded-md px-2 py-1 hover:bg-hover/60">
            <span className="w-8 shrink-0 pt-0.5 text-right text-ink-2 tabular-nums">{label}.</span>
            <div className="min-w-0 flex-1 pt-0.5">
              <StepEditor {...common} content={s.content} placeholder="Describe this step…" autoFocus={focusId === s.id}
                          onChange={(content) => onChange(updateStep(steps, s.id, (x) => (x.type === 'step' ? { ...x, content } : x)))}
                          onBackspaceEmpty={() => remove(s.id, list, i)}
                          onCondition={() => onChange(replaceStep(steps, s.id, newListCondition()))}
                          onGoto={() => onChange(replaceStep(steps, s.id, newListGoto()))} />
            </div>
            {trash}
          </li>
        );
        if (s.type === 'goto') return (
          <li key={s.id} className="group/s flex items-start gap-2 rounded-md px-2 py-1 hover:bg-hover/60">
            <span className="w-8 shrink-0 pt-0.5 text-right text-ink-2 tabular-nums">{label}.</span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 pt-0.5">
              <span className="flex items-center gap-1 font-medium text-brand"><Repeat2 size={14} /> Go to step</span>
              <select value={s.target} onChange={(e) => onChange(updateStep(steps, s.id, (x) => (x.type === 'goto' ? { ...x, target: e.target.value } : x)))}
                      className="rounded-md border border-line bg-panel px-2 py-0.5 text-sm outline-none focus:border-ink-3">
                <option value="">choose a step…</option>
                {targets.map((t) => <option key={t.step.id} value={t.step.id}>{t.label}. {summary(t.step)}</option>)}
              </select>
              <span className="text-ink-2">up to</span>
              <input type="number" min={1} max={MAX_VISITS} value={s.maxVisits}
                     onChange={(e) => onChange(updateStep(steps, s.id, (x) => (x.type === 'goto' ? { ...x, maxVisits: Math.max(1, Math.min(MAX_VISITS, Number(e.target.value) || DEFAULT_GOTO_VISITS)) } : x)))}
                     className="w-14 rounded-md border border-line bg-panel px-2 py-0.5 text-sm outline-none focus:border-ink-3" />
              <span className="text-ink-2">times</span>
            </div>
            {trash}
          </li>
        );
        const hasElse = s.cases.some((c) => c.kind === 'else');
        return (
          <li key={s.id} className="group/s flex items-start gap-2 rounded-md px-2 py-1">
            <span className="w-8 shrink-0 pt-0.5 text-right text-ink-2 tabular-nums">{label}.</span>
            <div className="min-w-0 flex-1 space-y-1">
              {s.cases.map((c, ci) => (
                <div key={c.id} className="group/c rounded-lg border border-line bg-panel">
                  <div className="flex items-start gap-2 px-2 py-1">
                    <span className="mt-1 shrink-0 rounded bg-brand-soft px-1.5 text-[10px] font-semibold uppercase text-brand">{KIND[c.kind]}</span>
                    <div className="min-w-0 flex-1 pt-0.5">
                      {c.kind === 'else'
                        ? <span className="text-ink-3">otherwise</span>
                        : <StepEditor content={c.condition} placeholder="When…" actions={actions} variables={variables}
                                      onChange={(cond) => onChange(setCaseCondition(steps, c.id, cond))} />}
                    </div>
                    {c.kind !== 'if' && (
                      <button type="button" title="Remove case" onClick={() => onChange(removeListCase(steps, s.id, c.id))}
                              className="invisible mt-1 text-ink-3 hover:text-bad group-hover/c:visible"><X size={13} /></button>
                    )}
                  </div>
                  <div className="border-t border-line px-1 py-1">
                    {renderList(c.steps, `${label}${String.fromCharCode(97 + ci)}.`, c.id)}
                    <button type="button" onClick={() => add(undefined, c.id)}
                            className="ml-9 flex items-center gap-1 rounded px-1 py-0.5 text-xs text-ink-3 hover:bg-hover hover:text-ink"><Plus size={12} /> Add a step here</button>
                  </div>
                </div>
              ))}
              <div className="flex gap-1 text-xs">
                <button type="button" onClick={() => onChange(addListCase(steps, s.id, 'else_if'))} className="rounded px-1.5 py-0.5 text-ink-3 hover:bg-hover hover:text-ink">+ Else if</button>
                {!hasElse && <button type="button" onClick={() => onChange(addListCase(steps, s.id, 'else'))} className="rounded px-1.5 py-0.5 text-ink-3 hover:bg-hover hover:text-ink">+ Else</button>}
              </div>
            </div>
            {trash}
          </li>
        );
      })}
    </ol>
  );

  return (
    <div>
      {renderList(steps, '')}
      <button type="button" onClick={() => add()} className="mt-1 ml-2 flex items-center gap-1.5 rounded px-2 py-1 text-ink-2 hover:bg-hover hover:text-ink">
        <Plus size={15} /> Add
      </button>
    </div>
  );
}

// First words of a step, for the "Go to step" list.
function summary(s: ListStep): string {
  if (s.type !== 'step') return '';
  const t = s.content.map((p) => (p.t === 'text' ? p.v : p.t === 'action' ? `@${p.key}` : `{{${p.key}}}`)).join('').trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t || '(empty)';
}
