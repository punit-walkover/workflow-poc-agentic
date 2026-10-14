-- Trim the schema to what the agentic POC uses.

-- Left by removed parts: the DBOS runner's checkpoints, the GTWY agent id, viaSocket app connections (tools are flows now).
drop schema if exists dbos cascade;
drop table if exists app_setting;
drop table if exists app_connection;

-- Actions are viaSocket flows or built-ins; the old app-action fields and the never-set subject/amount fields go.
alter table action drop constraint action_source_check;
alter table action add constraint action_source_check check (source in ('builtin', 'viasocket_flow'));
alter table action drop column via_service_id, drop column via_app_name, drop column via_action_version_id, drop column via_action_name,
  drop column input_template, drop column subject_field, drop column amount_field, drop column kind;
alter table action_run drop column subject_ref, drop column amount_minor;
alter table approval_task drop column amount_minor;

-- A workflow is its canvas graph: the old list form (steps), the unused template and the stored agent map go.
update workflow set graph = '{"start":"start","groups":[{"id":"start","title":"Start","x":0,"y":0,"items":[]}],"edges":[],"variables":[]}'::jsonb
  where graph is null;
alter table workflow drop column template, drop column steps, alter column graph set not null;
alter table workflow_version drop column steps, drop column agent_map, alter column graph set not null;

-- Every run is an agent run.
alter table workflow_run drop column engine;

-- One timestamp per model call: when it started.
update llm_usage set started_at = created_at where started_at is null;
drop index if exists llm_usage_conversation;
alter table llm_usage drop column created_at, alter column started_at set default now(), alter column started_at set not null;
create index llm_usage_conversation on llm_usage (conversation_id, started_at);
