-- Dollar cost per model call: GTWY reports it; Mastra calls are priced from src/agents/prices.ts when recorded.
alter table llm_usage add column cost_usd numeric;
