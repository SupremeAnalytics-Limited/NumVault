import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

/**
 * approve-payout — approves or rejects an under_review lead payout.
 *
 * Actions:
 *   action: 'approve' — validates recipient code, fires Paystack transfer, sets sent/failed.
 *   action: 'reject'  — sets held with review_note, pushes participant.
 *
 * Caller must be the admin (JWT email check). Service role inside.
 * Idempotent: re-calling approve on an already approved/sent row is a no-op.
 */

const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';
const PAYSTACK_SECRET = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    // ── Auth: admin only ─────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (user.email !== ADMIN_EMAIL) {
      return new Response(JSON.stringify({ error: 'Forbidden: admin only' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const { payout_id, action, review_note } = body;

    if (!payout_id || !action) {
      return new Response(JSON.stringify({ error: 'payout_id and action required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Fetch payout ─────────────────────────────────────────────────────────
    const { data: payout, error: payErr } = await admin
      .from('lead_payouts')
      .select('*')
      .eq('id', payout_id)
      .single();

    if (payErr || !payout) {
      return new Response(JSON.stringify({ error: 'Payout not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── REJECT ───────────────────────────────────────────────────────────────
    if (action === 'reject') {
      if (payout.status === 'sent') {
        return new Response(JSON.stringify({ error: 'Cannot reject an already-sent payout' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      await admin.from('lead_payouts').update({
        status: 'held',
        review_note: review_note || 'Held by admin',
      }).eq('id', payout_id);

      // Push participant
      const note = review_note || 'Please contact support for details.';
      await sendParticipantPush(
        admin, payout.participant_id,
        '⚠️ Payout needs more review',
        `Your payout of ₦${Number(payout.amount).toLocaleString()} needs more review. ${note}`,
        { type: 'payout_held', payout_id },
      ).catch((e) => console.warn('Push failed:', e));

      return new Response(JSON.stringify({ ok: true, status: 'held' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── APPROVE ──────────────────────────────────────────────────────────────
    if (action === 'approve') {
      // Idempotency
      if (payout.status === 'sent') {
        return new Response(JSON.stringify({ ok: true, status: 'already_sent' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (payout.status !== 'under_review' && payout.status !== 'approved' && payout.status !== 'failed') {
        return new Response(JSON.stringify({ error: `Cannot approve payout with status: ${payout.status}` }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Check participant has bank/recipient code
      const { data: participant } = await admin
        .from('acquisition_participants')
        .select('id, name, paystack_recipient_code, user_id')
        .eq('id', payout.participant_id)
        .single();

      if (!participant) {
        return new Response(JSON.stringify({ error: 'Participant not found' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!participant.paystack_recipient_code) {
        return new Response(JSON.stringify({
          error: 'No bank account on file. Ask the participant to complete bank setup first.',
        }), {
          status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Mark approved
      await admin.from('lead_payouts').update({
        status: 'approved',
        approved_at: new Date().toISOString(),
      }).eq('id', payout_id);

      // Push participant: payout approved
      await sendParticipantPush(
        admin, payout.participant_id,
        '✅ Payout approved!',
        `Your payout of ₦${Number(payout.amount).toLocaleString()} has been approved. Your payment is on its way.`,
        { type: 'payout_approved', payout_id },
      ).catch((e) => console.warn('Push failed:', e));

      // ── Fire Paystack transfer ────────────────────────────────────────────
      // Transfer reference = payout_id ensures idempotency (Paystack deduplicates by reference)
      const amountKobo = Math.round(Number(payout.amount) * 100);
      const transferPayload = {
        source: 'balance',
        reason: `NumVault Lead payout — block ${payout.block_number ?? '?'} half ${payout.cycle_number}`,
        amount: amountKobo,
        recipient: participant.paystack_recipient_code,
        reference: payout_id, // UUID is unique — safe as Paystack reference
      };

      console.log('Initiating Paystack transfer:', JSON.stringify(transferPayload));

      const psRes = await fetch('https://api.paystack.co/transfer', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(transferPayload),
      });

      const psData = await psRes.json();
      console.log('Paystack transfer response:', JSON.stringify(psData));

      if (psRes.ok && psData.status) {
        const transferCode = psData.data?.transfer_code ?? null;
        await admin.from('lead_payouts').update({
          status: 'sent',
          paystack_transfer_code: transferCode,
          sent_at: new Date().toISOString(),
          failure_reason: null,
        }).eq('id', payout_id);

        // Final push to participant
        await sendParticipantPush(
          admin, payout.participant_id,
          '💸 Payment sent!',
          `₦${Number(payout.amount).toLocaleString()} is on its way to your bank account.`,
          { type: 'payout_sent', payout_id, transfer_code: transferCode },
        ).catch((e) => console.warn('Push failed:', e));

        return new Response(JSON.stringify({ ok: true, status: 'sent', transfer_code: transferCode }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } else {
        const reason = psData.message || psData.data?.message || 'Paystack transfer failed';
        await admin.from('lead_payouts').update({
          status: 'failed',
          failure_reason: `Paystack: ${reason}`,
        }).eq('id', payout_id);

        return new Response(JSON.stringify({ ok: false, status: 'failed', reason }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('approve-payout unhandled error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ── Push helper ───────────────────────────────────────────────────────────────

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
