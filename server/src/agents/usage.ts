import { Agent } from '@mastra/core/agent';
import { config } from '../config';
import { one } from '../db';
import { MODEL_PRICES } from './prices';

export interface UsageMeta { agent: string; conversationId: string | null; runId: string | null }
interface Tokens { inputTokens?: number; outputTokens?: number }

// Dollar cost from prices.ts (per 1M tokens); null when the model has no price there.
export function priceOf(model: string, input?: number | null, output?: number | null): number | null {
  const p = MODEL_PRICES[model];
  return p ? ((input ?? 0) * p.input + (output ?? 0) * p.output) / 1e6 : null;
}

const mastraModel = () => `${config.llm.provider}/${config.llm.model}`;

// One row per model call: who called, which model, tokens in and out, and cost (given by the gateway, or priced here).
export async function recordUsage(meta: UsageMeta, usage: Tokens | undefined, opts: { model?: string; cost?: number | null; startedAt?: Date; trace?: unknown } = {}) {
  const model = opts.model ?? mastraModel();
  const cost = opts.cost ?? priceOf(model, usage?.inputTokens, usage?.outputTokens);
  const row = await one<{ id: string }>(`insert into llm_usage (conversation_id, run_id, agent, model, input_tokens, output_tokens, cost_usd, started_at, trace)
                                         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [meta.conversationId, meta.runId, meta.agent, model, usage?.inputTokens ?? null, usage?.outputTokens ?? null, cost, opts.startedAt ?? new Date(),
     opts.trace === undefined ? null : JSON.stringify(opts.trace)]);
  return row!.id;
}

// agent.generate plus a usage row; every agent call goes through here. The result carries the row id (usageId).
// (options are Mastra's generate options: memory thread, requestContext, maxSteps…)
export async function trackedGenerate(agent: Agent, input: string | { role: 'user' | 'assistant'; content: string }[], meta: UsageMeta, options?: Record<string, unknown>) {
  const startedAt = new Date();
  const out = await agent.generate(input as any, options as any);
  return Object.assign(out, { usageId: await recordUsage(meta, out.totalUsage, { startedAt, trace: traceOf(out) }) });
}

// Per model round: the exact request body sent to the provider, and what it answered (text, tool calls, their results).
function traceOf(out: { steps?: any[]; text?: string }) {
  const json = (v: unknown) => { try { return typeof v === 'string' ? JSON.parse(v) : JSON.parse(JSON.stringify(v ?? null)); } catch { return v ?? null; } };
  return {
    rounds: (out.steps ?? []).map((s, i) => ({
      round: i + 1,
      request: json(s.request?.body),
      response: {
        text: s.text || null,
        tool_calls: (s.toolCalls ?? []).map((c: any) => json(c.payload ?? c)),
        tool_results: (s.toolResults ?? []).map((r: any) => json(r.payload ?? r)),
        finish_reason: s.finishReason ?? null,
        usage: json(s.usage),
      },
    })),
    final_text: out.text ?? null,
  };
}
