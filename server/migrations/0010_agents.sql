-- Agentic POC: which engine drives a run, the read-only map agents get, and token usage per model call.

alter table workflow_run add column engine text not null default 'runner' check (engine in ('runner', 'agent'));

-- Built from the canvas on publish (server/src/engine/map.ts).
alter table workflow_version add column agent_map jsonb;

create table llm_usage (
  id               bigserial primary key,
  conversation_id  uuid references conversation (id) on delete cascade,
  run_id           uuid references workflow_run (id) on delete set null,
  agent            text not null,
  model            text not null,
  input_tokens     integer,
  output_tokens    integer,
  created_at       timestamptz not null default now()
);

create index llm_usage_conversation on llm_usage (conversation_id, created_at);
