# Slack Task → Done Alerts

## Objective
Every message in the tasks channel that starts with `Task:` becomes a task. Other messages are ignored. The bot posts a separate task card in the channel (not a thread reply). The card shows the task, who posted it, a link to the original message and a **✅ Mark as Done** button. Clicking it:
1. Changes the card to "Done by @user at <time>" and removes the button
2. Adds a ✅ reaction to the original message
3. Posts a "Task completed" alert, with a link back to the task, in the alerts channel

## Where it runs (production): Supabase, always on
- **Edge Function** `slack-task-bot` in Supabase project **slack-task-bot** (Singapore region). Find the project ref in the Supabase dashboard URL. Source: `supabase/functions/slack-task-bot/index.ts`.
- **Request URL** (Slack Event Subscriptions and Interactivity): `https://<PROJECT_REF>.supabase.co/functions/v1/slack-task-bot`
- **Reminders:** a `pg_cron` job, `slack-task-reminders`, runs `0 7,23 * * *` UTC (7 AM and 3 PM Philippine time) and calls the function with `?action=remind`. The call is authenticated with a random secret in Supabase Vault (`slack_bot_cron_secret`).
- **Secrets:** set in the Supabase dashboard under Edge Functions > Secrets: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and optionally `REMINDER_LOOKBACK_DAYS` and `SLACK_USER_TOKEN`.
- **Removing the original `Task:` message** (optional, avoids duplicate text in the channel). A bot can only delete its own messages, so this needs a **workspace admin or owner's user token**:
  1. In the Slack app, go to **OAuth & Permissions**, then **User Token Scopes**, and add `chat:write`.
  2. Click **Reinstall to Workspace**. The installer must be a workspace admin or owner.
  3. Copy the **User OAuth Token** (`xoxp-…`) and add it in Supabase as the secret `SLACK_USER_TOKEN`.

  When this is set, the bot deletes each `Task:` message right after posting its card. The card keeps the full text and "Posted by @person". If it isn't set, the original message stays and gets a ✅ when the task is done.
- **Completed cards:** the card text is struck through line by line, because Slack strikethrough doesn't span line breaks, and it shows "Posted by … · ✅ Done by … at …". `TASKS_CHANNEL_ID` and `ALERTS_CHANNEL_ID` are no longer used by the Supabase version.
- **Watched channels:** every channel the bot is a member of. To add a channel, run `/invite @slack_alert` in it; nothing else is needed. To stop it in a channel, remove the bot with `/remove @slack_alert`. DMs are ignored.
  - Completion alerts go to the task's own channel. To send one channel's alerts elsewhere, add a row in the Supabase SQL editor: `insert into task_channels (channel_id, alerts_channel_id) values ('C<tasks>', 'C<alerts>');`
  - Reminders check every channel that had a task card in the last 30 days, plus any channel listed in `task_channels`. Each card's channel is recorded in `task_cards.channel_id`.
- **Tables:** `task_cards` and `completed_tasks` stop Slack retries and double clicks from creating duplicate cards or alerts.
- **Logs:** Supabase dashboard > Edge Functions > slack-task-bot > Logs.
- **Changing the default reminder times:** use `cron.alter_job` / `cron.schedule` in SQL. Times are in UTC, so subtract 8 hours from Philippine time.
- **Custom time per task:** put a reminder time anywhere in the task and that task is reminded **every day at that time instead of** 7 AM and 3 PM, until it's marked done. Tasks without a time keep the default schedule.
  - Accepted phrasing (always Philippine time): `every 3pm`, `every day at 10am`, `everyday 9am`, `daily at 4:15 PM`, `@ 2:30pm`, `@ 14:30`, `remind me at 9am`.
  - Examples: `Task: Follow up @Ana every 3pm about the screenshots` and `Task: Pay supplier invoice @ 2:30pm`. The card shows "⏰ Reminder daily at …". A time at the very end is removed from the task text; one mid-sentence is left in place.
  - A plain `at 3pm` is **not** a reminder time (`Meet at 3pm with team` stays normal text), because it usually describes the task rather than when to be reminded. Use `every`, `daily`, `@` or `remind me at`. An invalid time (e.g. `every 13pm`) is ignored, and the task uses the default schedule.
  - Only the first reminder time in a task is used.
  - To change a posted task's time, update `task_cards.remind_time` for its `task_ts` in SQL.
  - How it works: the `pg_cron` job `slack-task-custom-reminders` runs every minute in SQL. It only calls the function (`?action=remind_custom`) when an open task's `task_cards.remind_time` matches the current minute. The times are stored in `task_cards.remind_time`.
- **Free-plan caveat:** Supabase can pause free projects after a stretch of low activity. If the bot goes silent, open the project in the dashboard and click **Restore**.
- Database setup is recorded in `supabase/migrations/`.

## Local fallback
`tools/slack_task_bot.py` (Slack Bolt, Socket Mode) is the original version that runs on a PC. Only use it with Socket Mode turned **on** in the Slack app, and never alongside the Supabase version, or reminders will be posted twice.

## Required inputs (`.env`)
| Key | Where to find it |
|---|---|
| `SLACK_BOT_TOKEN` | App > OAuth & Permissions > Bot User OAuth Token (`xoxb-`) |
| `SLACK_APP_TOKEN` | App > Basic Information > App-Level Tokens, with scope `connections:write` (`xapp-`) |
| `TASKS_CHANNEL_ID` | Channel details > About tab (bottom) |
| `ALERTS_CHANNEL_ID` | Same as above, for the alerts channel |

## One-time Slack app setup
All settings pages are in the **left sidebar** of your app's page at api.slack.com.

### Step 0: Prepare your files and channels
1. In the project folder, copy `.env.example` and rename the copy to `.env`. You'll paste values into it as you go.
2. In Slack, create two channels if you don't already have them, e.g. `#tasks` and `#tasks-done`.

### Step 1: Create the app
1. Open https://api.slack.com/apps and sign in.
2. Click the green **Create New App** button (top right).
3. Choose **From scratch**.
4. **App Name:** type e.g. `Task Bot`. This is the name you'll `/invite` later.
5. **Pick a workspace:** pick your workspace.
6. Click **Create App**. You'll land on the app's **Basic Information** page.

### Step 2: Turn on Socket Mode and get `SLACK_APP_TOKEN`
1. In the left sidebar, click **Socket Mode**.
2. Turn on **Enable Socket Mode**.
3. A popup asks you to create an app-level token:
   - **Token Name:** type `socket`
   - The `connections:write` scope is already added. If it isn't, click **Add Scope** and choose it.
   - Click **Generate**.
4. Copy the token that starts with `xapp-`.
5. In `.env`, paste it: `SLACK_APP_TOKEN=xapp-...`
6. Click **Done**.

> Lost it? Go to **Basic Information**, scroll to **App-Level Tokens** and click the token name to see it again.

### Step 3: Add bot permissions (scopes)
1. In the left sidebar, click **OAuth & Permissions**.
2. Scroll down to **Scopes**, then to **Bot Token Scopes**. Not *User* Token Scopes.
3. Click **Add an OAuth Scope** once for each of these five:
   - `channels:history`: read messages in public channels
   - `groups:history`: read messages in private channels
   - `chat:write`: post and edit messages
   - `reactions:write`: add the ✅ reaction
   - `users:read`: look up user names
4. Changes save automatically.

### Step 4: Subscribe to message events
1. In the left sidebar, click **Event Subscriptions**.
2. Turn on **Enable Events**. No Request URL is needed because Socket Mode is on.
3. Expand **Subscribe to bot events**.
4. Click **Add Bot User Event** and add:
   - `message.channels`
   - `message.groups`
5. Click **Save Changes** at the bottom of the page. **Don't skip this step.**

### Step 5: Turn on Interactivity (for the button)
1. In the left sidebar, click **Interactivity & Shortcuts**.
2. Turn on **Interactivity**.
3. Leave the Request URL blank. Socket Mode handles it.
4. Click **Save Changes** if the button appears.

### Step 6: Install the app and get `SLACK_BOT_TOKEN`
1. In the left sidebar, click **Install App** (or **OAuth & Permissions**).
2. Click **Install to <Your Workspace>**, then **Allow**.
3. Copy the **Bot User OAuth Token** that starts with `xoxb-`.
4. In `.env`, paste it: `SLACK_BOT_TOKEN=xoxb-...`

> If you change scopes or events later, Slack shows a yellow banner. Click **reinstall your app** in that banner, or the changes won't take effect.

### Step 7: Get the channel IDs
1. In Slack, open your tasks channel.
2. Click the channel name at the top.
3. On the **About** tab, scroll to the bottom and copy the **Channel ID** (starts with `C`).
4. In `.env`, paste it: `TASKS_CHANNEL_ID=C...`
5. Repeat for the alerts channel: `ALERTS_CHANNEL_ID=C...`
6. Save `.env`.

### Step 8: Invite the bot to both channels
1. In the tasks channel, type `/invite @Task Bot` (use your app name) and press Enter.
2. Do the same in the alerts channel.

> If you skip this, the bot won't see task messages, and posting fails with `not_in_channel`.

### Step 9: Check your `.env`
It should look like this, with no quotes and no spaces around `=`:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
TASKS_CHANNEL_ID=C...
ALERTS_CHANNEL_ID=C...
```

### Troubleshooting
| Symptom | Fix |
|---|---|
| `KeyError: 'SLACK_BOT_TOKEN'` on start | `.env` is missing or misnamed. It must be exactly `.env` in the project folder. |
| `invalid_auth` | Wrong token, or the two tokens are swapped. The bot token is `xoxb-` and the app token is `xapp-`. |
| Bot runs but doesn't reply to messages | Check that you saved in Step 4, that the bot was invited (Step 8), and that `TASKS_CHANNEL_ID` is right. |
| `missing_scope` error | Add the scope (Step 3), then **reinstall the app** (Step 6). |
| Button shows "This app is not responding" | The script isn't running, or Interactivity is off (Step 5). |

## Run
```
pip install -r requirements.txt
python tools/slack_task_bot.py
```
The console should show `⚡️ Bolt app is running!`. Leave it running. Buttons only work while the script is running.

## Usage
- Post a task in the tasks channel starting with `Task:`, e.g. `Task: Pay supplier invoice #123`. Any capitalisation works, and bold `*Task:*` works too.
- Messages that don't start with `Task:` are normal chat and are ignored.
- Click **✅ Mark as Done** on the bot's task card in the channel

## Daily reminders
- Every day at **7:00 AM and 3:00 PM Philippine time**, the bot posts a separate channel message (not a thread reply) for every task that isn't done yet: "⏰ Reminder: @poster this task is still not done · open task", followed by the task text. "open task" links to the task's card.
- It checks tasks from the last 30 days. You can change this with `REMINDER_LOOKBACK_DAYS` in `.env`, and the times with `REMINDER_HOURS` (24-hour clock, comma-separated, default `7,15`).
- If the PC was off at a reminder time, the bot sends **one** catch-up reminder when it starts. For example, started at 1 PM, it sends the 12 PM reminder once rather than both 8 AM and 12 PM.
- Each reminder time goes out only once, even after restarts. The last one sent is stored in `.tmp/last_reminder_slot.txt`.
- A task counts as open while its thread card still has the **Mark as Done** button.

## Edge cases and notes
- Thread replies, edits, and bot or system messages are ignored, so they don't create tasks.
- A double click doesn't produce a second alert. The card loses its button and the bot remembers completed tasks while it runs.
- A click made while the bot is offline gives the Slack error "This app is not responding". Start the bot and click again.
- The lookback timestamp sent to Slack must have 6 decimal places or fewer. With more, Slack silently returns no messages, and reminders find nothing.
- Task text stored in the button is cut to 1500 characters because Slack limits button values to 2000.
- `Task:` messages posted while the bot was offline get their card when the bot starts again (startup catch-up, same 30-day window). Each card is tagged with its original message's timestamp (`block_id` `task:<ts>`), so no task gets a second card.
- **Most common problem:** the bot isn't running. Everything (cards, buttons, reminders) stops when the script stops. That includes when the Claude session that launched it ends.
