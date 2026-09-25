-- Admin toggle: when true, ensure-socially-balance switches from the fixed
-- hourly-demand top-up (₦40k threshold, ₦40k-₦200k range) to an uncapped,
-- 24h-demand-based cushion target, batching across multiple Paystack
-- transfers via /transfer/bulk when a single top-up exceeds ₦10,000,000.
-- Defaults off (current behavior unchanged).
insert into public.app_settings (key, value) values
  ('scale_mode_enabled', 'false'::jsonb)
on conflict (key) do nothing;

-- Exact Socially.ng wholesale cost captured at purchase time, used by
-- scale mode's 24h-demand calculation (falls back to amount_paid minus the
-- flat margin for older orders where this is null).
alter table public.orders add column if not exists wholesale_cost numeric(12,2);
