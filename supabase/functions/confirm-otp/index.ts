import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

/**
 * confirm-otp — client-side OTP polling endpoint
 *
 * Called by app/number-display.tsx when the user presses "Request OTP" or
 * during the polling loop. This function:
 *   1. Verifies the caller owns the order.
 *   2. Returns early if the order is not pending.
 *   3. Calls Socially.ng to check for the OTP.
 *   4. If no OTP yet, returns { status: 'pending' }.
 *   5. If OTP found, calls complete_order_with_otp() DB function (atomic).
 *   6. Sends a referral push notification to the participant (non-blocking).
 *   7. Returns the OTP to the caller.
 */
Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    // ── Auth ───────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Verify the JWT and get the caller's user_id
    const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    // ── Parse input ────────────────────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const orderId: string | undefined = body.order_id;
    if (!orderId) {
      return new Response(JSON.stringify({ error: 'order_id is required' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    // ── Fetch order — enforce ownership ────────────────────────────────────────
    const { data: order, error: orderErr } = await supabaseAdmin
      .from('orders')
      .select('id, status, user_id, order_reference, project_name')
      .eq('id', orderId)
      .single();

    if (orderErr || !order) {
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

    // ── Return current status if order is no longer pending ───────────────────
    if (order.status !== 'pending') {
      return new Response(JSON.stringify({ status: order.status }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!order.order_reference) {
      return new Response(JSON.stringify({ status: 'pending' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Ask Socially.ng for the OTP ────────────────────────────────────────────
    const otp = await fetchOTPFromSocially(supabaseAdmin, order.order_reference);

    if (!otp) {
      return new Response(JSON.stringify({ status: 'pending' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── OTP found — commit via atomic DB function ─────────────────────────────
    const { data: rpcResult, error: rpcErr } = await supabaseAdmin
      .rpc('complete_order_with_otp', { p_order_id: orderId, p_otp: otp });

    if (rpcErr) {
      console.error('complete_order_with_otp RPC error:', rpcErr);
      // A1: Do not write directly — return pending so next poll retries cleanly.
      return new Response(JSON.stringify({ status: 'pending' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('complete_order_with_otp result:', JSON.stringify(rpcResult));

    const result = rpcResult as {
      result: string;
      status?: string;
      otp?: string;
      counted?: boolean;
      new_count?: number;
      participant_id?: string;
    };

    // A2: Only return otp when DB function confirms completion.
    //     already_handled / already_handled_ledger → look up current order status.
    if (result?.result !== 'completed') {
      const { data: freshOrder } = await supabaseAdmin
        .from('orders')
        .select('status, otp')
        .eq('id', orderId)
        .maybeSingle();
      return new Response(
        JSON.stringify({ status: freshOrder?.status ?? result.result }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // A3: Await notifications (both participant + admin) before returning;
    //     errors in either must never block OTP delivery.
    const notifyPromises: Promise<void>[] = [];

    if (result.counted && result.participant_id && result.new_count !== undefined) {
      notifyPromises.push(
        sendReferralPushNotification(
          supabaseAdmin,
          result.participant_id,
          result.new_count,
        ).catch((e) => console.warn('Participant push notification error:', e)),
      );

      // B2: When count reaches 76, also push admin.
      if (result.new_count >= 76) {
        notifyPromises.push(
          notifyAdminOf76(supabaseAdmin, result.participant_id)
            .catch((e) => console.warn('Admin 76-reached notification error:', e)),
        );
      }
    }

    await Promise.all(notifyPromises);

    return new Response(JSON.stringify({ status: 'completed', otp }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('confirm-otp unhandled error:', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
    );
  }
});

// ── Socially.ng OTP fetch (same logic as sociallyService.ts getOTP) ───────────

async function fetchOTPFromSocially(
  supabase: ReturnType<typeof createClient>,
  reference: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.functions.invoke('socially-proxy', {
      body: { path: `/request/sms/verification/${reference}/otp`, method: 'GET' },
    });

    if (error) {
      console.warn('socially-proxy error:', error.message);
      return null;
    }

    // Primary: read the clean OTP directly from data.data.response
    const responseField = data?.data?.response;
    if (responseField !== undefined && responseField !== null && String(responseField).trim() !== '') {
      return String(responseField).trim();
    }

    // Fallback: parse message string, allowing optional spaces inside parens
    const message: string = data?.message || '';
    const otpMatch = message.match(/\(([\d\s]{4,12})\)/);
    if (otpMatch) return otpMatch[1].replace(/\s+/g, '');

    return null;
  } catch (e) {
    console.warn('fetchOTPFromSocially error:', e);
    return null;
  }
}

// ── Admin notification when participant reaches 76 ─────────────────────────

const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';

async function notifyAdminOf76(
  supabase: ReturnType<typeof createClient>,
  participantId: string,
): Promise<void> {
  // Get participant name
  const { data: participant } = await supabase
    .from('acquisition_participants')
    .select('name')
    .eq('id', participantId)
    .maybeSingle();

  const name = participant?.name ?? 'A participant';

  // Get admin push token via email → user_profiles
  const { data: adminProfile } = await supabase
    .from('user_profiles')
    .select('id, push_token')
    .eq('email', ADMIN_EMAIL)
    .maybeSingle();

  const pushToken = adminProfile?.push_token;
  if (!pushToken || !pushToken.startsWith('ExponentPushToken[')) {
    console.log('Admin push token not available — skipping admin notification');
    return;
  }

  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: pushToken,
      title: '🔔 Review required',
      body: `${name} reached 76 customers and is waiting for your review.`,
      data: { type: 'admin_review_76', participant_id: participantId },
      sound: 'default',
      priority: 'high',
    }),
  });

  console.log(`Admin notified: ${name} reached 76 (participant ${participantId})`);
}

// ── Referral push notification (mirrors sms-webhook logic) ───────────────────

async function sendReferralPushNotification(
  supabase: ReturnType<typeof createClient>,
  participantId: string,
  newCount: number,
): Promise<void> {
  const { data: participant } = await supabase
    .from('acquisition_participants')
    .select('user_id')
    .eq('id', participantId)
    .maybeSingle();

  if (!participant?.user_id) return;

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('push_token')
    .eq('id', participant.user_id)
    .maybeSingle();

  const pushToken = profile?.push_token;
  if (!pushToken || !pushToken.startsWith('ExponentPushToken[')) return;

  let title = '🎉 New referral confirmed!';
  let body = `Customer #${newCount} validated. ${76 - newCount} more to go to unlock your Staff Dashboard.`;

  if (newCount >= 76) {
    title = '🏆 You did it! 76 customers reached!';
    body = 'Your eligibility review has been submitted. The NumVault team will review and activate your account.';
  } else if (newCount === 38) {
    title = '⚡ Halfway there!';
    body = `38 customers confirmed! Keep going — just 38 more to unlock your ₦100,000/month income.`;
  } else if (newCount >= 70) {
    title = `🔥 Almost there! ${newCount}/76`;
    body = `Only ${76 - newCount} more validated customers to unlock your Staff Dashboard.`;
  }

  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: pushToken,
      title,
      body,
      data: { type: 'referral_confirmed', count: newCount, participant_id: participantId },
      sound: 'default',
      priority: 'high',
    }),
  });

  console.log(`Referral push sent to participant ${participantId} (count: ${newCount})`);
}
