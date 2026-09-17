import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

// auto-expire-orders — server-side scheduled expiry scanner
//
// Scans for pending orders older than OTP_TIMEOUT_MINUTES, atomically flips them to
// 'expired', and credits each user's wallet with the amount paid.
//
// Invoke via:
//   - Supabase scheduled cron (recommended): every 2 minutes
//   - Manual HTTP call with service-role key for testing
//
// Idempotent: uses optimistic locking (.eq('status','pending')) so concurrent runs
// never double-credit. Each order is processed at most once.

const OTP_TIMEOUT_MINUTES = 5; // must match OTP_TIMEOUT in constants/config.ts (300_000 ms)

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    // Accept both service-role (cron) and anon (manual test) callers.
    // For cron invocations the scheduler sends the service-role key directly.
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const cutoff = new Date(Date.now() - OTP_TIMEOUT_MINUTES * 60 * 1000).toISOString();
    console.log(`auto-expire-orders: scanning pending orders created before ${cutoff}`);

    // Fetch all pending orders older than the timeout window
    const { data: staleOrders, error: fetchErr } = await supabaseAdmin
      .from('orders')
      .select('id, user_id, amount_paid, project_name, order_reference, created_at')
      .eq('status', 'pending')
      .lt('created_at', cutoff);

    if (fetchErr) {
      console.error('auto-expire-orders: fetch error', fetchErr);
      return new Response(JSON.stringify({ error: fetchErr.message }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      });
    }

    if (!staleOrders || staleOrders.length === 0) {
      console.log('auto-expire-orders: no stale orders found');
      return new Response(JSON.stringify({ processed: 0, expired: [], skipped: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`auto-expire-orders: found ${staleOrders.length} stale pending order(s)`);

    const expired: string[] = [];
    const skipped: string[] = [];

    for (const order of staleOrders) {
      const orderId: string = order.id;
      const userId: string = order.user_id;
      const paidAmount = Number(order.amount_paid);

      // Optimistic lock: only UPDATE if still pending (race-safe)
      const { data: flipped, error: flipErr } = await supabaseAdmin
        .from('orders')
        .update({ status: 'expired' })
        .eq('id', orderId)
        .eq('status', 'pending') // guard
        .select('id');

      if (flipErr) {
        console.error(`auto-expire-orders: failed to flip order ${orderId}`, flipErr);
        skipped.push(orderId);
        continue;
      }

      if (!flipped || flipped.length === 0) {
        // Status changed between fetch and update (OTP arrived or already expired)
        console.log(`auto-expire-orders: order ${orderId} status changed before update, skipping`);
        skipped.push(orderId);
        continue;
      }

      // Credit wallet
      const { data: profile, error: profileErr } = await supabaseAdmin
        .from('user_profiles')
        .select('wallet_balance')
        .eq('id', userId)
        .single();

      if (profileErr || !profile) {
        console.error(`auto-expire-orders: could not read wallet for user ${userId}`, profileErr);
        // Order already expired; log for manual resolution
        skipped.push(orderId);
        continue;
      }

      const newBalance = Number(profile.wallet_balance) + paidAmount;

      const { error: creditErr } = await supabaseAdmin
        .from('user_profiles')
        .update({ wallet_balance: newBalance })
        .eq('id', userId);

      if (creditErr) {
        console.error(`auto-expire-orders: wallet credit failed for user ${userId}`, creditErr);
        skipped.push(orderId);
        continue;
      }

      // Insert refund transaction record
      const refundRef = order.order_reference
        ? `timeout_${order.order_reference}`
        : `timeout_auto_${orderId.slice(0, 8)}_${Date.now()}`;

      await supabaseAdmin.from('transactions').insert({
        user_id: userId,
        amount: paidAmount,
        type: 'credit',
        reference: refundRef,
        description: `Auto-refund: ${order.project_name || 'Purchase'} OTP not received within ${OTP_TIMEOUT_MINUTES} minutes`,
      });

      console.log(`auto-expire-orders: refunded ₦${paidAmount} to user ${userId} for order ${orderId}`);

      // Send push notification to user if they have a registered push token
      try {
        const { data: profileForPush } = await supabaseAdmin
          .from('user_profiles')
          .select('push_token')
          .eq('id', userId)
          .single();

        if (profileForPush?.push_token) {
          await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: profileForPush.push_token,
              title: '💰 Refund Processed',
              body: `No OTP was received for ${order.project_name || 'your purchase'}. ₦${paidAmount.toLocaleString()} has been refunded to your wallet.`,
              data: { type: 'auto_refund', order_id: orderId, amount: paidAmount },
              sound: 'default',
              priority: 'high',
            }),
          });
          console.log(`auto-expire-orders: push notification sent to user ${userId}`);
        }
      } catch (pushErr) {
        // Non-fatal — refund already succeeded; just log the push failure
        console.warn(`auto-expire-orders: push notification failed for user ${userId}:`, pushErr);
      }

      expired.push(orderId);
    }

    return new Response(JSON.stringify({
      processed: staleOrders.length,
      expired,
      skipped,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('auto-expire-orders unhandled error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
