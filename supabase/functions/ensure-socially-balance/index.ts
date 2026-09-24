import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { getOrCreateSociallyRecipient } from '../_shared/socially-recipient.ts';

/**
 * ensure-socially-balance
 *
 * Checks the Socially.ng balance and tops it up via a Paystack transfer if
 * it falls below LOW_THRESHOLD. The amount follows demand (last hour's
 * wholesale spend × DEMAND_MULTIPLIER, clamped to MIN/MAX) and never touches
 * money owed or accruing to ambassador leads.
 *
 * ── Tuneable constants ────────────────────────────────────────────────────
 */
const LOW_THRESHOLD = 40_000;           // ₦40,000 — trigger a top-up below this
const MIN_TOPUP = 40_000;               // ₦40,000 — smallest transfer worth sending
const MAX_TOPUP = 200_000;              // ₦200,000 — largest single transfer
const DEMAND_MULTIPLIER = 1.5;          // Send 1.5× last hour's wholesale spend
const DEMAND_WINDOW_MINUTES = 60;
const FLAT_ACQUISITION_FEE = 1_500;     // Retail = wholesale + ₦1,500
const LEAD_MONTHLY_PAY = 100_000;       // ₦100,000 per 76 customers
const LEAD_MONTHLY_TARGET = 76;
const MIN_MINUTES_BETWEEN_TOPUPS = 5;   // Skip if a top-up was inserted within this window
const CRITICAL_BALANCE = 15_000;        // ₦15,000 — always alert admin at or below this
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';
const PAYSTACK_BASE = 'https://api.paystack.co';
const SOCIALLY_ACCOUNT_NUMBER = '6635796668';
const SOCIALLY_API_URL = 'https://socially.ng/api/v1';

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    // ── Auth: service role key OR admin JWT ───────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace('Bearer ', '').trim();
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      serviceRoleKey,
    );

    // Allow call if the raw token IS the service role key (internal function-to-function),
    // or if it is a valid JWT belonging to the admin user.
    if (token !== serviceRoleKey) {
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
    }

    // ── 0. Expire stale pending auto-topup rows (older than 15 min) ─────────────
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await admin
      .from('socially_transfers')
      .update({ status: 'failed', error_message: 'Timed out while pending' })
      .eq('trigger_reason', 'low_balance_auto')
      .eq('status', 'pending')
      .lt('created_at', fifteenMinAgo);
    // ─────────────────────────────────────────────────────────────────────────────

    const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';
    const sociallyToken = Deno.env.get('SOCIALLY_API_TOKEN') ?? '';

    // ── 1. Read Socially.ng balance ───────────────────────────────────────────
    let sociallyBalance = 0;
    let balanceCurrency = 'NGN';
    let balanceFetchError: string | null = null;

    try {
      const balRes = await fetch(SOCIALLY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `key=${encodeURIComponent(sociallyToken)}&action=balance`,
      });
      const balText = await balRes.text();
      console.log(`Socially balance raw response (status ${balRes.status}):`, balText);

      if (!balRes.ok) {
        balanceFetchError = `HTTP ${balRes.status}: ${balText}`;
      } else {
        let balData: any;
        try {
          balData = JSON.parse(balText);
        } catch {
          balanceFetchError = `Non-JSON response: ${balText}`;
        }
        if (balData) {
          // Response shape: { balance: 12345.67, currency: "NGN", ... }
          // or: { data: { balance: ... } }
          const raw = balData?.balance ?? balData?.data?.balance ?? balData?.result?.balance;
          if (raw !== undefined && raw !== null) {
            sociallyBalance = Number(raw);
            balanceCurrency = balData?.currency ?? balData?.data?.currency ?? 'NGN';
          } else {
            balanceFetchError = `Unexpected response shape: ${balText}`;
          }
        }
      }
    } catch (e) {
      balanceFetchError = `Fetch threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    console.log(`Socially balance: ₦${sociallyBalance} ${balanceCurrency} | error: ${balanceFetchError}`);

    // If we could not read the balance, alert admin and abort
    if (balanceFetchError) {
      await pushAdmin(
        admin,
        '🚨 Socially.ng balance check failed',
        `Could not read Socially.ng balance. Error: ${balanceFetchError}`,
        { type: 'socially_balance_check_failed', error: balanceFetchError },
      ).catch(() => {});
      return new Response(JSON.stringify({
        action: 'error',
        reason: 'balance_fetch_failed',
        error: balanceFetchError,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Always alert if at or below CRITICAL_BALANCE — rate-limited to once per 30 min
    if (sociallyBalance <= CRITICAL_BALANCE) {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: recentCritical } = await admin
        .from('socially_transfers')
        .select('id')
        .eq('trigger_reason', 'alert_critical_balance')
        .gte('created_at', thirtyMinAgo)
        .limit(1);
      if (!recentCritical || recentCritical.length === 0) {
        await admin.from('socially_transfers').insert({
          order_reference: `alert_critical_${Date.now()}`,
          amount_transferred: 0,
          status: 'failed',
          trigger_reason: 'alert_critical_balance',
          error_message: `Critical balance alert: ₦${sociallyBalance}`,
        });
        await pushAdmin(
          admin,
          '🚨 Socially.ng balance critically low',
          `Socially.ng balance is ₦${sociallyBalance.toLocaleString()}. Immediate action required.`,
          { type: 'socially_critical_balance', balance: sociallyBalance },
        ).catch(() => {});
      }
    }

    // ── 2. Nothing to do if balance is healthy ────────────────────────────────
    if (sociallyBalance > LOW_THRESHOLD) {
      console.log(`Balance ₦${sociallyBalance} > threshold ₦${LOW_THRESHOLD}. No top-up needed.`);
      return new Response(JSON.stringify({
        action: 'none',
        reason: 'balance_above_threshold',
        socially_balance: sociallyBalance,
        threshold: LOW_THRESHOLD,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── 3. Rate-limit: skip if a pending row exists or one was created recently ─
    const windowStart = new Date(Date.now() - MIN_MINUTES_BETWEEN_TOPUPS * 60 * 1000).toISOString();

    const { data: recentRows } = await admin
      .from('socially_transfers')
      .select('id, status, created_at')
      .eq('trigger_reason', 'low_balance_auto')
      .or(`status.eq.pending,created_at.gte.${windowStart}`)
      .order('created_at', { ascending: false })
      .limit(5);

    if (recentRows && recentRows.length > 0) {
      const pendingExists = recentRows.some((r: any) => r.status === 'pending');
      const recentExists = recentRows.some(
        (r: any) => new Date(r.created_at).getTime() >= Date.now() - MIN_MINUTES_BETWEEN_TOPUPS * 60 * 1000,
      );
      if (pendingExists || recentExists) {
        console.log(`Top-up skipped — pendingExists=${pendingExists} recentExists=${recentExists}`);
        return new Response(JSON.stringify({
          action: 'skipped',
          reason: pendingExists ? 'topup_already_pending' : 'topup_too_recent',
          socially_balance: sociallyBalance,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // ── 4. Check Paystack available balance vs payout reserve ─────────────────
    let paystackAvailable = 0;
    try {
      const psBalRes = await fetch(`${PAYSTACK_BASE}/balance`, {
        headers: { Authorization: `Bearer ${paystackSecret}` },
      });
      const psBalData = await psBalRes.json();
      console.log('Paystack balance response:', JSON.stringify(psBalData));
      // data is an array of { currency, balance (kobo) }
      const ngnEntry = Array.isArray(psBalData.data)
        ? psBalData.data.find((e: any) => e.currency === 'NGN')
        : psBalData.data;
      paystackAvailable = ngnEntry ? Number(ngnEntry.balance) / 100 : 0;
    } catch (e) {
      console.error('Paystack balance fetch failed:', e);
    }
    console.log(`Paystack available: ₦${paystackAvailable}`);

    // Reserve = payouts owed but not sent + what active leads have earned this
    // month that is not yet in a payout row (same maths as admin-withdrawable).
    const { data: reservedPayouts, error: payoutsErr } = await admin
      .from('lead_payouts')
      .select('amount')
      .in('status', ['pending', 'under_review', 'approved', 'held', 'failed']);
    const { data: activeLeads, error: leadsErr } = await admin
      .from('acquisition_participants')
      .select('qualification_customers_count')
      .eq('status', 'active_lead');
    if (payoutsErr || leadsErr) {
      const dbMsg = (payoutsErr ?? leadsErr)!.message;
      console.error('Reserve lookup failed:', dbMsg);
      await pushAdmin(
        admin, '🚨 Socially.ng top-up skipped',
        `Could not read ambassador obligations, so no money was moved. DB error: ${dbMsg}`,
        { type: 'socially_topup_reserve_failed', error: dbMsg },
      ).catch(() => {});
      return new Response(JSON.stringify({ action: 'error', reason: 'reserve_lookup_failed', error: dbMsg }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const payoutsOwed = (reservedPayouts || []).reduce(
      (s: number, p: any) => s + Number(p.amount), 0,
    );
    let leadAccruing = 0;
    for (const p of activeLeads || []) {
      const count = Number(p.qualification_customers_count ?? 0);
      const earned = count * (LEAD_MONTHLY_PAY / LEAD_MONTHLY_TARGET);
      const alreadyInPayout = count >= LEAD_MONTHLY_TARGET / 2 ? LEAD_MONTHLY_PAY / 2 : 0;
      leadAccruing += Math.max(0, earned - alreadyInPayout);
    }
    const payoutReserve = Math.ceil(payoutsOwed + leadAccruing);
    console.log(`Payout reserve: ₦${payoutReserve} (owed ₦${payoutsOwed}, accruing ₦${Math.round(leadAccruing)})`);

    const paystackFree = paystackAvailable - payoutReserve;
    console.log(`Paystack free (after reserve): ₦${paystackFree}`);

    // Demand: wholesale cost of numbers sold in the last hour.
    const demandSince = new Date(Date.now() - DEMAND_WINDOW_MINUTES * 60 * 1000).toISOString();
    const { data: recentOrders } = await admin
      .from('orders')
      .select('amount_paid')
      .gte('created_at', demandSince);
    const recentWholesale = (recentOrders || []).reduce(
      (s: number, o: any) => s + Math.max(0, Number(o.amount_paid) - FLAT_ACQUISITION_FEE), 0,
    );
    const plannedAmount = Math.min(
      MAX_TOPUP,
      Math.max(MIN_TOPUP, Math.ceil((recentWholesale * DEMAND_MULTIPLIER) / 1000) * 1000),
    );
    const topupAmount = Math.min(plannedAmount, Math.floor(paystackFree / 1000) * 1000);
    const isPartial = topupAmount < plannedAmount;
    console.log(`Demand: ₦${recentWholesale} wholesale in last ${DEMAND_WINDOW_MINUTES} min → planned ₦${plannedAmount}, sending ₦${topupAmount}`);

    if (topupAmount < MIN_TOPUP) {
      const msg = `Socially.ng balance is ₦${sociallyBalance.toLocaleString()} and Paystack has less than ₦${MIN_TOPUP.toLocaleString()} free to top it up. Paystack available: ₦${paystackAvailable.toLocaleString()}, reserved for ambassador payouts: ₦${payoutReserve.toLocaleString()}, free: ₦${paystackFree.toLocaleString()}.`;
      console.warn(msg);
      const thirtyMinAgoC = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: recentCannotTopup } = await admin
        .from('socially_transfers')
        .select('id')
        .eq('trigger_reason', 'alert_cannot_topup')
        .gte('created_at', thirtyMinAgoC)
        .limit(1);
      if (!recentCannotTopup || recentCannotTopup.length === 0) {
        await admin.from('socially_transfers').insert({
          order_reference: `alert_cannot_topup_${Date.now()}`,
          amount_transferred: 0,
          status: 'failed',
          trigger_reason: 'alert_cannot_topup',
          error_message: msg,
        });
        await pushAdmin(
          admin,
          '⚠️ Cannot top up Socially.ng — insufficient Paystack balance',
          msg,
          { type: 'socially_topup_insufficient_paystack', socially_balance: sociallyBalance, paystack_free: paystackFree },
        ).catch(() => {});
      }
      return new Response(JSON.stringify({
        action: 'skipped',
        reason: 'insufficient_paystack_balance',
        socially_balance: sociallyBalance,
        paystack_available: paystackAvailable,
        payout_reserve: payoutReserve,
        paystack_free: paystackFree,
        planned_amount: plannedAmount,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── 5. Insert lock row (pending) — partial unique index prevents duplicates ─
    const ref = `socially_topup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { error: insertErr } = await admin.from('socially_transfers').insert({
      order_reference: ref,
      paystack_transfer_reference: ref,
      amount_transferred: topupAmount,
      status: 'pending',
      trigger_reason: 'low_balance_auto',
    });

    if (insertErr) {
      // Unique violation = another concurrent call already inserted a pending row
      if (insertErr.code === '23505') {
        console.log('Top-up lock conflict — another call already inserted a pending row');
        return new Response(JSON.stringify({
          action: 'skipped',
          reason: 'concurrent_topup_lock',
          socially_balance: sociallyBalance,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      console.error('socially_transfers insert error:', insertErr);
      await pushAdmin(
        admin,
        '🚨 Socially.ng top-up failed to start',
        `Could not insert top-up lock row. DB error: ${insertErr.message}`,
        { type: 'socially_topup_lock_failed', error: insertErr.message },
      ).catch(() => {});
      return new Response(JSON.stringify({
        action: 'error',
        reason: 'lock_insert_failed',
        error: insertErr.message,
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const alertPartial = () => pushAdmin(
      admin,
      '⚠️ Socially.ng got a partial top-up',
      `Demand called for ₦${plannedAmount.toLocaleString()} but only ₦${topupAmount.toLocaleString()} was free after holding ₦${payoutReserve.toLocaleString()} for ambassador payouts. Socially balance was ₦${sociallyBalance.toLocaleString()}.`,
      { type: 'socially_topup_partial', planned: plannedAmount, sent: topupAmount },
    ).catch(() => {});

    // ── 6. Get or create Paystack recipient for Socially.ng ───────────────────
    let recipientCode: string;
    try {
      recipientCode = await getOrCreateSociallyRecipient(paystackSecret);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin.from('socially_transfers').update({
        status: 'failed',
        error_message: `Recipient lookup failed: ${msg}`,
      }).eq('order_reference', ref);
      await pushAdmin(
        admin, '🚨 Socially.ng top-up failed',
        `Could not get Paystack recipient for Socially.ng. Error: ${msg}`,
        { type: 'socially_topup_recipient_failed', error: msg },
      ).catch(() => {});
      return new Response(JSON.stringify({ action: 'error', reason: 'recipient_failed', error: msg }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 7. Fire Paystack transfer ─────────────────────────────────────────────
    const amountKobo = Math.round(topupAmount * 100);
    console.log(`Firing Paystack transfer: ₦${topupAmount} → ${SOCIALLY_ACCOUNT_NUMBER} (ref: ${ref})`);

    let psTransferRes: Response;
    let psTransferData: any;

    try {
      psTransferRes = await fetch(`${PAYSTACK_BASE}/transfer`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: 'balance',
          amount: amountKobo,
          recipient: recipientCode,
          reason: 'NumVault auto top-up — Socially.ng low balance',
          reference: ref,
        }),
      });
      psTransferData = await psTransferRes.json();
    } catch (fetchErr) {
      const fetchErrMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      console.error('Paystack transfer fetch threw:', fetchErrMsg);
      await admin.from('socially_transfers').update({
        status: 'failed',
        error_message: `Transfer request failed: ${fetchErrMsg}`,
        recipient_code: recipientCode,
      }).eq('order_reference', ref);
      await pushAdmin(
        admin,
        '🚨 Socially.ng auto top-up FAILED',
        `Paystack transfer request threw an error: ${fetchErrMsg}. Socially balance was ₦${sociallyBalance.toLocaleString()}.`,
        { type: 'socially_topup_fetch_threw', error: fetchErrMsg, socially_balance: sociallyBalance },
      ).catch(() => {});
      return new Response(JSON.stringify({
        action: 'error',
        reason: 'transfer_fetch_threw',
        error: fetchErrMsg,
        socially_balance: sociallyBalance,
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    console.log('Paystack transfer response:', JSON.stringify(psTransferData));

    // OTP-gate
    if (psTransferData.data?.status === 'otp') {
      const otpMsg = 'Transfer OTP is turned on in Paystack. Disable it in Paystack Settings → Transfers → OTP, then retry.';
      await admin.from('socially_transfers').update({
        status: 'failed',
        error_message: otpMsg,
      }).eq('order_reference', ref);
      await pushAdmin(
        admin, '🚨 Socially.ng auto top-up blocked by Paystack OTP',
        otpMsg,
        { type: 'socially_topup_otp_required' },
      ).catch(() => {});
      return new Response(JSON.stringify({ action: 'error', reason: 'paystack_otp', error: otpMsg }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (psTransferRes!.ok && psTransferData.status) {
      const transferCode = psTransferData.data?.transfer_code ?? null;
      await admin.from('socially_transfers').update({
        status: 'success',
        paystack_transfer_reference: transferCode ?? ref,
        recipient_code: recipientCode,
        error_message: null,
      }).eq('order_reference', ref);

      console.log(`Top-up succeeded. Transfer code: ${transferCode}`);
      if (isPartial) await alertPartial();
      return new Response(JSON.stringify({
        action: 'topped_up',
        amount: topupAmount,
        transfer_code: transferCode,
        reference: ref,
        socially_balance_before: sociallyBalance,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Transfer failed — verify before giving up
    const verifyRes = await fetch(`${PAYSTACK_BASE}/transfer/verify/${ref}`, {
      headers: { Authorization: `Bearer ${paystackSecret}` },
    });
    const verifyData = await verifyRes.json();
    console.log('Paystack transfer verify:', JSON.stringify(verifyData));

    if (verifyRes.ok && verifyData.status && verifyData.data) {
      const vs = verifyData.data.status ?? '';
      const vc = verifyData.data.transfer_code ?? null;
      if (vs === 'success') {
        await admin.from('socially_transfers').update({
          status: 'success',
          paystack_transfer_reference: vc ?? ref,
          recipient_code: recipientCode,
          error_message: null,
        }).eq('order_reference', ref);
        if (isPartial) await alertPartial();
        return new Response(JSON.stringify({
          action: 'topped_up',
          amount: topupAmount,
          transfer_code: vc,
          reference: ref,
          verified_after_error: true,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (vs === 'pending' || vs === 'processing') {
        // Leave as pending; will resolve via webhook or next check
        return new Response(JSON.stringify({
          action: 'pending',
          amount: topupAmount,
          transfer_code: vc,
          reference: ref,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // Genuinely failed
    const failReason = psTransferData.message || psTransferData.data?.message || 'Paystack transfer failed';
    await admin.from('socially_transfers').update({
      status: 'failed',
      error_message: `Paystack: ${failReason}`,
      recipient_code: recipientCode,
    }).eq('order_reference', ref);

    await pushAdmin(
      admin,
      '🚨 Socially.ng auto top-up FAILED',
      `Paystack transfer of ₦${topupAmount.toLocaleString()} to Socially.ng failed. Reason: ${failReason}. Socially balance was ₦${sociallyBalance.toLocaleString()}.`,
      { type: 'socially_topup_transfer_failed', reason: failReason, socially_balance: sociallyBalance },
    ).catch(() => {});

    return new Response(JSON.stringify({
      action: 'error',
      reason: 'transfer_failed',
      error: failReason,
      socially_balance: sociallyBalance,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('ensure-socially-balance unhandled error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ── Admin push helper ─────────────────────────────────────────────────────────

async function pushAdmin(
  supabase: ReturnType<typeof createClient>,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('push_token')
    .eq('email', ADMIN_EMAIL)
    .maybeSingle();
  const token = profile?.push_token;
  if (!token?.startsWith('ExponentPushToken[')) return;
  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ to: token, title, body, data, sound: 'default', priority: 'high' }),
  });
}
