-- Run once in Supabase (SQL editor) after the Render service is up.
-- Pings the bridge every 10 minutes so Render's free plan never puts it to sleep.
-- Replace the URL with your Render service URL.
create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.unschedule('wa-bridge-keepalive')
where exists (select 1 from cron.job where jobname = 'wa-bridge-keepalive');

select cron.schedule(
  'wa-bridge-keepalive',
  '*/10 * * * *',
  $$ select net.http_get('https://namaste-wa-bridge.onrender.com/health') $$
);

-- Check it's firing:  select * from cron.job_run_details order by start_time desc limit 5;
