-- Default reminder schedule: 7 AM and 3 PM Philippine time (UTC+8) = 23:00 (previous day) and 07:00 UTC.
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'slack-task-reminders'),
  schedule := '0 7,23 * * *'
);
