// Env reads in one place; boot refuses without the database.
if (!process.env.DATABASE_URL) throw new Error('Missing env DATABASE_URL');

export const config = {
  port: Number(process.env.PORT || 4011),
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:4010').split(',').map((s) => s.trim()),
  databaseUrl: process.env.DATABASE_URL,
  // Agents (Mastra). Optional at boot; required when an agent is called.
  llm: {
    provider: (process.env.LLM_PROVIDER || 'openai') as 'openai' | 'anthropic' | 'openai-compatible',
    model: process.env.LLM_MODEL || '',
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || '',
  },
  devEndpoints: process.env.DEV_ENDPOINTS === '1', // /dev/* routes for calling wf_* tools by hand
  remindAfterSec: Number(process.env.REMIND_AFTER_SEC || 120),
  expireAfterSec: Number(process.env.EXPIRE_AFTER_SEC || 600),
  approvalTimeoutSec: Number(process.env.APPROVAL_TIMEOUT_SEC || 1800),
  maxVisits: 100, // a loop's repeat limit can be 1 to this
  maxGraphSteps: 50,
};
