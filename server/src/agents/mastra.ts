// Mastra setup: storage (memory, threads) in our Postgres under schema "mastra", and the model from env.
// Not connected to customers yet; Stage 2 adds the workflow agents.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { config } from '../config';
import { trackedGenerate } from './usage';

// LLM_PROVIDER: openai (direct key), anthropic (direct key), or openai-compatible (LLM_BASE_URL, e.g. a GTWY endpoint later).
export function model() {
  const { provider, model: id, apiKey, baseUrl } = config.llm;
  if (!id || !apiKey) throw new Error('Set LLM_MODEL and LLM_API_KEY to use the agents');
  if (provider === 'anthropic') return createAnthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })(id);
  if (provider === 'openai-compatible') {
    if (!baseUrl) throw new Error('LLM_BASE_URL is required for openai-compatible');
    return createOpenAI({ apiKey, baseURL: baseUrl }).chat(id); // chat completions: what OpenAI-compatible gateways serve
  }
  return createOpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })(id);
}

export const storage = new PostgresStore({ id: 'ticket0-agentic', connectionString: config.databaseUrl, schemaName: 'mastra' });
export const memory = new Memory({ storage, options: { lastMessages: 20 } });

// Dev-only check that the model key, memory and usage table work end to end. Not a workflow agent.
const probe = new Agent({ id: 'probe', name: 'probe', instructions: 'Reply in one short sentence.', model: () => model(), memory });

export const mastra = new Mastra({ storage, agents: { probe } });

export async function probeChat(message: string, thread: string) {
  const agent = mastra.getAgent('probe');
  const out = await trackedGenerate(agent, message, { agent: 'probe', conversationId: null, runId: null }, { memory: { thread, resource: 'dev' } });
  return { text: out.text, usage: out.totalUsage };
}
