// Slack task bot, hosted on Supabase so it runs without anyone's PC.
//
// - Slack sends message events and button clicks here (Events API + Interactivity Request URL).
// - A "Task: ..." message in any channel the bot is a member of gets a separate card with a "Mark as Done" button.
// - Clicking it updates the card, adds a ✅ to the original message and posts a completion alert.
// - pg_cron calls this function with ?action=remind at 8 AM, 12 PM and 3 PM Philippine time,
//   and it posts a reminder for every task that's still open.
// - A task with its own time ("Task: Pay invoice every 3pm", "... @ 2:30pm") is instead reminded daily at that time:
//   a per-minute pg_cron check calls ?action=remind_custom only when such a task is due.
//
// Secrets (Supabase dashboard > Edge Functions > Secrets):
//   SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, REMINDER_LOOKBACK_DAYS (optional, default 30)
//   SLACK_USER_TOKEN (optional): a workspace admin's user token with chat:write. When set, the
//   original "Task:" message is deleted once its card is posted (bots can't delete others' messages).
// Every channel the bot is invited to is watched. Optional per-channel settings live in the
// public.task_channels table (e.g. send a channel's completion alerts somewhere else).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const DONE_ACTION_ID = "mark_task_done";
// Only messages starting with "Task:" (any case, optionally bold/italic) are tasks.
const TASK_PREFIX_RE = /^\s*[*_]*task\s*:\s*[*_]*\s*([\s\S]+)$/i;
const DONE_EMOJI = "white_check_mark";
// Slack caps a button value at 2000 chars; keep room for the JSON wrapper.
const MAX_TASK_TEXT_IN_VALUE = 1500;
// Each card's first block_id is "task:<original message ts>".
const TASK_BLOCK_PREFIX = "task:";
// Optional custom reminder time, anywhere in the task: "every 3pm", "every day at 10am", "daily 4:15 PM",
// "@ 2:30pm", "@ 14:30", "remind me at 9am". A bare "at 3pm" is NOT a reminder time ("Meet at 3pm").
const TIME_PART = String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?|(\d{1,2}):(\d{2})`;
const REMIND_TIME_RE = new RegExp(
  String.raw`(?:^|\s)(?:@|every\s*day(?:\s+at)?|every(?:\s+at)?|daily(?:\s+at)?|remind(?:\s+me)?\s+at)\s*(?:${TIME_PART})` +
    String.raw`(?=$|[\s.,;:!?)"'”’])`,
  "i",
);

/** Finds a reminder time in the task. Returns 24h "HH:MM" (Philippine time) or null.
 *  A time at the very end is removed from the text; one mid-sentence is left in place. */
function parseRemindTime(text: string): { text: string; time: string | null } {
  const m = REMIND_TIME_RE.exec(text);
  if (!m) return { text, time: null };
  let hour: number, minute: number;
  if (m[1] !== undefined) {
    if (Number(m[1]) < 1 || Number(m[1]) > 12) return { text, time: null };
    hour = Number(m[1]) % 12 + (m[3].toLowerCase() === "p" ? 12 : 0);
    minute = Number(m[2] ?? 0);
  } else {
    hour = Number(m[4]);
    minute = Number(m[5]);
  }
  if (hour > 23 || minute > 59) return { text, time: null };
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const atEnd = text.slice(m.index + m[0].length).trim() === "";
  return { text: atEnd ? text.slice(0, m.index).trim() : text, time };
}

/** "14:30" -> "2:30 PM" */
function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function env(name: string, fallback?: string): string {
  const value = Deno.env.get(name) ?? fallback;
  if (!value) throw new Error(`Missing secret ${name}`);
  return value;
}

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

// ---------- Slack helpers ----------

type Json = Record<string, unknown>;

async function slack(method: string, params: Json, token = env("SLACK_BOT_TOKEN")): Promise<Json> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed: ${data.error}`);
  return data;
}

async function permalink(channel: string, ts: string): Promise<string> {
  try {
    return (await slack("chat.getPermalink", { channel, message_ts: ts })).permalink as string;
  } catch (e) {
    console.warn("Could not fetch permalink:", e); // link is nice-to-have, not critical
    return "";
  }
}

let cachedBotId: string | null = null;
async function botId(): Promise<string> {
  cachedBotId ??= (await slack("auth.test", {})).bot_id as string;
  return cachedBotId;
}

async function verifySlackSignature(req: Request, rawBody: string): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");
  if (!ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env("SLACK_SIGNING_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${rawBody}`));
  const expected = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // constant-time compare
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ---------- Blocks ----------

function buildTaskBlocks(
  taskText: string, channel: string, taskTs: string, userId?: string, link = "", remindTime: string | null = null,
) {
  const value = JSON.stringify({ channel, ts: taskTs, user: userId, text: taskText.slice(0, MAX_TASK_TEXT_IN_VALUE) });
  let postedBy = userId ? `Posted by <@${userId}>` : "Task";
  if (link) postedBy += ` · <${link}|view message>`;
  if (remindTime) postedBy += ` · :alarm_clock: Reminder daily at ${formatTime(remindTime)}`;
  return [
    { type: "section", block_id: `${TASK_BLOCK_PREFIX}${taskTs}`, text: { type: "mrkdwn", text: `:memo: *Task:* ${taskText}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: postedBy }] },
    {
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "✅ Mark as Done", emoji: true },
        style: "primary",
        action_id: DONE_ACTION_ID,
        value,
      }],
    },
  ];
}

/** Slack strikethrough doesn't span line breaks, so strike each line separately. */
function strikethrough(text: string): string {
  return text.split("\n").map((line) => (line.trim() ? `~${line.trim()}~` : line)).join("\n");
}

function buildDoneBlocks(taskText: string, userId: string, taskTs: string, postedBy?: string) {
  const now = Math.floor(Date.now() / 1000);
  const fallback = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const when = `<!date^${now}^{date_short_pretty} at {time}|${fallback}>`;
  const byLine = postedBy ? `Posted by <@${postedBy}> · ` : "";
  return [
    {
      type: "section",
      block_id: `${TASK_BLOCK_PREFIX}${taskTs}`,
      text: { type: "mrkdwn", text: `:memo: ~Task:~\n${strikethrough(taskText)}` },
    },
    { type: "context", elements: [{ type: "mrkdwn", text: `${byLine}:white_check_mark: Done by <@${userId}> ${when}` }] },
  ];
}

// deno-lint-ignore no-explicit-any
function doneButton(message: any): any | null {
  for (const block of message.blocks ?? []) {
    if (block.type !== "actions") continue;
    for (const el of block.elements ?? []) if (el.action_id === DONE_ACTION_ID) return el;
  }
  return null;
}

// ---------- Channels ----------

/** Where a channel's completion alerts go: its task_channels override, else the channel itself. */
async function alertsChannelFor(channel: string): Promise<string> {
  const { data, error } = await db
    .from("task_channels").select("alerts_channel_id").eq("channel_id", channel).maybeSingle();
  if (error) throw error;
  return data?.alerts_channel_id ?? channel;
}

/** Channels to check for open tasks: any with a task card in the lookback window, plus configured ones. */
async function reminderChannels(lookbackDays: number): Promise<Set<string>> {
  const since = new Date(Date.now() - lookbackDays * 86400_000).toISOString();
  const [cards, configured] = await Promise.all([
    db.from("task_cards").select("channel_id").gte("created_at", since).not("channel_id", "is", null),
    db.from("task_channels").select("channel_id"),
  ]);
  if (cards.error) throw cards.error;
  if (configured.error) throw configured.error;
  return new Set([...cards.data, ...configured.data].map((r) => r.channel_id as string));
}

// ---------- Handlers ----------

/** Returns true the first time a key is claimed; false if it was already claimed (retry / double click). */
async function claimOnce(table: string, row: Json): Promise<boolean> {
  const { error } = await db.from(table).insert(row);
  if (!error) return true;
  if (error.code === "23505") return false; // unique violation: already handled
  throw error;
}

// deno-lint-ignore no-explicit-any
async function handleMessage(event: any) {
  // Only new, top-level, human messages starting with "Task:" become tasks.
  // Slack only sends messages from channels the bot is in, so every such channel is watched.
  if (event.subtype || event.bot_id || event.thread_ts) return;
  if (event.channel_type === "im" || event.channel_type === "mpim") return; // not DMs
  const match = TASK_PREFIX_RE.exec(event.text ?? "");
  if (!match) return; // normal chat, not a task
  const { text: taskText, time: remindTime } = parseRemindTime(match[1].trim());
  if (!taskText) return;
  const claimed = await claimOnce("task_cards", {
    task_ts: event.ts,
    channel_id: event.channel,
    task_text: taskText,
    posted_by: event.user,
    remind_time: remindTime,
  });
  if (!claimed) return;

  const userToken = Deno.env.get("SLACK_USER_TOKEN");
  try {
    // With a user token the original message is removed below, so don't link to it.
    const link = userToken ? "" : await permalink(event.channel, event.ts);
    // Posted as its own channel message (not a thread reply) so the button is visible in the channel.
    const card = await slack("chat.postMessage", {
      channel: event.channel,
      text: `Task: ${taskText}`,
      blocks: buildTaskBlocks(taskText, event.channel, event.ts, event.user, link, remindTime),
    });
    await db.from("task_cards").update({ card_ts: card.ts }).eq("task_ts", event.ts);
  } catch (e) {
    await db.from("task_cards").delete().eq("task_ts", event.ts); // let a retry try again
    throw e;
  }
  console.log("Created task for message", event.ts);

  // Remove the original "Task:" message so the card is the only copy in the channel.
  if (userToken) {
    try {
      await slack("chat.delete", { channel: event.channel, ts: event.ts }, userToken);
    } catch (e) {
      console.warn("Could not delete original task message:", e); // e.g. cant_delete_message
    }
  }
}

// deno-lint-ignore no-explicit-any
async function handleDone(payload: any) {
  const data = JSON.parse(payload.actions[0].value);
  const { channel, ts: taskTs, text: taskText, user: postedBy } = data;
  const userId = payload.user.id;
  if (!(await claimOnce("completed_tasks", { task_ts: taskTs, completed_by: userId }))) {
    console.log("Task already done; ignoring click", taskTs);
    return;
  }

  // 1. Replace the card (removes the button).
  try {
    await slack("chat.update", {
      channel: payload.channel.id,
      ts: payload.message.ts,
      text: `Done: ${taskText}`,
      blocks: buildDoneBlocks(taskText, userId, taskTs, postedBy),
    });
  } catch (e) {
    await db.from("completed_tasks").delete().eq("task_ts", taskTs); // let another click try again
    throw e;
  }

  // 2. Mark the original message with a ✅ reaction (if it wasn't removed).
  try {
    await slack("reactions.add", { channel, timestamp: taskTs, name: DONE_EMOJI });
  } catch (e) {
    if (!String(e).includes("message_not_found")) console.warn("Could not add reaction:", e);
  }

  // 3. Post the completion alert, linking to the (now struck-through) card.
  const link = await permalink(payload.channel.id, payload.message.ts);
  const linkText = link ? ` (<${link}|view task>)` : "";
  const alertsChannel = await alertsChannelFor(channel);
  await slack("chat.postMessage", {
    channel: alertsChannel,
    text: `✅ Task completed: ${taskText} — by <@${userId}>`,
    blocks: [{
      type: "section",
      text: { type: "mrkdwn", text: `:white_check_mark: *Task completed*${linkText}\n>${taskText}\nCompleted by <@${userId}>` },
    }],
  });
  console.log("Task marked done", taskTs, "by", userId);
}

type OpenTask = { taskTs: string; threadTs: string; user?: string; text: string };

/** Open tasks = bot cards that still have the Mark as Done button. */
async function findOpenTasks(channel: string, lookbackDays: number): Promise<OpenTask[]> {
  // Slack returns nothing if the timestamp has more than 6 decimal places.
  const oldest = (Date.now() / 1000 - lookbackDays * 86400).toFixed(6);
  const me = await botId();
  const open: OpenTask[] = [];
  let cursor: string | undefined;
  do {
    const page = await slack("conversations.history", { channel, oldest, limit: 200, cursor });
    // deno-lint-ignore no-explicit-any
    for (const msg of page.messages as any[]) {
      // Current format: the card is its own channel post.
      if (msg.bot_id === me) {
        const button = doneButton(msg);
        if (button) {
          const v = JSON.parse(button.value);
          open.push({ taskTs: v.ts, threadTs: msg.ts, user: v.user ?? undefined, text: v.text });
        }
        continue;
      }
      // Older format: the card is a reply in the task message's thread.
      if (msg.subtype || msg.bot_id || !msg.reply_count) continue;
      const match = TASK_PREFIX_RE.exec(msg.text ?? "");
      if (!match) continue;
      const replies = await slack("conversations.replies", { channel, ts: msg.ts, limit: 200 });
      // deno-lint-ignore no-explicit-any
      if ((replies.messages as any[]).some((r) => r.bot_id === me && doneButton(r))) {
        open.push({ taskTs: msg.ts, threadTs: msg.ts, user: msg.user, text: match[1].trim() });
      }
    }
    // deno-lint-ignore no-explicit-any
    cursor = (page.response_metadata as any)?.next_cursor || undefined;
  } while (cursor);
  return open;
}

async function sendReminders() {
  const lookbackDays = Number(env("REMINDER_LOOKBACK_DAYS", "30"));
  for (const channel of await reminderChannels(lookbackDays)) {
    try {
      await sendRemindersForChannel(channel, lookbackDays);
    } catch (e) {
      console.error(`Reminders failed for channel ${channel}:`, e); // don't let one channel block the others
    }
  }
}

/** Default schedule (8 AM / 12 PM / 3 PM): every open task except those with their own reminder time. */
async function sendRemindersForChannel(channel: string, lookbackDays: number) {
  const { data: custom, error } = await db
    .from("task_cards").select("task_ts").eq("channel_id", channel).not("remind_time", "is", null);
  if (error) throw error;
  const hasCustomTime = new Set(custom.map((r) => r.task_ts));

  const tasks = (await findOpenTasks(channel, lookbackDays)).filter((t) => !hasCustomTime.has(t.taskTs));
  for (const task of tasks.reverse()) { // oldest first
    await postReminder(channel, task.threadTs, task.user, task.text);
  }
  console.log(`Sent ${tasks.length} reminder(s) in ${channel}`);
}

/** Custom times: open tasks whose own reminder time is `time` ("HH:MM", Philippine time). */
async function sendCustomReminders(time: string) {
  const { data: due, error } = await db
    .from("task_cards").select("task_ts, channel_id, card_ts, posted_by, task_text")
    .eq("remind_time", `${time}:00`).not("card_ts", "is", null);
  if (error) throw error;
  if (!due.length) return;
  const { data: done, error: doneError } = await db
    .from("completed_tasks").select("task_ts").in("task_ts", due.map((r) => r.task_ts));
  if (doneError) throw doneError;
  const doneSet = new Set(done.map((r) => r.task_ts));

  let sent = 0;
  for (const task of due.filter((r) => !doneSet.has(r.task_ts))) {
    try {
      await postReminder(task.channel_id, task.card_ts, task.posted_by, task.task_text);
      sent++;
    } catch (e) {
      console.error(`Custom reminder failed for task ${task.task_ts}:`, e);
    }
  }
  console.log(`Sent ${sent} custom-time reminder(s) for ${time}`);
}

async function postReminder(channel: string, cardTs: string, user: string | undefined, text: string) {
  const who = user ? `<@${user}> ` : "";
  const link = await permalink(channel, cardTs);
  const linkText = link ? ` · <${link}|open task>` : "";
  // Posted as its own channel message (not a thread reply) so it's visible in the channel.
  await slack("chat.postMessage", {
    channel,
    text: `:alarm_clock: ${who}Reminder: this task is still not done — ${text}`,
    blocks: [{
      type: "section",
      text: { type: "mrkdwn", text: `:alarm_clock: *Reminder:* ${who}this task is still not done${linkText}\n>${text}` },
    }],
  });
}

function background(work: Promise<unknown>) {
  EdgeRuntime.waitUntil(work.catch((e) => console.error("Background task failed:", e)));
}

// ---------- Entry point ----------

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Scheduled reminders (pg_cron). Authenticated with a secret stored in Supabase Vault.
  const action = url.searchParams.get("action");
  if (action === "remind" || action === "remind_custom") {
    const { data: secret, error } = await db.rpc("slack_bot_cron_secret");
    if (error || !secret || req.headers.get("x-cron-secret") !== secret) {
      return new Response("forbidden", { status: 403 });
    }
    if (action === "remind") {
      background(sendReminders());
    } else {
      const time = (await req.json().catch(() => ({})))?.time;
      if (!/^\d{2}:\d{2}$/.test(time ?? "")) return new Response("bad time", { status: 400 });
      background(sendCustomReminders(time));
    }
    return new Response("reminders queued", { status: 202 });
  }

  const rawBody = await req.text();
  if (!(await verifySlackSignature(req, rawBody))) {
    return new Response("invalid signature", { status: 401 });
  }

  // Button clicks arrive form-encoded with a JSON "payload" field.
  if ((req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
    const payload = JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "{}");
    if (payload.type === "block_actions" && payload.actions?.[0]?.action_id === DONE_ACTION_ID) {
      background(handleDone(payload));
    }
    return new Response("", { status: 200 }); // ack within 3 seconds
  }

  const body = JSON.parse(rawBody);
  if (body.type === "url_verification") {
    return new Response(body.challenge, { headers: { "Content-Type": "text/plain" } });
  }
  // Slack retries if we were slow; the first delivery is already being handled.
  if (req.headers.get("x-slack-retry-num")) return new Response("", { status: 200 });
  if (body.type === "event_callback" && body.event?.type === "message") {
    background(handleMessage(body.event));
  }
  return new Response("", { status: 200 });
});
