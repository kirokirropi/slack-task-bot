# Slack Task Bot

A Slack bot for lightweight task tracking:

- Post a message starting with `Task:` in any channel the bot is in, and the bot posts a task card with a **✅ Mark as Done** button.
- Clicking the button marks the card done, adds a ✅ to the original message and posts a "Task completed" alert.
- At **7 AM and 3 PM Philippine time**, each channel gets one summary of its pending tasks, with links. A task with its own time (e.g. `every 3pm`) gets an individual reminder at that time instead. Scheduled posts run Monday to Friday only.

## How it's built

| Part | Where |
|---|---|
| Production bot (always on) | Supabase Edge Function: [`supabase/functions/slack-task-bot/index.ts`](supabase/functions/slack-task-bot/index.ts) |
| Reminder schedule, dedup tables | Supabase `pg_cron` and Postgres: [`supabase/migrations/`](supabase/migrations/) |
| Local fallback (runs on a PC, Socket Mode) | [`tools/slack_task_bot.py`](tools/slack_task_bot.py) |
| Setup guide and runbook | [`workflows/slack_task_alerts.md`](workflows/slack_task_alerts.md) |

## Setup

See [`workflows/slack_task_alerts.md`](workflows/slack_task_alerts.md) for the full step-by-step guide. In short:

1. Create a Slack app with the bot scopes `channels:history`, `groups:history`, `chat:write`, `reactions:write` and `users:read`, and subscribe to the events `message.channels` and `message.groups`.
2. Deploy the Edge Function to Supabase with JWT verification off. The function checks Slack's request signature itself.
3. Add the secrets `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` under Supabase > Edge Functions > Secrets.
4. Run the SQL in `supabase/migrations/`, replacing `<PROJECT_REF>` with your project ref.
5. Set the Slack app's Event Subscriptions and Interactivity Request URL to `https://<PROJECT_REF>.supabase.co/functions/v1/slack-task-bot`.
6. Invite the bot to a channel with `/invite @your-bot`.

Secrets are never stored in this repo. For the local version, copy `.env.example` to `.env` and fill it in.
