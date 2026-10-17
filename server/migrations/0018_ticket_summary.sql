-- A conversation is the ticket. It is created with the customer's first message,
-- and `summary` says why it was opened: the supervisor's reason when it first starts a workflow (set once).
alter table conversation add column summary text;
