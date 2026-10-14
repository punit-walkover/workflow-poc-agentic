-- Run panel controls (pause / resume / cancel / retry) on agent runs go through the inbox too.
alter table ticket_event drop constraint ticket_event_kind_check;
alter table ticket_event add constraint ticket_event_kind_check check (kind in ('customer_message', 'approval_decided', 'timer', 'control'));
