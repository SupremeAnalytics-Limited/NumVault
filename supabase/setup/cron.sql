-- Scheduled jobs. Run once in the Supabase SQL editor AFTER the baseline
-- migration, replacing the two placeholders below.
--
--   <PROJECT_REF>       e.g. abcdefghijklmnop (from the project URL)
--   <SERVICE_ROLE_KEY>  Project Settings → API → service_role (keep it secret)
--
-- The key is stored in Supabase Vault, not in this file or the repo.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'project_url');
select vault.create_secret('<SERVICE_ROLE_KEY>', 'service_role_key');

-- Every minute: expire orders with no OTP after 5 minutes (refund to wallet),
-- which also checks the Socially.ng balance and tops it up if needed.
select cron.schedule('auto-expire-orders', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/auto-expire-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000);
$$);

-- Hourly: end ambassador windows that ran out (qualification resets,
-- paid months are paid pro rata).
select cron.schedule('close-expired-blocks', '7 * * * *', $$ select public.close_all_expired_blocks(); $$);
