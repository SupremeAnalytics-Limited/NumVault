-- Admin-editable margin per number sale. Defaults to the current ₦1,500 flat
-- fee so nothing changes until the admin explicitly saves a new value.
insert into public.app_settings (key, value) values
  ('flat_acquisition_fee', '1500'::jsonb)
on conflict (key) do nothing;
