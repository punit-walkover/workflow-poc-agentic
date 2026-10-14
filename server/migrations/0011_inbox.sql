-- Per-ticket event inbox: customer messages, approval decisions and timers, handled one at a time per conversation.
create table ticket_event (
  id               bigserial primary key,
  conversation_id  uuid not null references conversation (id) on delete cascade,
  kind             text not null check (kind in ('customer_message', 'approval_decided', 'timer')),
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending' check (status in ('pending', 'working', 'done', 'failed')),
  error            text,
  created_at       timestamptz not null default now(),
  done_at          timestamptz
);

create index ticket_event_pending on ticket_event (conversation_id, id) where status in ('pending', 'working');
