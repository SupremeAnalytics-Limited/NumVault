import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

/**
 * sms-webhook — receives OTP delivery callbacks from Socially.ng
 *
 * On successful OTP delivery this function:
 *  1. Updates order status → completed + stores OTP
 *  2. Finds any referred_customers row for the buyer
 *  3. Marks that row validated = true (first-purchase validation)
 *  4. Increments acquisition_participants.qualification_customers_count
 *  5. Inserts one acquisition_ledger_entries row (lead_obligation or unattributed_profit)
 *  6. Triggers a lead_payout record if a cycle threshold is crossed (idempotent)
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

    // Socially.ng sends reference + OTP
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
    // Run in a try/catch so acquisition logic never blocks OTP delivery
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

async function processAcquisitionValidation(
  supabase: ReturnType<typeof createClient>,
  order: { id: string; user_id: string; amount_paid: number; project_name: string }
) {
  const { id: orderId, user_id: customerId } = order;

  // ── 3a. Check for existing ledger entry (idempotency guard) ───────────────
  const { data: existingLedger } = await supabase
    .from('acquisition_ledger_entries')
    .select('id')
    .eq('order_id', orderId)
    .maybeSingle();

  if (existingLedger) {
    console.log(`Ledger entry already exists for order ${orderId} — skipping`);
    return;
  }

  // ── 3b. Look up referred_customers row for this buyer ─────────────────────
  const { data: referral } = await supabase
    .from('referred_customers')
    .select('id, participant_id, validated, first_purchase_at')
    .eq('customer_id', customerId)
    .maybeSingle();

  let participantId: string | null = null;
  let entryType: 'lead_obligation' | 'unattributed_profit' = 'unattributed_profit';

  if (referral && !referral.validated) {
    // ── 3c. Mark this customer as validated ────────────────────────────────
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

    // ── 3d. Increment participant's qualification counter ──────────────────
    const { data: participant } = await supabase
      .from('acquisition_participants')
      .select('id, status, qualification_customers_count, active_lead_start_month')
      .eq('id', participantId)
      .maybeSingle();

    if (participant) {
      const newCount = (participant.qualification_customers_count ?? 0) + 1;
      await supabase
        .from('acquisition_participants')
        .update({ qualification_customers_count: newCount })
        .eq('id', participantId);

      console.log(`Participant ${participantId} count: ${newCount}`);

      // ── 3e. Trigger payout check for active leads ─────────────────────────
      if (participant.status === 'active_lead') {
        await checkAndTriggerPayout(supabase, participantId, participant.active_lead_start_month);
      }
    }
  } else if (referral && referral.validated) {
    // Already validated (repeat purchase) — still a lead_obligation for
    // the referred participant but doesn't increment qualification counter
    participantId = referral.participant_id;
    entryType = 'lead_obligation';
    console.log(`Repeat purchase from already-validated customer ${customerId}`);
  } else {
    // No referral — unattributed profit
    console.log(`No referral found for customer ${customerId} — recording as unattributed_profit`);
  }

  // ── 3f. Insert acquisition ledger entry ────────────────────────────────────
  const { error: ledgerErr } = await supabase
    .from('acquisition_ledger_entries')
    .insert({
      order_id: orderId,
      amount: FLAT_ACQUISITION_FEE,
      participant_id: participantId,
      entry_type: entryType,
    });

  if (ledgerErr && !ledgerErr.message.includes('unique')) {
    console.error('Failed to insert ledger entry:', ledgerErr);
  } else {
    console.log(`Ledger entry created: ${entryType} ₦${FLAT_ACQUISITION_FEE} for order ${orderId}`);
  }
}

// ── Payout trigger ────────────────────────────────────────────────────────────

async function checkAndTriggerPayout(
  supabase: ReturnType<typeof createClient>,
  participantId: string,
  activeLeadStartMonth: string | null
) {
  if (!activeLeadStartMonth) return;

  // Current calendar month window
  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split('T')[0];

  // Count validated customers in this window
  const windowEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

  const { count: windowCount } = await supabase
    .from('referred_customers')
    .select('*', { count: 'exact', head: true })
    .eq('participant_id', participantId)
    .eq('validated', true)
    .gte('validated_at', windowStart)
    .lt('validated_at', windowEnd);

  const total = windowCount ?? 0;
  console.log(`Active lead ${participantId}: ${total} validated customers in window ${windowStart}`);

  // Check which cycles should be triggered
  const cyclesToTrigger: { cycle: 1 | 2; threshold: number }[] = [];
  if (total >= 38) cyclesToTrigger.push({ cycle: 1, threshold: 38 });
  if (total >= 76) cyclesToTrigger.push({ cycle: 2, threshold: 76 });

  for (const { cycle } of cyclesToTrigger) {
    // Idempotent: unique constraint on (participant_id, cycle_number, monthly_window_start)
    const { error: payoutErr } = await supabase
      .from('lead_payouts')
      .insert({
        participant_id: participantId,
        cycle_number: cycle,
        monthly_window_start: windowStart,
        amount: 50000,
        customers_in_cycle: 38,
        status: 'pending',
      });

    if (payoutErr) {
      if (payoutErr.message.includes('unique') || payoutErr.code === '23505') {
        console.log(`Payout cycle ${cycle} already exists for ${participantId} in ${windowStart} — skipping`);
      } else {
        console.error(`Failed to create payout cycle ${cycle}:`, payoutErr);
      }
    } else {
      console.log(`Payout triggered: cycle ${cycle} for participant ${participantId} in ${windowStart} — ₦50,000 pending`);
      // Initiate Paystack transfer if recipient code is on file
      await initiatePaystackTransfer(supabase, participantId, cycle, windowStart);
    }
  }
}

// ── Paystack transfer initiation ──────────────────────────────────────────────

async function initiatePaystackTransfer(
  supabase: ReturnType<typeof createClient>,
  participantId: string,
  cycleNumber: 1 | 2,
  windowStart: string
) {
  const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
  if (!secretKey) {
    console.warn('PAYSTACK_SECRET_KEY not set — payout queued as pending for manual transfer');
    return;
  }

  const { data: participant } = await supabase
    .from('acquisition_participants')
    .select('paystack_recipient_code, name')
    .eq('id', participantId)
    .maybeSingle();

  if (!participant?.paystack_recipient_code) {
    console.warn(`No Paystack recipient code for participant ${participantId} — payout queued as pending`);
    return;
  }

  const transferRef = `nvlead_${participantId.slice(0, 8)}_c${cycleNumber}_${windowStart.replace(/-/g, '')}`;

  try {
    const transferRes = await fetch('https://api.paystack.co/transfer', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'balance',
        amount: 5000000, // ₦50,000 in kobo
        recipient: participant.paystack_recipient_code,
        reason: `NumVault Lead Payout — Cycle ${cycleNumber} ${windowStart}`,
        reference: transferRef,
      }),
    });

    const transferData = await transferRes.json();
    console.log('Paystack transfer response:', JSON.stringify(transferData));

    if (transferData.status && transferData.data?.transfer_code) {
      await supabase
        .from('lead_payouts')
        .update({
          paystack_transfer_code: transferData.data.transfer_code,
          status: transferData.data.status === 'success' ? 'sent' : 'pending',
          sent_at: transferData.data.status === 'success' ? new Date().toISOString() : null,
        })
        .eq('participant_id', participantId)
        .eq('cycle_number', cycleNumber)
        .eq('monthly_window_start', windowStart);

      console.log(`Transfer initiated: ${transferData.data.transfer_code} for ${participant.name}`);
    } else {
      const reason = transferData.message || JSON.stringify(transferData);
      await supabase
        .from('lead_payouts')
        .update({ status: 'failed', failure_reason: reason })
        .eq('participant_id', participantId)
        .eq('cycle_number', cycleNumber)
        .eq('monthly_window_start', windowStart);

      console.error(`Transfer failed for ${participant.name}: ${reason}`);
    }
  } catch (transferErr) {
    console.error('Transfer initiation error:', transferErr);
    await supabase
      .from('lead_payouts')
      .update({ status: 'failed', failure_reason: String(transferErr) })
      .eq('participant_id', participantId)
      .eq('cycle_number', cycleNumber)
      .eq('monthly_window_start', windowStart);
  }
}
