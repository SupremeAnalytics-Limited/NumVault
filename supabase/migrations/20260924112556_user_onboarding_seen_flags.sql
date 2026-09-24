-- Persist "has this account seen X onboarding screen" server-side, tied to
-- the user's row, instead of device-local AsyncStorage. AsyncStorage is
-- wiped on app delete/reinstall, so a returning user who deletes and
-- reinstalls the app would see onboarding again even though their account
-- already saw it — these columns survive that because they live on the
-- account, not the device.
alter table public.user_profiles
  add column if not exists app_onboarding_seen boolean not null default false,
  add column if not exists acquisition_landing_seen boolean not null default false,
  add column if not exists dashboard_tour_seen boolean not null default false;

grant update (app_onboarding_seen, acquisition_landing_seen, dashboard_tour_seen)
  on public.user_profiles to authenticated;
