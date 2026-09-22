import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { fetchSociallyOtp } from '../_shared/socially-otp.ts';

// auto-expire-orders — server-side scheduled expiry scanner
//
// Scans for pending orders older than OTP_TIMEOUT_MINUTES, then calls the
// `process_order_expiry` database function for each one. That function wraps
// status flip + atomic wallet increment + transaction record in a single
// PostgreSQL transaction — if any step fails the whole thing rolls back and
// the order remains pending so the next cron run can retry cleanly.
//
// Authoritative sequence per order:
//   process_order_expiry RPC
//     → order marked expired
//     → wallet_balance credited atomically
//     → refund transaction created
//     → successful RPC response
//   → send push notification   ← OUTSIDE the DB transaction, non-fatal
//
// Idempotent: the RPC uses FOR UPDATE + status check, so concurrent cron runs
// and client-triggered expire-order calls are safe — only one commits.

const OTP_TIMEOUT_MINUTES = 5; // must match OTP_TIMEOUT in constants/config.ts (300_000 ms)

// ── auto-expire-orders schedule note ──────────────────────────────────────────
// This function is triggered by the OnSpace/Supabase cron scheduler.
// It runs every 1 minute via a pg_cron job configured in the Supabase dashboard
// (or via the Edge Function scheduler). Each invocation scans all pending orders
// older than OTP_TIMEOUT_MINUTES (5 min) and expires + refunds them.
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // ── Socially.ng balance check on every run ─────────────────────────────────
    // Fire-and-forget with a 5 s timeout so it can never stall the expiry run.
    (() => {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5_000);
      const supabaseUrl2 = Deno.env.get('SUPABASE_URL') ?? '';
      const svcKey2 = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
      fetch(`${supabaseUrl2}/functions/v1/ensure-socially-balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${svcKey2}` },
        body: JSON.stringify({}),
        signal: controller.signal,
      }).then(() => clearTimeout(tid)).catch(() => clearTimeout(tid));
    })();
    // ─────────────────────────────────────────────────────────────────────────

    const cutoff = new Date(Date.now() - OTP_TIMEOUT_MINUTES * 60 * 1000).toISOString();
    console.log(`auto-expire-orders: scanning pending orders created before ${cutoff}`);

    // Fetch all pending orders older than the timeout window.
    const { data: staleOrders, error: fetchErr } = await supabaseAdmin
      .from('orders')
      .select('id, user_id, amount_paid, project_name, order_reference')
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
      const orderId: string     = order.id;
      const userId: string      = order.user_id;
      const projectName: string = order.project_name ?? 'Purchase';

      // If the OTP did arrive, the customer got what they paid for: complete, don't refund.
      const lateOtp = await fetchSociallyOtp(order.order_reference ?? '');
      if (lateOtp) {
        const { error: completeErr } = await supabaseAdmin.rpc('complete_order_with_otp', {
          p_order_id: orderId, p_otp: lateOtp,
        });
        if (completeErr) console.error(`auto-expire-orders: complete failed for ${orderId}`, completeErr);
        else console.log(`auto-expire-orders: OTP had arrived for ${orderId} — completed instead of refunding`);
        skipped.push(orderId);
        continue;
      }

      // ── Atomic expiry: one DB transaction does expire + credit + tx record ──
      const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
        'process_order_expiry',
        { p_order_id: orderId }
      );

      if (rpcErr) {
        console.error(`auto-expire-orders: RPC failed for order ${orderId}`, rpcErr);
        skipped.push(orderId);
        continue;
      }

      if (!rpcResult.success) {
        // Already handled by expire-order or a concurrent cron run — not an error
        console.log(`auto-expire-orders: order ${orderId} already handled (${rpcResult.reason}), skipping`);
        skipped.push(orderId);
        continue;
      }

      const refundAmount = Number(rpcResult.refund_amount);
      console.log(`auto-expire-orders: refunded ₦${refundAmount} to user ${userId} for order ${orderId}`);

      // ── DB committed — now send push notification (non-fatal if it fails) ──
      // The wallet credit and transaction record are already persisted.
      try {
        const { data: profile } = await supabaseAdmin
          .from('user_profiles')
          .select('push_token')
          .eq('id', userId)
          .single();

        if (profile?.push_token) {
          const pushRes = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: profile.push_token,
              title: '💰 Refund Processed',
              body: `No OTP was received for ${projectName}. ₦${refundAmount.toLocaleString()} has been refunded to your wallet.`,
              data: { type: 'auto_refund', order_id: orderId, amount: refundAmount },
              sound: 'default',
              priority: 'high',
            }),
          });

          if (!pushRes.ok) {
            const pushBody = await pushRes.text().catch(() => '(unreadable body)');
            console.error(`auto-expire-orders: Expo push API HTTP error ${pushRes.status} for user ${userId}:`, pushBody);
          } else {
            const pushJson = await pushRes.json().catch(() => null);
            const pushStatus = pushJson?.data?.[0]?.status ?? pushJson?.data?.status;
            const pushError  = pushJson?.data?.[0]?.message ?? pushJson?.errors;
            if (pushStatus === 'error' || pushError) {
              console.error(`auto-expire-orders: Expo push API returned error for user ${userId}:`, pushJson);
            } else {
              console.log(`auto-expire-orders: push notification accepted by Expo for user ${userId}`);
            }
          }
        } else {
          console.log(`auto-expire-orders: no push_token for user ${userId}, skipping notification`);
        }
      } catch (pushErr) {
        // Non-fatal — refund is already committed
        console.warn(`auto-expire-orders: push notification threw for user ${userId}:`, pushErr);
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
