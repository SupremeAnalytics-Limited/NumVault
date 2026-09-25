-- Leads can't read other users' profiles, so the dashboard's "Signed up, not
-- bought yet" list gets a follow-up label through this function instead:
-- the customer's name or username, else a masked email (ol***@gmail.com).
create or replace function public.get_my_pending_referrals()
returns table (id uuid, signup_at timestamptz, label text)
language sql
stable
security definer
set search_path = public
as $$
  select
    rc.id,
    rc.signup_at,
    coalesce(
      nullif(btrim(up.name), ''),
      nullif(btrim(up.username), ''),
      left(split_part(up.email, '@', 1), 2) || '***@' || split_part(up.email, '@', 2)
    ) as label
  from referred_customers rc
  join acquisition_participants ap on ap.id = rc.participant_id
  join user_profiles up on up.id = rc.customer_id
  where ap.user_id = auth.uid()
    and not rc.validated
  order by rc.signup_at desc;
$$;

revoke execute on function public.get_my_pending_referrals() from public, anon;
grant execute on function public.get_my_pending_referrals() to authenticated, service_role;
