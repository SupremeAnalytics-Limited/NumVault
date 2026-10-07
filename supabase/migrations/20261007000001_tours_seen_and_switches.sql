-- Add tours_seen column to user_profiles
alter table public.user_profiles
  add column if not exists tours_seen jsonb not null default '{}';

-- Function: mark a tour as seen for the calling user
create or replace function public.mark_tour_seen(tour text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if tour not in ('home', 'home_sheet', 'wallet', 'orders', 'checkout') then
    raise exception 'INVALID_TOUR: %', tour;
  end if;
  update user_profiles
  set tours_seen = tours_seen || jsonb_build_object(tour, true)
  where id = auth.uid();
end;
$$;

grant execute on function public.mark_tour_seen(text) to authenticated;

-- Admin switches
insert into public.app_settings (key, value) values
  ('tab_tours_always_show',      'false'::jsonb),
  ('checkout_intro_always_show', 'false'::jsonb)
on conflict (key) do nothing;

-- Backfill: mark existing users' tab tours as seen so they don't see them retroactively
update public.user_profiles
set tours_seen = tours_seen || '{"home": true, "home_sheet": true, "wallet": true, "orders": true}'::jsonb
where tours_seen = '{}';

-- Backfill checkout: only for users who already completed at least one order
update public.user_profiles up
set tours_seen = up.tours_seen || '{"checkout": true}'::jsonb
where exists (
  select 1 from public.orders o
  where o.user_id = up.id and o.status = 'completed'
);
