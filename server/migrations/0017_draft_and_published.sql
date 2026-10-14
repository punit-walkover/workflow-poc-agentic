-- A workflow has two states on one row: the draft (graph, when_to_use, action_keys) and the published copy.
-- Publishing overwrites the published copy; there is no version history. A run keeps the graph it started on.

alter table workflow add column published_graph jsonb, add column published_when_to_use text,
  add column published_action_keys text[] not null default '{}', add column published_at timestamptz;
update workflow w set published_graph = v.graph, published_when_to_use = v.when_to_use, published_action_keys = v.action_keys,
  published_at = v.published_at
from workflow_version v where v.id = w.published_version_id;

alter table workflow_run add column workflow_id uuid references workflow (id), add column workflow_name text, add column graph jsonb;
update workflow_run r set workflow_id = v.workflow_id, workflow_name = v.name, graph = v.graph
from workflow_version v where v.id = r.workflow_version_id;
alter table workflow_run alter column workflow_id set not null, alter column workflow_name set not null, alter column graph set not null,
  drop column workflow_version_id;

alter table workflow drop column published_version_id;
drop table workflow_version;
