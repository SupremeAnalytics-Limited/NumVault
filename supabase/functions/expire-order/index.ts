import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    // Verify the caller is authenticated
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    const { order_id } = await req.json();
    if (!order_id) {
      return new Response(JSON.stringify({ error: 'order_id is required' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    // Fetch the order — must belong to this user and still be pending
    const { data: order, error: orderErr } = await supabaseAdmin
      .from('orders')
      .select('id, user_id, amount_paid, status, project_name, order_reference')
      .eq('id', order_id)
      .single();

    if (orderErr || !order) {
      console.error('expire-order: order not found', orderErr);
      return new Response(JSON.stringify({ error: 'Order not found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 404,
      });
    }

    // Only the owning user may expire their own order
    if (order.user_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 403,
      });
    }

    // Idempotency: already expired — just return success with no double-refund
    if (order.status !== 'pending') {
      console.log(`expire-order: order ${order_id} already in status '${order.status}', skipping refund`);
      return new Response(JSON.stringify({
        refunded: false,
        already_expired: true,
        status: order.status,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const paidAmount = Number(order.amount_paid);

    // Atomically flip pending → expired, and verify we actually won the race.
    // Using .select('id') so Supabase returns the rows that were actually modified.
    // If the UPDATE touches 0 rows it means the status changed between our read and write
    // (OTP arrived → 'completed', or another expire-order call got here first → 'expired').
    // In both cases we must NOT credit the wallet.
    const { data: flippedRows, error: expireErr } = await supabaseAdmin
      .from('orders')
      .update({ status: 'expired' })
      .eq('id', order_id)
      .eq('status', 'pending') // guard: only flip pending → expired
      .select('id');

    if (expireErr) {
      console.error('expire-order: failed to expire order', expireErr);
      return new Response(JSON.stringify({ error: 'Failed to update order status' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      });
    }

    // No rows flipped — status changed between our read and write.
    // Re-read to surface the actual current status to the caller.
    if (!flippedRows || flippedRows.length === 0) {
      const { data: recheck } = await supabaseAdmin
        .from('orders')
        .select('status')
        .eq('id', order_id)
        .single();
      const currentStatus = recheck?.status ?? 'unknown';
      console.log(`expire-order: UPDATE touched 0 rows for order ${order_id} — current status: ${currentStatus}`);
      // If it's 'completed' the OTP arrived; if 'expired' another call got here first.
      // Either way: no wallet credit, no error.
      return new Response(JSON.stringify({
        refunded: false,
        already_handled: true,
        status: currentStatus,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Credit wallet_balance — fetch current balance then increment
    const { data: profileNow, error: profileErr } = await supabaseAdmin
      .from('user_profiles')
      .select('wallet_balance')
      .eq('id', user.id)
      .single();

    if (profileErr || !profileNow) {
      console.error('expire-order: could not read wallet balance', profileErr);
      // Order is already expired — don't fail the whole call, just log
      return new Response(JSON.stringify({
        refunded: false,
        expired: true,
        error: 'Could not credit wallet — contact support',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 207,
      });
    }

    const newBalance = Number(profileNow.wallet_balance) + paidAmount;
    const { error: creditErr } = await supabaseAdmin
      .from('user_profiles')
      .update({ wallet_balance: newBalance })
      .eq('id', user.id);

    if (creditErr) {
      console.error('expire-order: wallet credit failed', creditErr);
      return new Response(JSON.stringify({
        refunded: false,
        expired: true,
        error: 'Order expired but wallet credit failed — contact support',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 207,
      });
    }

    // Insert refund transaction record
    const refundRef = order.order_reference
      ? `timeout_${order.order_reference}`
      : `timeout_${order_id.slice(0, 8)}_${Date.now()}`;

    await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      amount: paidAmount,
      type: 'credit',
      reference: refundRef,
      description: `Auto-refund: ${order.project_name || 'Purchase'} OTP not received within window`,
    });

    console.log(`expire-order: refunded ₦${paidAmount} to user ${user.id} for order ${order_id}`);

    // Send push notification if the user has a registered push token
    try {
      const { data: profileForPush } = await supabaseAdmin
        .from('user_profiles')
        .select('push_token')
        .eq('id', user.id)
        .single();

      if (profileForPush?.push_token) {
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: profileForPush.push_token,
            title: '\u{1F4B0} Refund Processed',
            body: `No OTP was received for ${order.project_name || 'your purchase'}. \u20a6${paidAmount.toLocaleString()} has been refunded to your wallet.`,
            data: { type: 'expire_refund', order_id: order_id, amount: paidAmount },
            sound: 'default',
            priority: 'high',
          }),
        });
        console.log(`expire-order: push notification sent to user ${user.id}`);
      }
    } catch (pushErr) {
      // Non-fatal — refund already succeeded; just log the push failure
      console.warn(`expire-order: push notification failed for user ${user.id}:`, pushErr);
    }

    return new Response(JSON.stringify({
      refunded: true,
      refund_amount: paidAmount,
      new_balance: newBalance,
      status: 'expired',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('expire-order unhandled error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
