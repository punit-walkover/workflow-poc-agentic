-- When each model call started: the cost list follows the order the calls ran (a supervisor call starts before the
-- workflow agent it hands to, but finishes after it).
alter table llm_usage add column started_at timestamptz;

-- Past calls: start = recorded time minus the duration the timeline logged for that call.
update llm_usage u set started_at = u.created_at - ((e.data->>'ms')::int * interval '1 millisecond')
from run_event e
where e.type in ('agent_replied', 'supervisor_replied') and e.data->>'usage_id' = u.id::text and e.data->>'ms' is not null;
