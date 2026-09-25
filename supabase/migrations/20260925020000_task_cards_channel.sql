-- Remember which channel each task card is in, so reminders cover every channel that has tasks.
alter table public.task_cards add column channel_id text;
create index task_cards_channel_created_idx on public.task_cards (channel_id, created_at);
