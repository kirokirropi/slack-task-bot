-- Per-task reminder time ("Task: ... @ 2:30pm"). When set, the task is reminded daily at this
-- Philippine time instead of the default 8 AM / 12 PM / 3 PM schedule.
-- Replace <PROJECT_REF> below with your Supabase project ref before running.
alter table public.task_cards
  add column card_ts text,
  add column task_text text,
  add column posted_by text,
  add column remind_time time;
create index task_cards_remind_time_idx on public.task_cards (remind_time) where remind_time is not null;

-- Every minute: if an open task has a custom time equal to the current Philippine minute,
-- call the function. The function is not called at all when nothing is due.
select cron.schedule(
  'slack-task-custom-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/slack-task-bot?action=remind_custom',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'slack_bot_cron_secret')
    ),
    body := jsonb_build_object('time', to_char(now() at time zone 'Asia/Manila', 'HH24:MI'))
  )
  where exists (
    select 1 from public.task_cards c
    where to_char(c.remind_time, 'HH24:MI') = to_char(now() at time zone 'Asia/Manila', 'HH24:MI')
      and c.card_ts is not null
      and not exists (select 1 from public.completed_tasks d where d.task_ts = c.task_ts)
  );
  $$
);
