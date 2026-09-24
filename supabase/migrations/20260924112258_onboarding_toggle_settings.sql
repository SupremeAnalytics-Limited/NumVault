-- Admin toggles: when true (default), the app intro and the acquisition
-- program job pitch show on every visit, matching their original always-show
-- behavior. When false, each shows only once ever per user/device.
insert into public.app_settings (key, value) values
  ('app_onboarding_force_every_session', 'true'::jsonb),
  ('acquisition_landing_force_every_session', 'true'::jsonb)
on conflict (key) do nothing;
