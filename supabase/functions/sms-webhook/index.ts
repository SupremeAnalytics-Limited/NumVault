import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

/**
 * sms-webhook — receives OTP delivery callbacks from Socially.ng
 *
 * On successful OTP delivery this function:
 *  1. Updates order status → completed + stores OTP
 *  2. Finds any referred_customers row for the buyer
 *  3. Marks that row validated = true (first-purchase validation only)
 *  4. Increments qualification_customers_count — CAPPED at 76
 *  5. Inserts one acquisition_ledger_entries row
 *  6. When count reaches exactly 76 → sets status to 'pending_review'
 *     (NO automatic payout — admin must approve before activation)
 *  7. For active_lead participants → NO threshold triggers.
 *     Proportional settlement happens at period end via a separate cron.
 */
Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const payload = await req.json();
    console.log('SMS webhook received:', JSON.stringify(payload));

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const reference = payload.reference || payload.order_reference || payload.ref;
    let otp = payload.otp || payload.code || payload.verification_code || null;
    if (!otp && payload.message) {
      const match = String(payload.message).match(/\((\d+)\)/);
      if (match) otp = match[1];
    }

    if (!reference || !otp) {
      console.log('Missing reference or OTP in webhook payload');
      return new Response(JSON.stringify({ received: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`OTP received: ${otp} for reference: ${reference}`);

    // ── 1. Find order ─────────────────────────────────────────────────────────
    const { data: order, error: findError } = await supabaseAdmin
      .from('orders')
      .select('id, status, user_id, amount_paid, project_name')
      .eq('order_reference', reference)
      .single();

    if (findError || !order) {
      console.error('Order not found for reference:', reference, findError);
      return new Response(JSON.stringify({ received: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 2. Update order → completed ───────────────────────────────────────────
    const { error: updateError } = await supabaseAdmin
      .from('orders')
      .update({ otp, status: 'completed' })
      .eq('id', order.id);

    if (updateError) {
      console.error('Failed to update order with OTP:', updateError);
    } else {
      console.log('Order updated with OTP:', order.id);
    }

    // ── 3. Acquisition validation ─────────────────────────────────────────────
    try {
      await processAcquisitionValidation(supabaseAdmin, order);
    } catch (acqErr) {
      console.error('Acquisition validation error (non-blocking):', acqErr);
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('SMS webhook error:', err);
    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ── Acquisition validation logic ─────────────────────────────────────────────

const FLAT_ACQUISITION_FEE = 1500; // ₦1,500 per qualifying purchase
const QUALIFICATION_CAP = 76;      // Count is frozen at this number

async function processAcquisitionValidation(
  supabase: ReturnType<typeof createClient>,
  order: { id: string; user_id: string; amount_paid: number; project_name: string }
) {
  const { id: orderId, user_id: customerId } = order;

  // ── Idempotency guard ──────────────────────────────────────────────────────
  const { data: existingLedger } = await supabase
    .from('acquisition_ledger_entries')
    .select('id')
    .eq('order_id', orderId)
    .maybeSingle();

  if (existingLedger) {
    console.log(`Ledger entry already exists for order ${orderId} — skipping`);
    return;
  }

  // ── Look up referred_customers row for this buyer ─────────────────────────
  const { data: referral } = await supabase
    .from('referred_customers')
    .select('id, participant_id, validated, first_purchase_at')
    .eq('customer_id', customerId)
    .maybeSingle();

  let participantId: string | null = null;
  let entryType: 'lead_obligation' | 'unattributed_profit' = 'unattributed_profit';

  if (referral && !referral.validated) {
    // ── Mark customer validated (first purchase only) ──────────────────────
    const now = new Date().toISOString();
    const { error: valErr } = await supabase
      .from('referred_customers')
      .update({
        validated: true,
        validated_at: now,
        first_purchase_at: referral.first_purchase_at ?? now,
        order_id: orderId,
      })
      .eq('id', referral.id);

    if (valErr) {
      console.error('Failed to validate referred_customer:', valErr);
      return;
    }

    participantId = referral.participant_id;
    entryType = 'lead_obligation';
    console.log(`Customer ${customerId} validated for participant ${participantId}`);

    // ── Increment count and apply business rules ────────────────────────────
    const { data: participant } = await supabase
      .from('acquisition_participants')
      .select('id, status, qualification_customers_count, paid_period_start_date, original_activation_timestamp, paid_periods_completed')
      .eq('id', participantId)
      .maybeSingle();

    if (participant) {
      await applyCountIncrement(supabase, participant);
    }
  } else if (referral && referral.validated) {
    // Repeat purchase from already-validated customer
    // Still records a ledger entry but does NOT increment count
    participantId = referral.participant_id;
    entryType = 'lead_obligation';
    console.log(`Repeat purchase from already-validated customer ${customerId} — ledger only, no count increment`);
  } else {
    console.log(`No referral found for customer ${customerId} — recording as unattributed_profit`);
  }

  // ── Insert acquisition ledger entry ────────────────────────────────────────
  const { error: ledgerErr } = await supabase
    .from('acquisition_ledger_entries')
    .insert({
      order_id: orderId,
      amount: FLAT_ACQUISITION_FEE,
      participant_id: participantId,
      entry_type: entryType,
    });

  if (ledgerErr && !ledgerErr.message?.includes('unique')) {
    console.error('Failed to insert ledger entry:', ledgerErr);
  } else {
    console.log(`Ledger entry created: ${entryType} ₦${FLAT_ACQUISITION_FEE} for order ${orderId}`);
  }
}

// ── Count increment with business rule enforcement ────────────────────────────

async function applyCountIncrement(
  supabase: ReturnType<typeof createClient>,
  participant: {
    id: string;
    status: string;
    qualification_customers_count: number;
    paid_period_start_date: string | null;
    original_activation_timestamp: string | null;
    paid_periods_completed: number;
  }
) {
  const currentCount = participant.qualification_customers_count ?? 0;

  // ── Qualifying mode ────────────────────────────────────────────────────────
  if (participant.status === 'qualifying') {
    // Cap at QUALIFICATION_CAP — do not count past it
    if (currentCount >= QUALIFICATION_CAP) {
      console.log(`Participant ${participant.id} already at cap ${QUALIFICATION_CAP} — no increment`);
      return;
    }

    const newCount = currentCount + 1;
    const updates: Record<string, unknown> = { qualification_customers_count: newCount };

    if (newCount >= QUALIFICATION_CAP) {
      // Hit 76 — freeze count and move to pending_review for admin approval
      updates.qualification_customers_count = QUALIFICATION_CAP;
      updates.status = 'pending_review';
      console.log(`Participant ${participant.id} reached ${QUALIFICATION_CAP} — status → pending_review`);
    }

    const { error } = await supabase
      .from('acquisition_participants')
      .update(updates)
      .eq('id', participant.id);

    if (error) console.error('Failed to update participant count:', error);
    else console.log(`Participant ${participant.id} count: ${newCount}`);
    return;
  }

  // ── Active lead mode ───────────────────────────────────────────────────────
  if (participant.status === 'active_lead') {
    // For active leads we still track count within the current 30-day period.
    // Count is used for display purposes only — settlement happens at period end.
    // Hard cap at 76 per period — counts above 76 do not earn extra.
    if (currentCount >= QUALIFICATION_CAP) {
      console.log(`Active lead ${participant.id} already at period cap — no increment`);
      return;
    }

    const newCount = currentCount + 1;
    const { error } = await supabase
      .from('acquisition_participants')
      .update({ qualification_customers_count: newCount })
      .eq('id', participant.id);

    if (error) console.error('Failed to update active lead count:', error);
    else console.log(`Active lead ${participant.id} period count: ${newCount}`);
    return;
  }

  // ── Needs requalification or pending_review ────────────────────────────────
  // Do not modify counts in any other status — referrals still get ledger entries
  console.log(`Participant ${participant.id} is in status '${participant.status}' — count not incremented`);
}
