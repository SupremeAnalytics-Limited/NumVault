import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

// expire-order — client-triggered order expiry
//
// Called by the app (OrderContext watcher or number-display fallback) when a
// pending order exceeds OTP_TIMEOUT. Delegates the actual expire → credit →
// transaction-record work to the `process_order_expiry` database function,
// which runs all three writes inside one PostgreSQL transaction so a partial
// failure can never leave the wallet short-changed or the order stuck.
//
// Authoritative sequence:
//   process_order_expiry RPC
//     → order marked expired
//     → wallet_balance credited atomically
//     → refund transaction created
//     → successful RPC response
//   → refresh wallet / order state on client
//   → send push notification   ← OUTSIDE the DB transaction, non-fatal
//
// Push notification is sent AFTER the DB commit so a notification failure can
// NEVER cause the refund to be rolled back or appear as missing.

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

    // Ownership check: fetch order before delegating to RPC so we can
    // reject cross-user expiry attempts at the edge layer.
    const { data: order, error: orderErr } = await supabaseAdmin
      .from('orders')
      .select('id, user_id, status, amount_paid, project_name')
      .eq('id', order_id)
      .single();

    if (orderErr || !order) {
      console.error('expire-order: order not found', orderErr);
      return new Response(JSON.stringify({ error: 'Order not found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 404,
      });
    }

    if (order.user_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 403,
      });
    }

    // Fast-path: already handled (avoids the RPC round-trip for the common case)
    if (order.status !== 'pending') {
      console.log(`expire-order: order ${order_id} already '${order.status}', skipping`);
      return new Response(JSON.stringify({
        refunded: false,
        already_handled: true,
        status: order.status,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Atomic expiry: one DB transaction does expire + credit + tx record ──
    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
      'process_order_expiry',
      { p_order_id: order_id }
    );

    if (rpcErr) {
      console.error('expire-order: process_order_expiry RPC failed', rpcErr);
      return new Response(JSON.stringify({
        error: 'Refund transaction failed — please contact support if your balance is incorrect',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      });
    }

    // RPC reported the order was already handled by a concurrent caller
    if (!rpcResult.success) {
      const reason = rpcResult.reason ?? 'unknown';
      console.log(`expire-order: RPC returned success=false, reason=${reason}, status=${rpcResult.status}`);
      return new Response(JSON.stringify({
        refunded: false,
        already_handled: true,
        status: rpcResult.status ?? order.status,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── DB committed — now send push notification (non-fatal if it fails) ──
    // The wallet credit and transaction record are already persisted.
    // Any error below must not affect the refund or the response to the client.
    const refundAmount = Number(rpcResult.refund_amount);
    const newBalance   = Number(rpcResult.new_balance);
    const projectName  = rpcResult.project_name ?? order.project_name ?? 'your purchase';

    console.log(`expire-order: refunded ₦${refundAmount} to user ${user.id} for order ${order_id}`);

    try {
      const { data: profile } = await supabaseAdmin
        .from('user_profiles')
        .select('push_token')
        .eq('id', user.id)
        .single();

      if (profile?.push_token) {
        const pushRes = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: profile.push_token,
            title: '\u{1F4B0} Refund Processed',
            body: `No OTP was received for ${projectName}. \u20a6${refundAmount.toLocaleString()} has been refunded to your wallet.`,
            data: { type: 'expire_refund', order_id, amount: refundAmount },
            sound: 'default',
            priority: 'high',
          }),
        });

        if (!pushRes.ok) {
          const pushBody = await pushRes.text().catch(() => '(unreadable body)');
          console.error(`expire-order: Expo push API HTTP error ${pushRes.status} for user ${user.id}:`, pushBody);
        } else {
          const pushJson = await pushRes.json().catch(() => null);
          const pushStatus = pushJson?.data?.[0]?.status ?? pushJson?.data?.status;
          const pushError  = pushJson?.data?.[0]?.message ?? pushJson?.errors;
          if (pushStatus === 'error' || pushError) {
            console.error(`expire-order: Expo push API returned error for user ${user.id}:`, pushJson);
          } else {
            console.log(`expire-order: push notification accepted by Expo for user ${user.id}`);
          }
        }
      } else {
        console.log(`expire-order: no push_token for user ${user.id}, skipping notification`);
      }
    } catch (pushErr) {
      // Non-fatal: refund is already committed — just log
      console.warn(`expire-order: push notification threw for user ${user.id}:`, pushErr);
    }

    return new Response(JSON.stringify({
      refunded: true,
      refund_amount: refundAmount,
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
