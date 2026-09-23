-- Qualification checkpoints: every 19 validated customers (19, 38, 57) is
-- saved. When a qualifying ambassador's 30 days end before 76, they keep the
-- last checkpoint reached and the next 30-day window starts straight away.
-- Below 19 the count still resets and they must re-enroll. Paid Leads are
-- unchanged (30-day months, no carry-over).

alter table public.acquisition_participants
  add column if not exists qualification_carried_over integer not null default 0
  check (qualification_carried_over in (0, 19, 38, 57));

comment on column public.acquisition_participants.qualification_carried_over is
  'Checkpoint carried into the current qualification window (0, 19, 38 or 57)';

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
  v_windows integer;
  v_carry integer;
begin
  select * into v_p from acquisition_participants where id = p_participant_id for update;
  if not found then
    return jsonb_build_object('closed', false, 'reason', 'not_found');
  end if;

  -- Qualification window over without reaching 76: keep the last checkpoint.
  if v_p.status = 'qualifying'
     and v_p.qualification_start_date is not null
     and now() >= v_p.qualification_start_date + interval '30 days' then
    v_carry := least(57, (v_p.qualification_customers_count / 19) * 19);

    if v_carry > 0 then
      -- Windows follow on from each other, even if nobody opened the app for a while.
      v_windows := floor(extract(epoch from (now() - v_p.qualification_start_date)) / (30 * 86400))::integer;
      update acquisition_participants
      set qualification_start_date = v_p.qualification_start_date + v_windows * interval '30 days',
          qualification_customers_count = v_carry,
          qualification_carried_over = v_carry
      where id = v_p.id;
      return jsonb_build_object('closed', true, 'block_number', 0,
        'count', v_p.qualification_customers_count, 'carried_over', v_carry, 'new_status', 'qualifying');
    end if;

    update acquisition_participants
    set status = 'needs_requalification', qualification_customers_count = 0, qualification_carried_over = 0
    where id = v_p.id;
    return jsonb_build_object('closed', true, 'block_number', 0,
      'count', v_p.qualification_customers_count, 'carried_over', 0, 'new_status', 'needs_requalification');
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
        qualification_customers_count = 0,
        qualification_carried_over = 0
    where id = v_p.id;

    return jsonb_build_object('closed', true, 'block_number', v_block,
      'count', v_p.qualification_customers_count, 'new_status', v_new_status,
      'payout_id', v_payout_id, 'payout_amount', greatest(v_amount, 0));
  end if;

  return jsonb_build_object('closed', false);
end;
$$;

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
  set status = 'qualifying', qualification_start_date = now(),
      qualification_customers_count = 0, qualification_carried_over = 0
  where id = v_row.id
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.close_expired_blocks(uuid) from public, anon, authenticated;
revoke execute on function public.reenroll_in_program() from public, anon;
grant execute on function public.close_expired_blocks(uuid) to service_role;
grant execute on function public.reenroll_in_program() to authenticated, service_role;
