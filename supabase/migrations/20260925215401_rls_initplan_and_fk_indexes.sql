-- RLS performance: wrap auth.uid() and is_admin() in a sub-select so Postgres
-- evaluates them once per statement (initplan) instead of once per row.
-- Each policy's logic is unchanged.

alter policy "edit own bank details" on public.acquisition_participants
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter policy "own participant or admin" on public.acquisition_participants
  using (user_id = (select auth.uid()) or (select public.is_admin()));

alter policy "own payouts or admin" on public.lead_payouts
  using (
    (select public.is_admin()) or exists (
      select 1 from public.acquisition_participants p
      where p.id = participant_id and p.user_id = (select auth.uid())));

alter policy "own orders or admin" on public.orders
  using (user_id = (select auth.uid()) or (select public.is_admin()));

alter policy "own referrals or admin" on public.referred_customers
  using (
    (select public.is_admin()) or exists (
      select 1 from public.acquisition_participants p
      where p.id = participant_id and p.user_id = (select auth.uid())));

alter policy "own transactions or admin" on public.transactions
  using (user_id = (select auth.uid()) or (select public.is_admin()));

alter policy "edit own profile" on public.user_profiles
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

alter policy "own profile or admin" on public.user_profiles
  using (id = (select auth.uid()) or (select public.is_admin()));

-- Indexes on foreign-key columns that had none.
create index if not exists referred_customers_order_id_idx on public.referred_customers (order_id);
create index if not exists referred_customers_payout_id_idx on public.referred_customers (payout_id);
create index if not exists acquisition_ledger_entries_participant_id_idx on public.acquisition_ledger_entries (participant_id);
create index if not exists purchase_locks_user_id_idx on public.purchase_locks (user_id);
