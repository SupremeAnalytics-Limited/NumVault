-- Paystack deduplicates transfers by reference, so a payout whose transfer
-- failed or was reversed can't be re-sent with the same reference. Each
-- failed attempt bumps this counter; approve-payout sends the next attempt as
-- `<payout_id>-r<attempt>` (attempt 0 keeps the bare payout_id).
alter table public.lead_payouts
  add column if not exists transfer_attempt integer not null default 0;
