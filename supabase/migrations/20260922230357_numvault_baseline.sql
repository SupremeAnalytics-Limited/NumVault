-- NumVault baseline schema for a fresh Supabase project.
-- Replaces the incremental OnSpace-era migrations (20240001–20240006), which
-- assumed tables that only ever existed inside OnSpace.
--
-- Money rule of thumb: the app (anon/authenticated) can READ its own rows and
-- edit a few harmless columns. Every balance change, order completion and
-- ambassador count happens in SECURITY DEFINER functions callable only by
-- server functions (service_role).

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

create table public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text,
  email text not null,
  name text,
  wallet_balance numeric(12,2) not null default 0 check (wallet_balance >= 0),
  paystack_customer_code text,
  card_last4 text,
  card_auth_code text,
  card_brand text,
  card_exp_month text,
  card_exp_year text,
  pending_socially_credit numeric(12,2) not null default 0 check (pending_socially_credit >= 0),
  push_token text
);
create index user_profiles_email_idx on public.user_profiles (lower(email));

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles (id),
  provider_code text not null,
  country_id text not null,
  country_name text not null,
  project_id text not null,
  project_name text not null,
  phone_number text,
  otp text,
  amount_paid numeric(12,2) not null check (amount_paid >= 0),
  status text not null default 'pending' check (status in ('pending', 'completed', 'expired')),
  order_reference text unique,
  socially_order_id text,
  created_at timestamptz not null default now(),
  paystack_reference text
);
create index orders_user_created_idx on public.orders (user_id, created_at desc);
create index orders_pending_created_idx on public.orders (created_at) where status = 'pending';
create index orders_paystack_reference_idx on public.orders (paystack_reference) where paystack_reference is not null;

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles (id),
  amount numeric(12,2) not null,
  type text not null check (type in ('credit', 'debit')),
  reference text,
  description text,
  created_at timestamptz not null default now()
);
create index transactions_user_created_idx on public.transactions (user_id, created_at desc);
-- One credit per reference: a payment or order can never be refunded/credited twice.
create unique index transactions_one_credit_per_reference
  on public.transactions (reference) where type = 'credit' and reference is not null;

create table public.purchase_locks (
  paystack_reference text primary key,
  user_id uuid not null references public.user_profiles (id),
  created_at timestamptz not null default now()
);

create table public.socially_transfers (
  id uuid primary key default gen_random_uuid(),
  order_reference text not null,
  amount_transferred numeric(12,2) not null,
  paystack_transfer_reference text,
  recipient_code text,
  status text not null default 'pending',
  error_message text,
  created_at timestamptz not null default now(),
  trigger_reason text
);
create index socially_transfers_reason_created_idx on public.socially_transfers (trigger_reason, created_at desc);
-- At most one automatic top-up in flight (ensure-socially-balance relies on this).
create unique index socially_transfers_one_pending_auto
  on public.socially_transfers (trigger_reason)
  where status = 'pending' and trigger_reason = 'low_balance_auto';

create table public.acquisition_participants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.user_profiles (id),
  name text not null,
  referral_code text not null unique,
  status text not null default 'qualifying' check (status in (
    'qualifying', 'pending_review', 'eligible_not_joined', 'active_lead',
    'needs_requalification', 'inactive', 'contract_complete')),
  bank_account_number text,
  bank_code text,
  bank_name text,
  paystack_recipient_code text,
  qualification_start_date timestamptz,
  qualification_customers_count integer not null default 0 check (qualification_customers_count between 0 and 76),
  active_lead_start_month date,
  created_at timestamptz not null default now(),
  paid_period_start_date timestamptz,
  paid_periods_completed integer not null default 0 check (paid_periods_completed between 0 and 6),
  original_activation_timestamp timestamptz,
  paid_period_end_date timestamptz
);
comment on column public.acquisition_participants.paid_period_start_date is 'Start of the current 30-day paid window (rolling, not calendar month)';
comment on column public.acquisition_participants.paid_periods_completed is 'Number of 30-day paid periods completed; max 6 before contract ends';

create table public.lead_payouts (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.acquisition_participants (id),
  cycle_number integer not null check (cycle_number in (1, 2)),
  monthly_window_start date not null,
  amount numeric(12,2) not null default 50000 check (amount > 0),
  customers_in_cycle integer not null default 38,
  paystack_transfer_code text,
  status text not null default 'pending' check (status in (
    'pending', 'under_review', 'approved', 'sent', 'failed', 'held')),
  failure_reason text,
  triggered_at timestamptz not null default now(),
  sent_at timestamptz,
  period_start_timestamp timestamptz,
  block_number integer,
  approved_at timestamptz,
  review_note text
);
create index lead_payouts_participant_idx on public.lead_payouts (participant_id, triggered_at desc);
create index lead_payouts_status_idx on public.lead_payouts (status);
-- One payout per half per month.
create unique index lead_payouts_one_per_half
  on public.lead_payouts (participant_id, block_number, cycle_number);

create table public.referred_customers (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.user_profiles (id),
  participant_id uuid not null references public.acquisition_participants (id),
  referral_code_used text not null,
  signup_at timestamptz not null default now(),
  first_purchase_at timestamptz,
  validated boolean not null default false,
  validated_at timestamptz,
  order_id uuid references public.orders (id),
  current_cycle_number integer,
  created_at timestamptz not null default now(),
  email_normalized text,
  block_number integer,
  payout_id uuid references public.lead_payouts (id),
  validation_note text
);
create index referred_customers_participant_idx on public.referred_customers (participant_id, block_number);
create index referred_customers_email_idx on public.referred_customers (email_normalized) where validated;

create table public.acquisition_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders (id),
  amount numeric(12,2) not null default 1500,
  participant_id uuid references public.acquisition_participants (id),
  entry_type text not null check (entry_type in ('lead_obligation', 'unattributed_profit')),
  created_at timestamptz not null default now()
);

create table public.pitch_library (
  id uuid primary key default gen_random_uuid(),
  audience text not null,
  headline text not null,
  body text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Access rules (RLS). Service role bypasses all of these.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'oluwaferanmionabanjo@gmail.com'
$$;

alter table public.user_profiles              enable row level security;
alter table public.orders                     enable row level security;
alter table public.transactions               enable row level security;
alter table public.purchase_locks             enable row level security;
alter table public.socially_transfers         enable row level security;
alter table public.acquisition_participants   enable row level security;
alter table public.lead_payouts               enable row level security;
alter table public.referred_customers         enable row level security;
alter table public.acquisition_ledger_entries enable row level security;
alter table public.pitch_library              enable row level security;

-- Start from nothing, then grant exactly what the app needs.
revoke all on all tables in schema public from anon, authenticated;

grant select on public.user_profiles, public.orders, public.transactions,
  public.acquisition_participants, public.lead_payouts, public.referred_customers,
  public.acquisition_ledger_entries, public.pitch_library
  to authenticated;

-- Editable columns only: never wallet_balance, card fields or referral status.
grant update (name, username, push_token) on public.user_profiles to authenticated;
grant update (bank_account_number, bank_code, bank_name, paystack_recipient_code)
  on public.acquisition_participants to authenticated;

create policy "own profile or admin" on public.user_profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());
create policy "edit own profile" on public.user_profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "own orders or admin" on public.orders
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy "own transactions or admin" on public.transactions
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy "own participant or admin" on public.acquisition_participants
  for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "edit own bank details" on public.acquisition_participants
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own payouts or admin" on public.lead_payouts
  for select to authenticated using (
    public.is_admin() or exists (
      select 1 from public.acquisition_participants p
      where p.id = participant_id and p.user_id = auth.uid()));

create policy "own referrals or admin" on public.referred_customers
  for select to authenticated using (
    public.is_admin() or exists (
      select 1 from public.acquisition_participants p
      where p.id = participant_id and p.user_id = auth.uid()));

create policy "admin ledger" on public.acquisition_ledger_entries
  for select to authenticated using (public.is_admin());

create policy "active pitches" on public.pitch_library
  for select to authenticated using (active or public.is_admin());

-- Functions are private by default; grants below open only what's needed.
alter default privileges in schema public revoke execute on functions from public;

-- ─────────────────────────────────────────────────────────────────────────────
-- New user → profile
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, email, username, name)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data ->> 'username', ''), split_part(new.email, '@', 1)),
    nullif(new.raw_user_meta_data ->> 'name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────────────────
-- Wallet
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.debit_wallet(p_user_id uuid, p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_balance numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  update user_profiles
  set wallet_balance = wallet_balance - p_amount
  where id = p_user_id and wallet_balance >= p_amount
  returning wallet_balance into v_new_balance;

  if v_new_balance is null then
    raise exception 'INSUFFICIENT_BALANCE';
  end if;
  return v_new_balance;
end;
$$;

-- Credits the wallet and records the transaction together. Returns the new
-- balance, or NULL if this reference was already credited (duplicate webhook,
-- double refund) — in which case nothing changes.
create or replace function public.credit_wallet(
  p_user_id uuid, p_amount numeric, p_reference text, p_description text)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_balance numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT';
  end if;
  if p_reference is null or p_reference = '' then
    raise exception 'REFERENCE_REQUIRED';
  end if;

  insert into transactions (user_id, amount, type, reference, description)
  values (p_user_id, p_amount, 'credit', p_reference, p_description)
  on conflict (reference) where type = 'credit' and reference is not null do nothing;
  if not found then
    return null;
  end if;

  update user_profiles
  set wallet_balance = wallet_balance + p_amount
  where id = p_user_id
  returning wallet_balance into v_new_balance;
  if v_new_balance is null then
    raise exception 'USER_NOT_FOUND';
  end if;
  return v_new_balance;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Order expiry (refund to wallet)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.process_order_expiry(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_new_balance numeric;
  v_refund_ref text;
begin
  select id, user_id, amount_paid, status, project_name, order_reference, created_at
  into v_order
  from orders where id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'reason', 'not_found');
  end if;
  if v_order.status <> 'pending' then
    return jsonb_build_object('success', false, 'reason', 'already_handled', 'status', v_order.status);
  end if;
  -- Matches OTP_TIMEOUT (5 min) in the app; nobody can refund an order early.
  if v_order.created_at > now() - interval '5 minutes' then
    return jsonb_build_object('success', false, 'reason', 'too_early', 'status', v_order.status);
  end if;

  update orders set status = 'expired' where id = p_order_id;

  v_refund_ref := 'timeout_' || coalesce(v_order.order_reference, p_order_id::text);
  v_new_balance := credit_wallet(
    v_order.user_id, v_order.amount_paid, v_refund_ref,
    'Auto-refund: ' || coalesce(v_order.project_name, 'Purchase') || ' — OTP not received within window');

  return jsonb_build_object(
    'success', true,
    'refund_amount', v_order.amount_paid,
    'new_balance', v_new_balance,
    'user_id', v_order.user_id,
    'project_name', v_order.project_name);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ambassador program
--
-- Rules (as shown to ambassadors in app/acquisition-program.tsx):
--  • Qualification: 76 validated customers within 30 days of enrolling. Unpaid.
--    Miss the window → count resets, re-enroll to try again.
--  • At 76 the ambassador becomes an active Customer Acquisition Lead at once;
--    month 1 (a rolling 30-day window) starts immediately.
--  • Each paid month: customer 38 → ₦50,000 payout under review (half 1);
--    customer 76 → ₦50,000 (half 2) and the next month starts immediately.
--  • Month ends before 76 → paid pro rata (₦100,000 / 76 per customer, minus
--    half 1 if already created), then the Lead must re-qualify.
--  • Six paid months maximum (₦600,000). Every payout is reviewed by admin.
--  • A customer counts once: first paid number, unique normalised email,
--    no self-referral (enforced in apply-referral-code).
--  • Window numbering: referred_customers.block_number = 0 for qualification,
--    N for paid month N (= paid_periods_completed + 1 at the time).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.close_expired_blocks(p_participant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_p record;
  v_block integer;
  v_per_customer numeric := 100000.0 / 76;
  v_earned numeric;
  v_half1 numeric;
  v_amount numeric;
  v_payout_id uuid;
  v_new_status text;
begin
  select * into v_p from acquisition_participants where id = p_participant_id for update;
  if not found then
    return jsonb_build_object('closed', false, 'reason', 'not_found');
  end if;

  -- Qualification window over without reaching 76.
  if v_p.status = 'qualifying'
     and v_p.qualification_start_date is not null
     and now() >= v_p.qualification_start_date + interval '30 days' then
    update acquisition_participants
    set status = 'needs_requalification', qualification_customers_count = 0
    where id = v_p.id;
    return jsonb_build_object('closed', true, 'block_number', 0,
      'count', v_p.qualification_customers_count, 'new_status', 'needs_requalification');
  end if;

  -- Paid month over without reaching 76: pay pro rata, then re-qualify.
  if v_p.status = 'active_lead'
     and v_p.paid_period_start_date is not null
     and now() >= v_p.paid_period_start_date + interval '30 days' then
    v_block := v_p.paid_periods_completed + 1;
    v_earned := round(v_p.qualification_customers_count * v_per_customer, 2);
    select coalesce(sum(amount), 0) into v_half1
    from lead_payouts
    where participant_id = v_p.id and block_number = v_block and cycle_number = 1;
    v_amount := v_earned - v_half1;

    if v_amount > 0 then
      insert into lead_payouts (participant_id, cycle_number, monthly_window_start, amount,
        customers_in_cycle, status, period_start_timestamp, block_number)
      values (v_p.id, case when v_half1 > 0 then 2 else 1 end, v_p.paid_period_start_date::date,
        v_amount, v_p.qualification_customers_count - case when v_half1 > 0 then 38 else 0 end,
        'under_review', v_p.paid_period_start_date, v_block)
      returning id into v_payout_id;

      update referred_customers set payout_id = v_payout_id
      where participant_id = v_p.id and block_number = v_block and validated and payout_id is null;
    end if;

    v_new_status := case when v_block >= 6 then 'contract_complete' else 'needs_requalification' end;
    update acquisition_participants
    set status = v_new_status,
        paid_periods_completed = v_block,
        paid_period_end_date = v_p.paid_period_start_date + interval '30 days',
        qualification_customers_count = 0
    where id = v_p.id;

    return jsonb_build_object('closed', true, 'block_number', v_block,
      'count', v_p.qualification_customers_count, 'new_status', v_new_status,
      'payout_id', v_payout_id, 'payout_amount', greatest(v_amount, 0));
  end if;

  return jsonb_build_object('closed', false);
end;
$$;

create or replace function public.close_all_expired_blocks()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_closed integer := 0;
begin
  for v_id in
    select id from acquisition_participants where status in ('qualifying', 'active_lead')
  loop
    if (close_expired_blocks(v_id) ->> 'closed')::boolean then
      v_closed := v_closed + 1;
    end if;
  end loop;
  return v_closed;
end;
$$;

-- Completes an order with its OTP and applies the ambassador rules above.
-- Return shape is what supabase/functions/confirm-otp expects.
create or replace function public.complete_order_with_otp(p_order_id uuid, p_otp text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_ref record;
  v_p record;
  v_counted boolean := false;
  v_new_count integer;
  v_new_status text;
  v_block integer;
  v_h1 uuid;
  v_h2 uuid;
  v_dupe boolean;
begin
  if p_otp is null or btrim(p_otp) = '' then
    return jsonb_build_object('result', 'no_otp');
  end if;

  select id, user_id, status into v_order from orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_order.status <> 'pending' then
    return jsonb_build_object('result', 'not_pending', 'status', v_order.status);
  end if;

  update orders set otp = btrim(p_otp), status = 'completed' where id = p_order_id;

  select * into v_ref from referred_customers where customer_id = v_order.user_id for update;

  insert into acquisition_ledger_entries (order_id, amount, participant_id, entry_type)
  values (p_order_id, 1500, v_ref.participant_id,
          case when v_ref.id is not null then 'lead_obligation' else 'unattributed_profit' end)
  on conflict (order_id) do nothing;

  -- Only a referred customer's first completed number can count.
  if v_ref.id is null or v_ref.validated then
    return jsonb_build_object('result', 'completed', 'status', 'completed', 'otp', btrim(p_otp), 'counted', false);
  end if;

  -- Close any window that ran out, so this customer lands in the right one.
  perform close_expired_blocks(v_ref.participant_id);
  select * into v_p from acquisition_participants where id = v_ref.participant_id for update;

  select exists (
    select 1 from referred_customers
    where validated and email_normalized = v_ref.email_normalized and id <> v_ref.id
  ) into v_dupe;

  if v_ref.email_normalized is not null and v_dupe then
    update referred_customers
    set validated = true, validated_at = now(), first_purchase_at = coalesce(first_purchase_at, now()),
        order_id = p_order_id, validation_note = 'duplicate_email'
    where id = v_ref.id;
    return jsonb_build_object('result', 'completed', 'status', 'completed', 'otp', btrim(p_otp), 'counted', false);
  end if;

  if v_p.status = 'qualifying' then
    v_block := 0;
    v_new_count := v_p.qualification_customers_count + 1;
    v_counted := true;
    v_new_status := 'qualifying';

    if v_new_count >= 76 then
      v_new_count := 76;
      v_new_status := 'active_lead';
      update acquisition_participants
      set status = 'active_lead',
          qualification_customers_count = 0,
          paid_period_start_date = now(),
          paid_period_end_date = null,
          active_lead_start_month = current_date,
          original_activation_timestamp = coalesce(original_activation_timestamp, now())
      where id = v_p.id;
    else
      update acquisition_participants set qualification_customers_count = v_new_count where id = v_p.id;
    end if;

  elsif v_p.status = 'active_lead' then
    v_block := v_p.paid_periods_completed + 1;
    v_new_count := v_p.qualification_customers_count + 1;
    v_counted := true;
    v_new_status := 'active_lead';
  end if;

  update referred_customers
  set validated = true,
      validated_at = now(),
      first_purchase_at = coalesce(first_purchase_at, now()),
      order_id = p_order_id,
      block_number = case when v_counted then v_block else null end,
      current_cycle_number = case
        when v_counted and v_block > 0 then case when v_new_count <= 38 then 1 else 2 end
        else null end,
      validation_note = case when v_counted then null else 'not_in_window:' || v_p.status end
  where id = v_ref.id;

  if v_counted and v_block > 0 then
    if v_new_count = 38 then
      insert into lead_payouts (participant_id, cycle_number, monthly_window_start, amount,
        customers_in_cycle, status, period_start_timestamp, block_number)
      values (v_p.id, 1, v_p.paid_period_start_date::date, 50000, 38, 'under_review',
        v_p.paid_period_start_date, v_block)
      on conflict (participant_id, block_number, cycle_number) do nothing
      returning id into v_h1;
      update referred_customers set payout_id = v_h1
      where participant_id = v_p.id and block_number = v_block and validated and payout_id is null
        and v_h1 is not null;
    end if;

    if v_new_count >= 76 then
      insert into lead_payouts (participant_id, cycle_number, monthly_window_start, amount,
        customers_in_cycle, status, period_start_timestamp, block_number)
      values (v_p.id, 2, v_p.paid_period_start_date::date, 50000, 38, 'under_review',
        v_p.paid_period_start_date, v_block)
      on conflict (participant_id, block_number, cycle_number) do nothing
      returning id into v_h2;
      update referred_customers set payout_id = v_h2
      where participant_id = v_p.id and block_number = v_block and validated and payout_id is null
        and v_h2 is not null;

      v_new_status := case when v_block >= 6 then 'contract_complete' else 'active_lead' end;
      update acquisition_participants
      set paid_periods_completed = v_block,
          paid_period_end_date = now(),
          qualification_customers_count = 0,
          paid_period_start_date = case when v_block >= 6 then paid_period_start_date else now() end,
          status = v_new_status
      where id = v_p.id;
    else
      update acquisition_participants set qualification_customers_count = v_new_count where id = v_p.id;
    end if;
  end if;

  return jsonb_build_object(
    'result', 'completed',
    'status', 'completed',
    'otp', btrim(p_otp),
    'counted', v_counted,
    'new_count', v_new_count,
    'participant_id', v_p.id,
    'new_status', v_new_status,
    'payout_created', (v_h1 is not null or v_h2 is not null),
    'payout_h1_id', v_h1,
    'payout_h2_id', v_h2);
end;
$$;

-- Called by the app. Creates the caller's ambassador record in a safe state.
create or replace function public.enroll_in_program(p_name text)
returns public.acquisition_participants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row acquisition_participants;
  v_base text;
  v_code text;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'NAME_REQUIRED';
  end if;

  select * into v_row from acquisition_participants where user_id = v_uid;
  if found then
    return v_row;
  end if;

  v_base := rpad(left(regexp_replace(upper(p_name), '[^A-Z0-9]', '', 'g'), 4), 4, 'X');
  loop
    v_code := 'NV' || v_base || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4));
    exit when not exists (select 1 from acquisition_participants where referral_code = v_code);
  end loop;

  insert into acquisition_participants (user_id, name, referral_code, status,
    qualification_start_date, qualification_customers_count)
  values (v_uid, btrim(p_name), v_code, 'qualifying', now(), 0)
  returning * into v_row;
  return v_row;
end;
$$;

-- Called by the app. Starts a fresh 30-day qualification when the previous one
-- (or a paid month) ended without reaching 76.
create or replace function public.reenroll_in_program()
returns public.acquisition_participants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row acquisition_participants;
begin
  select * into v_row from acquisition_participants where user_id = auth.uid() for update;
  if not found then
    raise exception 'NOT_ENROLLED';
  end if;

  perform close_expired_blocks(v_row.id);
  select * into v_row from acquisition_participants where id = v_row.id;

  if v_row.status not in ('needs_requalification', 'inactive') then
    raise exception 'CANNOT_REENROLL_FROM_%', upper(v_row.status);
  end if;

  update acquisition_participants
  set status = 'qualifying', qualification_start_date = now(), qualification_customers_count = 0
  where id = v_row.id
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.enroll_in_program(text) to authenticated;
grant execute on function public.reenroll_in_program() to authenticated;
