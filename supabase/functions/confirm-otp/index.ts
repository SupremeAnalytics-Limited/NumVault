import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

/**
 * confirm-otp — client-side OTP polling endpoint.
 *
 * 1. Verifies caller owns the order.
 * 2. Returns early if the order is not pending.
 * 3. Calls Socially.ng for the OTP.
 * 4. If no OTP yet → { status: 'pending' }.
 * 5. If OTP found → calls complete_order_with_otp (atomic DB function).
 * 6. Awaits all push notifications to participant and/or admin before returning.
 * 7. Returns the OTP to the caller only when DB function confirms completion.
 */

const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    // ── Auth ───────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401,
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401,
      });
    }

    // ── Parse input ────────────────────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const orderId: string | undefined = body.order_id;
    if (!orderId) {
      return new Response(JSON.stringify({ error: 'order_id is required' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
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
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404,
      });
    }

    if (order.user_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403,
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
      payout_created?: boolean;
      payout_h1_id?: string;
      payout_h2_id?: string;
      new_status?: string;
    };

    // Only return otp when DB function confirms completion.
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

    // ── Push notifications — all awaited before returning ─────────────────────
    const notifyPromises: Promise<void>[] = [];

    if (result.counted && result.participant_id && result.new_count !== undefined) {
      const newCount = result.new_count;
      const newStatus = result.new_status;

      // Referral push to participant
      notifyPromises.push(
        sendReferralPushNotification(
          supabaseAdmin,
          result.participant_id,
          newCount,
          newStatus ?? null,
        ).catch((e) => console.warn('Participant push error:', e)),
      );

      // At 76 (qualification complete → active_lead): admin push
      if (newCount >= 76 || newStatus === 'active_lead') {
        notifyPromises.push(
          notifyAdmin(
            supabaseAdmin, result.participant_id,
            '🏆 [participant] qualified as an ambassador',
            `[participant] reached 76 customers and is now an active lead. Month 1 starts now.`,
            { type: 'admin_qualified_76', participant_id: result.participant_id },
          ).catch((e) => console.warn('Admin push error:', e)),
        );
      }

      // Payout created: notify participant and admin
      if (result.payout_created) {
        // Determine which payout was just created (h2 takes priority at 76)
        const payoutId = result.payout_h2_id || result.payout_h1_id;
        const half = result.payout_h2_id ? 2 : 1;

        if (payoutId) {
          notifyPromises.push(
            (async () => {
              const { data: payout } = await supabaseAdmin
                .from('lead_payouts')
                .select('amount, block_number')
                .eq('id', payoutId)
                .maybeSingle();
              if (!payout) return;
              const amtStr = `₦${Number(payout.amount).toLocaleString()}`;
              const blockNum = payout.block_number ?? '?';

              // Participant: payout under review
              await sendParticipantPush(
                supabaseAdmin, result.participant_id!,
                '💰 Payout pending review',
                `Your ${amtStr} payout for Month ${blockNum} Half ${half} is under review. We will notify you when it is approved.`,
                { type: 'payout_under_review', payout_id: payoutId },
              ).catch(() => {});

              // Admin: payout ready for review
              await notifyAdmin(
                supabaseAdmin, result.participant_id!,
                '📋 [participant] has a payout ready for review',
                `[participant] has a payout ready for review: ${amtStr} Month ${blockNum} Half ${half}.`,
                { type: 'admin_payout_review', payout_id: payoutId },
              ).catch(() => {});
            })(),
          );
        }
      }
    }

    // Await ALL notifications before responding
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

// ── Socially.ng OTP fetch ─────────────────────────────────────────────────────

async function fetchOTPFromSocially(
  supabase: ReturnType<typeof createClient>,
  reference: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.functions.invoke('socially-proxy', {
      body: { path: `/request/sms/verification/${reference}/otp`, method: 'GET' },
    });
    if (error) { console.warn('socially-proxy error:', error.message); return null; }
    const responseField = data?.data?.response;
    if (responseField !== undefined && responseField !== null && String(responseField).trim() !== '') {
      return String(responseField).trim();
    }
    const message: string = data?.message || '';
    const otpMatch = message.match(/\(([\d\s]{4,12})\)/);
    if (otpMatch) return otpMatch[1].replace(/\s+/g, '');
    return null;
  } catch (e) {
    console.warn('fetchOTPFromSocially error:', e);
    return null;
  }
}

// ── Admin push helper ─────────────────────────────────────────────────────────

async function notifyAdmin(
  supabase: ReturnType<typeof createClient>,
  participantId: string,
  title: string,
  bodyTemplate: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { data: participant } = await supabase
    .from('acquisition_participants')
    .select('name')
    .eq('id', participantId)
    .maybeSingle();
  const name = participant?.name ?? 'A participant';

  const { data: adminProfile } = await supabase
    .from('user_profiles')
    .select('push_token')
    .eq('email', ADMIN_EMAIL)
    .maybeSingle();
  const pushToken = adminProfile?.push_token;
  if (!pushToken?.startsWith('ExponentPushToken[')) return;

  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: pushToken,
      title: title.replace('[participant]', name),
      body: bodyTemplate.replace('[participant]', name),
      data,
      sound: 'default',
      priority: 'high',
    }),
  });
}

// ── Participant push helper ───────────────────────────────────────────────────

async function sendParticipantPush(
  supabase: ReturnType<typeof createClient>,
  participantId: string,
  title: string,
  body: string,
  data: Record<string, unknown>,
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
  if (!pushToken?.startsWith('ExponentPushToken[')) return;

  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: pushToken, title, body, data, sound: 'default', priority: 'high' }),
  });
}

// ── Referral push to participant (count-based messaging) ─────────────────────
// Distinguishes between qualification wording and paid-block wording.

async function sendReferralPushNotification(
  supabase: ReturnType<typeof createClient>,
  participantId: string,
  newCount: number,
  newStatus: string | null,
): Promise<void> {
  // Determine whether the participant is in a paid month or still qualifying.
  // Re-fetch the current participant record for the most accurate status.
  const { data: participant } = await supabase
    .from('acquisition_participants')
    .select('status, paid_periods_completed')
    .eq('id', participantId)
    .maybeSingle();

  // Use newStatus if the DB function just changed it; otherwise use persisted status.
  const effectiveStatus = newStatus ?? participant?.status ?? 'qualifying';
  const blockNum = (participant?.paid_periods_completed ?? 0) + 1;

  let title: string;
  let body: string;

  if (effectiveStatus === 'active_lead' && (newCount >= 76 || newStatus === 'active_lead')) {
    // This customer was the 76th that triggered qualification → transition to active_lead
    title = '🏆 76 customers reached!';
    body = 'You reached 76 customers. Your next 30-day month starts now.';
  } else if (effectiveStatus === 'active_lead') {
    // Already an active lead — count increments inside a paid month
    if (newCount >= 76) {
      title = '🏆 76 customers reached!';
      body = 'You reached 76 customers. Your next 30-day month starts now.';
    } else if (newCount === 38) {
      title = `✅ Half of Month ${blockNum} complete!`;
      body = `38 customers confirmed for Month ${blockNum}. Half 1 (₦50,000) is now under review. Keep going!`;
    } else if (newCount >= 70) {
      title = `🔥 Almost done — ${newCount}/76 in Month ${blockNum}`;
      body = `Only ${76 - newCount} more customers to complete this month.`;
    } else {
      title = '🎉 New referral confirmed!';
      body = `Customer #${newCount} validated for Month ${blockNum}. ${76 - newCount} more to complete this month.`;
    }
  } else {
    // Qualifying stage
    if (newCount >= 76) {
      title = '🏆 76 customers reached!';
      body = 'You reached 76 customers. Your next 30-day month starts now.';
    } else if (newCount === 19 || newCount === 38 || newCount === 57) {
      title = `🔒 Checkpoint reached: ${newCount} saved!`;
      body = `Even if your 30 days run out, you keep these ${newCount} validated customers. ${76 - newCount} more to qualify as a NumVault Lead.`;
    } else if (newCount >= 70) {
      title = `🔥 Almost there! ${newCount}/76`;
      body = `Only ${76 - newCount} more validated customers to qualify.`;
    } else {
      title = '🎉 New referral confirmed!';
      body = `Customer #${newCount} validated. ${76 - newCount} more to qualify.`;
    }
  }

  await sendParticipantPush(supabase, participantId, title, body, {
    type: 'referral_confirmed', count: newCount, participant_id: participantId,
  });
}
