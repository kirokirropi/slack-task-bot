-- Channels the bot watches for "Task:" messages. Completion alerts go to alerts_channel_id,
-- or to the task's own channel when it's null.
create table public.task_channels (
  channel_id text primary key,
  alerts_channel_id text,
  added_at timestamptz not null default now()
);
alter table public.task_channels enable row level security;

-- Optional: per-channel settings, e.g. send a channel's alerts elsewhere.
-- insert into public.task_channels (channel_id, alerts_channel_id) values ('<TASKS_CHANNEL_ID>', '<ALERTS_CHANNEL_ID>');
