"""Slack task bot: turns messages in a tasks channel into tasks with a
"Mark as Done" button, and posts an alert when a task is completed.
Every day at 8 AM, 12 PM and 3 PM Philippine time it reminds open tasks in their thread.

Runs locally over Socket Mode (no public URL needed).
Usage: python tools/slack_task_bot.py
"""

import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

load_dotenv()

SLACK_BOT_TOKEN = os.environ["SLACK_BOT_TOKEN"]
SLACK_APP_TOKEN = os.environ["SLACK_APP_TOKEN"]
TASKS_CHANNEL_ID = os.environ["TASKS_CHANNEL_ID"]
ALERTS_CHANNEL_ID = os.environ["ALERTS_CHANNEL_ID"]

DONE_ACTION_ID = "mark_task_done"
# Only messages starting with "Task:" (any case, optionally bold/italic) are tasks.
TASK_PREFIX_RE = re.compile(r"^\s*[*_]*task\s*:\s*[*_]*\s*(.+)$", re.IGNORECASE | re.DOTALL)
DONE_EMOJI = "white_check_mark"
# Slack caps a button value at 2000 chars; keep room for the JSON wrapper.
MAX_TASK_TEXT_IN_VALUE = 1500

# Daily reminders. Philippines is UTC+8 with no daylight saving.
PH_TZ = timezone(timedelta(hours=8))
# Hours of the day (24h, PH time) to send reminders: 8 AM, 12 PM, 3 PM.
REMINDER_HOURS = sorted(int(h) for h in os.environ.get("REMINDER_HOURS", "8,12,15").split(","))
REMINDER_LOOKBACK_DAYS = int(os.environ.get("REMINDER_LOOKBACK_DAYS", "30"))
REMINDER_CHECK_SECONDS = 30
# Remembers the last reminder slot sent ("YYYY-MM-DD HH"), so restarts don't send it twice.
LAST_REMINDER_FILE = Path(__file__).resolve().parent.parent / ".tmp" / "last_reminder_slot.txt"
SLOT_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}$")
# Each card's first block_id is "task:<original message ts>", so startup catch-up can tell which tasks have cards.
TASK_BLOCK_PREFIX = "task:"

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("slack_task_bot")

app = App(token=SLACK_BOT_TOKEN)

# Guards against Slack delivering a second click before the card is updated.
_completed_tasks: set[str] = set()


def build_task_blocks(
    task_text: str, channel: str, task_ts: str, user_id: str | None = None, permalink: str = ""
) -> list[dict]:
    value = json.dumps(
        {"channel": channel, "ts": task_ts, "user": user_id, "text": task_text[:MAX_TASK_TEXT_IN_VALUE]}
    )
    posted_by = f"Posted by <@{user_id}>" if user_id else "Task"
    if permalink:
        posted_by += f" · <{permalink}|view message>"
    return [
        {
            "type": "section",
            "block_id": f"{TASK_BLOCK_PREFIX}{task_ts}",
            "text": {"type": "mrkdwn", "text": f":memo: *Task:* {task_text}"},
        },
        {"type": "context", "elements": [{"type": "mrkdwn", "text": posted_by}]},
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "✅ Mark as Done", "emoji": True},
                    "style": "primary",
                    "action_id": DONE_ACTION_ID,
                    "value": value,
                }
            ],
        },
    ]


def build_done_blocks(task_text: str, user_id: str, task_ts: str) -> list[dict]:
    now = int(time.time())
    when = f"<!date^{now}^{{date_short_pretty}} at {{time}}|{time.strftime('%Y-%m-%d %H:%M')}>"
    return [
        {
            "type": "section",
            "block_id": f"{TASK_BLOCK_PREFIX}{task_ts}",
            "text": {"type": "mrkdwn", "text": f":memo: ~{task_text}~"},
        },
        {
            "type": "context",
            "elements": [
                {"type": "mrkdwn", "text": f":white_check_mark: Done by <@{user_id}> {when}"}
            ],
        },
    ]


def post_done_alert(client, task_text: str, user_id: str, channel: str, task_ts: str) -> None:
    permalink = ""
    try:
        permalink = client.chat_getPermalink(channel=channel, message_ts=task_ts)["permalink"]
    except Exception as e:  # permalink is nice-to-have, not critical
        log.warning("Could not fetch permalink: %s", e)

    link = f" (<{permalink}|view task>)" if permalink else ""
    client.chat_postMessage(
        channel=ALERTS_CHANNEL_ID,
        text=f"✅ Task completed: {task_text} — by <@{user_id}>",
        blocks=[
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f":white_check_mark: *Task completed*{link}\n>{task_text}\nCompleted by <@{user_id}>",
                },
            }
        ],
    )


def _card_already_done(message: dict | None) -> bool:
    if not message:
        return False
    return not any(b.get("type") == "actions" for b in message.get("blocks", []))


@app.event("message")
def handle_message(event, client):
    # Only new, top-level, human messages starting with "Task:" in the tasks channel become tasks.
    if event.get("channel") != TASKS_CHANNEL_ID:
        return
    if event.get("subtype") or event.get("bot_id") or event.get("thread_ts"):
        return
    match = TASK_PREFIX_RE.match(event.get("text") or "")
    if not match:
        return  # normal chat, not a task
    task_text = match.group(1).strip()
    if not task_text:
        return
    create_task_card(client, event["channel"], event["ts"], event.get("user"), task_text)


def create_task_card(client, channel: str, task_ts: str, user_id: str | None, task_text: str) -> None:
    permalink = ""
    try:
        permalink = client.chat_getPermalink(channel=channel, message_ts=task_ts)["permalink"]
    except Exception as e:  # link is nice-to-have, not critical
        log.warning("Could not fetch permalink: %s", e)

    # Posted as its own channel message (not a thread reply) so the button is visible in the channel.
    client.chat_postMessage(
        channel=channel,
        text=f"Task: {task_text}",
        blocks=build_task_blocks(task_text, channel, task_ts, user_id, permalink),
    )
    log.info("Created task for message %s", task_ts)


@app.action(DONE_ACTION_ID)
def handle_done(ack, body, client):
    ack()
    data = json.loads(body["actions"][0]["value"])
    channel, task_ts, task_text = data["channel"], data["ts"], data["text"]
    user_id = body["user"]["id"]

    if task_ts in _completed_tasks or _card_already_done(body.get("message")):
        log.info("Task %s already done; ignoring click", task_ts)
        return
    _completed_tasks.add(task_ts)

    # 1. Replace the thread card (removes the button).
    client.chat_update(
        channel=body["channel"]["id"],
        ts=body["message"]["ts"],
        text=f"Done: {task_text}",
        blocks=build_done_blocks(task_text, user_id, task_ts),
    )

    # 2. Mark the original message with a ✅ reaction.
    try:
        client.reactions_add(channel=channel, timestamp=task_ts, name=DONE_EMOJI)
    except Exception as e:  # e.g. already_reacted
        log.warning("Could not add reaction: %s", e)

    # 3. Post the completion alert.
    post_done_alert(client, task_text, user_id, channel, task_ts)
    log.info("Task %s marked done by %s", task_ts, user_id)


def _done_button(message: dict) -> dict | None:
    for block in message.get("blocks", []):
        if block.get("type") == "actions":
            for el in block.get("elements", []):
                if el.get("action_id") == DONE_ACTION_ID:
                    return el
    return None


def find_open_tasks(client, bot_id: str) -> list[dict]:
    """Return open tasks in the tasks channel: bot cards that still have the Mark as Done button.
    Each result has the thread to remind in, the poster and the task text."""
    # Slack returns nothing if the timestamp has more than 6 decimal places.
    oldest = f"{time.time() - REMINDER_LOOKBACK_DAYS * 86400:.6f}"
    open_tasks = []
    cursor = None
    while True:
        page = client.conversations_history(
            channel=TASKS_CHANNEL_ID, oldest=oldest, limit=200, cursor=cursor
        )
        for msg in page["messages"]:
            # Current format: the card is its own channel post; remind in the card's thread.
            if msg.get("bot_id") == bot_id:
                button = _done_button(msg)
                if button:
                    data = json.loads(button["value"])
                    open_tasks.append(
                        {"thread_ts": msg["ts"], "user": data.get("user"), "text": data["text"]}
                    )
                continue

            # Older format: the card is a reply in the task message's thread.
            if msg.get("subtype") or msg.get("bot_id") or not msg.get("reply_count"):
                continue
            match = TASK_PREFIX_RE.match(msg.get("text") or "")
            if not match:
                continue
            replies = client.conversations_replies(
                channel=TASKS_CHANNEL_ID, ts=msg["ts"], limit=200
            )["messages"]
            if any(r.get("bot_id") == bot_id and _done_button(r) for r in replies):
                open_tasks.append(
                    {"thread_ts": msg["ts"], "user": msg.get("user"), "text": match.group(1).strip()}
                )
        cursor = page.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            return open_tasks


def _card_task_ts(message: dict) -> str | None:
    """The original task ts a bot card belongs to (from its block_id or button value)."""
    for block in message.get("blocks", []):
        block_id = block.get("block_id", "")
        if block_id.startswith(TASK_BLOCK_PREFIX):
            return block_id[len(TASK_BLOCK_PREFIX):]
    button = _done_button(message)
    return json.loads(button["value"]).get("ts") if button else None


def catch_up_missed_tasks(client, bot_id: str) -> None:
    """Create cards for "Task:" messages posted while the bot was offline."""
    oldest = f"{time.time() - REMINDER_LOOKBACK_DAYS * 86400:.6f}"
    messages, cursor = [], None
    while True:
        page = client.conversations_history(
            channel=TASKS_CHANNEL_ID, oldest=oldest, limit=200, cursor=cursor
        )
        messages += page["messages"]
        cursor = page.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            break

    has_card = {ts for m in messages if m.get("bot_id") == bot_id and (ts := _card_task_ts(m))}
    missed = []
    for msg in messages:
        if msg.get("subtype") or msg.get("bot_id") or msg["ts"] in has_card:
            continue
        match = TASK_PREFIX_RE.match(msg.get("text") or "")
        if not match or not match.group(1).strip():
            continue
        # Older format kept the card in the task's thread.
        if msg.get("reply_count"):
            replies = client.conversations_replies(channel=TASKS_CHANNEL_ID, ts=msg["ts"], limit=200)
            if any(r.get("bot_id") == bot_id for r in replies["messages"]):
                continue
        missed.append((msg, match.group(1).strip()))

    for msg, task_text in sorted(missed, key=lambda x: float(x[0]["ts"])):  # oldest first
        create_task_card(client, TASKS_CHANNEL_ID, msg["ts"], msg.get("user"), task_text)
    log.info("Startup catch-up: created %d card(s) for tasks posted while offline", len(missed))


def send_reminders(client, bot_id: str) -> None:
    open_tasks = find_open_tasks(client, bot_id)
    for task in open_tasks:
        who = f"<@{task['user']}> " if task.get("user") else ""
        link = ""
        try:
            permalink = client.chat_getPermalink(
                channel=TASKS_CHANNEL_ID, message_ts=task["thread_ts"]
            )["permalink"]
            link = f" · <{permalink}|open task>"
        except Exception as e:  # link is nice-to-have, not critical
            log.warning("Could not fetch permalink: %s", e)
        # Posted as its own channel message (not a thread reply) so it's visible in the channel.
        client.chat_postMessage(
            channel=TASKS_CHANNEL_ID,
            text=f":alarm_clock: {who}Reminder: this task is still not done — {task['text']}",
            blocks=[
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f":alarm_clock: *Reminder:* {who}this task is still not done{link}\n>{task['text']}",
                    },
                }
            ],
        )
    log.info("Sent %d reminder(s)", len(open_tasks))


def _current_slot(now: datetime) -> str | None:
    """The latest reminder slot that has started today, e.g. '2026-09-24 12', or None before the first."""
    passed = [h for h in REMINDER_HOURS if now.hour >= h]
    return f"{now.date().isoformat()} {max(passed):02d}" if passed else None


def _read_last_slot() -> str:
    try:
        return LAST_REMINDER_FILE.read_text().strip()
    except OSError:
        return ""


def _write_last_slot(slot: str) -> None:
    LAST_REMINDER_FILE.parent.mkdir(parents=True, exist_ok=True)
    LAST_REMINDER_FILE.write_text(slot)


def reminder_loop(client) -> None:
    """At each hour in REMINDER_HOURS (PH time), remind open tasks once.
    If the bot was off at a reminder time, it sends one catch-up reminder when it starts."""
    bot_id = client.auth_test()["bot_id"]
    try:
        catch_up_missed_tasks(client, bot_id)
    except Exception:
        log.exception("Startup catch-up failed")
    # First run (or old date-only state): don't fire immediately for a slot that already passed.
    if not SLOT_RE.match(_read_last_slot()):
        slot = _current_slot(datetime.now(PH_TZ))
        _write_last_slot(slot or "")
    log.info(
        "Reminders scheduled daily at %s Philippine time",
        ", ".join(f"{h:02d}:00" for h in REMINDER_HOURS),
    )
    while True:
        slot = _current_slot(datetime.now(PH_TZ))
        if slot and _read_last_slot() != slot:
            try:
                send_reminders(client, bot_id)
                _write_last_slot(slot)
            except Exception:
                log.exception("Reminder run failed; will retry shortly")
        time.sleep(REMINDER_CHECK_SECONDS)


if __name__ == "__main__":
    threading.Thread(target=reminder_loop, args=(app.client,), daemon=True).start()
    SocketModeHandler(app, SLACK_APP_TOKEN).start()
