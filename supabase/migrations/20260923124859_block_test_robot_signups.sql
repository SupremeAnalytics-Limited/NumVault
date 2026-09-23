-- Google Play's pre-launch robot signs up with throwaway Gmail inboxes that
-- are full, so every code email bounces back to support@numvault.cloud.
-- This "Before User Created" auth hook refuses those addresses before any
-- email is sent. Reviewers log in with the test account given in Play
-- Console → App content → App access instead.
--
-- Enable in Supabase: Authentication → Hooks → Before User Created →
-- Postgres function public.block_test_robot_signups.

create or replace function public.block_test_robot_signups(event jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_email text := lower(coalesce(event->'user'->>'email', ''));
begin
  if v_email ~ '^(crawlerrobo|cloudtestlab[a-z0-9._-]*)@gmail\.com$'
     or v_email like '%@cloudtestlabaccounts.com' then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'Sign-ups from automated test accounts are not allowed.'));
  end if;
  return '{}'::jsonb;
end;
$$;

grant execute on function public.block_test_robot_signups(jsonb) to supabase_auth_admin;
revoke execute on function public.block_test_robot_signups(jsonb) from public, anon, authenticated;
