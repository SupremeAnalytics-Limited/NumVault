-- Revert 20260924112556_user_onboarding_seen_flags: decided against
-- per-account onboarding-seen tracking in favor of per-device (AsyncStorage),
-- since onboarding always shows before sign-in and per-device better matches
-- that flow.
alter table public.user_profiles
  drop column if exists app_onboarding_seen,
  drop column if exists acquisition_landing_seen,
  drop column if exists dashboard_tour_seen;
