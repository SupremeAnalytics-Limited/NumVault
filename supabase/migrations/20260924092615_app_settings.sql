-- ─────────────────────────────────────────────────────────────────────────────
-- App settings: small admin-editable key/value store.
--
-- Used for:
--   near_instant_transfer_enabled — toggles the Socially.ng funding model
--     between the current T+1 settlement split (off) and exact per-purchase
--     Paystack transfers (on). See wallet-topup and purchase-number.
--   job_ad_content — the pitch copy shown on the acquisition-program landing
--     screen (app/acquisition-program.tsx), editable without an app release.
--
-- Readable by anyone (non-sensitive config the app needs client-side);
-- writable only by the admin.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.app_settings enable row level security;

create policy "anyone can read app settings" on public.app_settings
  for select to authenticated, anon using (true);

create policy "admin can write app settings" on public.app_settings
  for insert to authenticated with check (public.is_admin());
create policy "admin can update app settings" on public.app_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.set_updated_by()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;

create trigger app_settings_set_updated_by
  before insert or update on public.app_settings
  for each row execute function public.set_updated_by();

-- Defaults: near-instant transfers start OFF (current T+1 split behavior
-- keeps running unchanged until explicitly turned on in the admin dashboard).
insert into public.app_settings (key, value) values
  ('near_instant_transfer_enabled', 'false'::jsonb);
