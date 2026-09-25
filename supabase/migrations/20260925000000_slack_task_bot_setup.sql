-- Setup for the slack-task-bot Supabase project.
-- Replace <PROJECT_REF> below with your Supabase project ref before running.

-- Dedup tables: one row per task card created / task completed (guards Slack retries and double clicks).
create table public.task_cards (
  task_ts text primary key,
  created_at timestamptz not null default now()
);
create table public.completed_tasks (
  task_ts text primary key,
  completed_by text,
  completed_at timestamptz not null default now()
);
-- Only the Edge Function (service role) touches these; no public access.
alter table public.task_cards enable row level security;
alter table public.completed_tasks enable row level security;

-- Random secret the scheduler sends to the function, generated and kept inside Vault.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'slack_bot_cron_secret');

create or replace function public.slack_bot_cron_secret()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'slack_bot_cron_secret'
$$;
revoke all on function public.slack_bot_cron_secret() from public, anon, authenticated;
grant execute on function public.slack_bot_cron_secret() to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net schema extensions;

-- 8 AM, 12 PM, 3 PM Philippine time (UTC+8) = 00:00, 04:00, 07:00 UTC.
select cron.schedule(
  'slack-task-reminders',
  '0 0,4,7 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/slack-task-bot?action=remind',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'slack_bot_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
