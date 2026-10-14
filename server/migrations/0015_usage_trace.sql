-- The full exchange of each model call: per round, the exact request sent to the provider and what came back.
alter table llm_usage add column trace jsonb;
