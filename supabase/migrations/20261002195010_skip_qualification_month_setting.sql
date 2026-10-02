-- Admin toggle: let a new lead start earning immediately instead of doing an
-- unpaid 30-day qualification month first. OFF by default, so nothing
-- changes until the admin explicitly turns it on.
--
-- When on, enroll_in_program and reenroll_in_program put the participant
-- straight into 'active_lead' with a fresh paid_period_start_date — the same
-- state complete_order_with_otp already sets when a qualifying participant
-- reaches 76 customers. complete_order_with_otp needs no changes: its
-- `elsif v_p.status = 'active_lead'` branch already counts customers and
-- fires the ₦50,000 payouts at 38 and 76 from block 1 onward. The payout
-- total and the 6-round structure are unchanged; only the free qualifying
-- month disappears.
--
-- This only affects participants created or re-enrolled after the toggle is
-- flipped — nobody already qualifying is moved.

insert into public.app_settings (key, value) values
  ('skip_qualification_month', 'false'::jsonb)
on conflict (key) do nothing;

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
  v_skip boolean;
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

  v_skip := coalesce((select value::text::boolean from app_settings where key = 'skip_qualification_month'), false);

  if v_skip then
    insert into acquisition_participants (user_id, name, referral_code, status,
      qualification_customers_count, paid_period_start_date, paid_period_end_date,
      active_lead_start_month, original_activation_timestamp)
    values (v_uid, btrim(p_name), v_code, 'active_lead',
      0, now(), null, current_date, now())
    returning * into v_row;
  else
    insert into acquisition_participants (user_id, name, referral_code, status,
      qualification_start_date, qualification_customers_count)
    values (v_uid, btrim(p_name), v_code, 'qualifying', now(), 0)
    returning * into v_row;
  end if;

  return v_row;
end;
$$;

-- Called by the app. Starts a fresh 30-day qualification when the previous one
-- (or a paid month) ended without reaching 76 — unless skip_qualification_month
-- is on, in which case it goes straight back to a paid round instead.
create or replace function public.reenroll_in_program()
returns public.acquisition_participants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row acquisition_participants;
  v_skip boolean;
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

  v_skip := coalesce((select value::text::boolean from app_settings where key = 'skip_qualification_month'), false);

  if v_skip then
    update acquisition_participants
    set status = 'active_lead',
        qualification_customers_count = 0,
        paid_period_start_date = now(),
        paid_period_end_date = null,
        active_lead_start_month = current_date,
        original_activation_timestamp = coalesce(original_activation_timestamp, now())
    where id = v_row.id
    returning * into v_row;
  else
    update acquisition_participants
    set status = 'qualifying', qualification_start_date = now(), qualification_customers_count = 0
    where id = v_row.id
    returning * into v_row;
  end if;

  return v_row;
end;
$$;
