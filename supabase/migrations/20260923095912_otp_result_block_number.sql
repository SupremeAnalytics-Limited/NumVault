-- complete_order_with_otp also returns block_number (0 = qualification,
-- N = paid month N) so notifications can tell a qualification apart from a
-- paid month. No behaviour change.

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
    'block_number', v_block,
    'payout_created', (v_h1 is not null or v_h2 is not null),
    'payout_h1_id', v_h1,
    'payout_h2_id', v_h2);
end;
$$;
revoke execute on function public.complete_order_with_otp(uuid, text) from public, anon, authenticated;
grant execute on function public.complete_order_with_otp(uuid, text) to service_role;
