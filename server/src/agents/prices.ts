// Dollar price per 1M tokens, keyed by the model name llm_usage records (provider/model).
// Source: OpenAI API pricing page, Standard tier, short context, checked 2026-10-13.
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'openai/gpt-6-luna': { input: 0.10, output: 0.50 },
};
