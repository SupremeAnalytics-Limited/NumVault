-- Admin toggle: when true, the acquisition-program dashboard tour shows once
-- per app session (every cold start) for every user, ignoring the normal
-- "seen it once, ever" persisted flag. Defaults off (normal once-ever behavior).
insert into public.app_settings (key, value) values
  ('dashboard_tour_force_every_session', 'false'::jsonb)
on conflict (key) do nothing;
