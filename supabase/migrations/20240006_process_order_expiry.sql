-- 20240006_process_order_expiry.sql
-- Adds the process_order_expiry() RPC used by expire-order and auto-expire-orders
-- edge functions to atomically expire an order, credit the wallet, and record the
-- refund transaction in a single PostgreSQL transaction.
-- If any step fails the entire transaction rolls back — the order stays 'pending'
-- and the next retry will re-attempt cleanly.

create or replace function process_order_expiry(p_order_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_order       record;
  v_new_balance numeric(12,2);
  v_refund_ref  text;
begin
  -- Acquire a row-level lock so concurrent calls serialise here.
  -- The second caller will see status != 'pending' and return early.
  select id, user_id, amount_paid, status, project_name, order_reference
  into   v_order
  from   orders
  where  id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'reason', 'not_found');
  end if;

  -- Idempotency guard
  if v_order.status != 'pending' then
    return jsonb_build_object(
      'success', false,
      'reason',  'already_handled',
      'status',  v_order.status
    );
  end if;

  -- 1. Flip order to expired
  update orders
  set    status = 'expired'
  where  id = p_order_id;

  -- 2. Atomic wallet increment (no read → add → write race)
  update user_profiles
  set    wallet_balance = wallet_balance + v_order.amount_paid
  where  id = v_order.user_id
  returning wallet_balance into v_new_balance;

  if not found then
    raise exception 'user_profile not found for user %', v_order.user_id;
  end if;

  -- 3. Refund transaction record (same transaction)
  v_refund_ref := case
    when v_order.order_reference is not null
      then 'timeout_' || v_order.order_reference
    else 'timeout_' || left(p_order_id::text, 8) || '_' || extract(epoch from now())::bigint::text
  end;

  insert into transactions (user_id, amount, type, reference, description)
  values (
    v_order.user_id,
    v_order.amount_paid,
    'credit',
    v_refund_ref,
    'Auto-refund: ' || coalesce(v_order.project_name, 'Purchase') || ' — OTP not received within window'
  );

  return jsonb_build_object(
    'success',       true,
    'refund_amount', v_order.amount_paid,
    'new_balance',   v_new_balance,
    'user_id',       v_order.user_id,
    'project_name',  v_order.project_name
  );
end;
$$;
