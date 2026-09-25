import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { getOrCreateSociallyRecipient } from '../_shared/socially-recipient.ts';
import { getSetting } from '../_shared/settings.ts';

/**
 * ensure-socially-balance
 *
 * ── The wholesale account, in plain terms ───────────────────────────────────
 * Socially.ng requires NumVault to keep a prepaid balance sitting with them —
 * the "wholesale account" — before NumVault can buy any number through their
 * API. This function's entire job is keeping that wholesale account funded.
 * It is checked and topped up automatically after every purchase, success or
 * failure — not on a timer, not once a day.
 *
 * ── Why direct Paystack number purchases can NEVER cause a shortfall ───────
 * When a customer pays directly (not from wallet) for a number, Paystack
 * splits the payment at the transaction level: the wholesale portion goes
 * straight to Socially.ng's subaccount (settles T+1 to their bank), and only
 * the flat margin (transaction_charge, e.g. ₦1,500) lands in NumVault's own
 * balance. That wholesale money never passes through NumVault's hands — it
 * cannot be reserved for ambassador payouts and cannot cause a shortfall
 * here. See purchase-number/index.ts and wallet-topup/index.ts.
 *
 * ── Why wallet purchases CAN cause a shortfall — the actual gap this closes
 * Wallet top-ups split 71.43% NumVault / 28.57% Socially.ng at the MOMENT OF
 * TOP-UP — a guess against the top-up amount, not against whatever the
 * customer eventually buys. Example: a ₦10,000 top-up sets aside ₦2,857 for
 * Socially.ng. If that ₦10,000 wallet balance later buys a number whose real
 * wholesale cost is ₦8,500, Socially.ng's wholesale account is debited the
 * full ₦8,500 at that moment — but only ₦2,857 was ever pre-funded toward
 * it. The ₦5,643 gap has to come from somewhere: NumVault's general Paystack
 * balance, via this function. This gap is the entire reason this function
 * exists — nothing else in the codebase closes it.
 *
 * ── What this function is NOT ───────────────────────────────────────────────
 * - Not redundant with the settlement splits above: the splits pay
 *   Socially.ng revenue for past sales; this function separately funds their
 *   operational balance so future orders don't fail. Same eventual bank
 *   account, different purpose, different money.
 * - Does not read Paystack's transaction history. The 24h figure Scale Mode
 *   uses (below) comes from NumVault's own `orders` table — what was SOLD,
 *   not what was SENT. Opposite directions; don't confuse them.
 * - Scale Mode (app_settings.scale_mode_enabled) is not a second mechanism —
 *   it's a branch inside this same function that only changes the "how much
 *   to send" math. Both branches call the identical Transfer code at the
 *   end. There is nothing Scale Mode does that this function doesn't already
 *   do; it's a bigger dial on the same machine, not a competing one.
 *
 * ── Why sending a Transfer doesn't dodge T+1/T+2 ────────────────────────────
 * A Transfer can only move money that has ALREADY settled into NumVault's
 * Paystack balance — it cannot touch today's still-unsettled sales. What it
 * draws on is the pool of everything settled from PAST days combined. The
 * value of using Transfer here isn't beating T+1 (nothing beats T+1) — it's
 * that NumVault can pull an exact, on-demand amount from that pool whenever
 * the wholesale account needs it, instead of being limited to the fixed,
 * automatic, one-day-late cuts the settlement splits send per transaction.
 *
 * ── Why the "couldn't top up" alert (see skipInsufficientPaystack below) is
 * a real, reachable failure, not just theoretical ──────────────────────────
 * Step 4 always reserves money owed/accruing to ambassador leads BEFORE
 * calculating what's free to send Socially.ng — ambassador payouts are
 * protected first, unconditionally, every time. Under normal conditions the
 * gap above gets closed reliably. But if enough active ambassador leads are
 * simultaneously owed their monthly ₦100k at the same time as a high-demand
 * sales period (more likely under Scale Mode, since its target is uncapped),
 * there may genuinely not be enough free balance for both — and this
 * function correctly refuses to take ambassador money to fund Socially.ng,
 * alerting the admin instead of silently under-funding either side.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Checks the Socially.ng balance and tops it up via a Paystack transfer if
 * it falls below LOW_THRESHOLD. The amount follows demand (last hour's
 * wholesale spend × DEMAND_MULTIPLIER, clamped to MIN/MAX) and never touches
 * money owed or accruing to ambassador leads.
 *
 * When app_settings.scale_mode_enabled is true, the classic threshold/demand
 * formula above is replaced by an uncapped, 24h-demand-based cushion target
 * (see SCALE MODE below) — everything else (rate limit, pending-row lock,
 * Paystack balance + payout reserve check) stays exactly as it is today.
 *
 * ── Tuneable constants ────────────────────────────────────────────────────
 */
const LOW_THRESHOLD = 40_000;           // ₦40,000 — trigger a top-up below this
const MIN_TOPUP = 40_000;               // ₦40,000 — smallest transfer worth sending
const MAX_TOPUP = 200_000;              // ₦200,000 — largest single transfer
const DEMAND_MULTIPLIER = 1.5;          // Send 1.5× last hour's wholesale spend
const DEMAND_WINDOW_MINUTES = 60;
// Retail = wholesale + flat margin — admin-editable (app_settings.flat_acquisition_fee,
// fetched below); this is only the fallback default.
const DEFAULT_FLAT_ACQUISITION_FEE = 1_500;
const LEAD_MONTHLY_PAY = 100_000;       // ₦100,000 per 76 customers
const LEAD_MONTHLY_TARGET = 76;
const MIN_MINUTES_BETWEEN_TOPUPS = 5;   // Skip if a top-up was inserted within this window
const CRITICAL_BALANCE = 15_000;        // ₦15,000 — always alert admin at or below this

// ── Scale mode (app_settings.scale_mode_enabled) ────────────────────────────
// Uncapped, demand-based top-ups for higher volume: keeps a 24h-spend-based
// cushion instead of the fixed hourly-demand formula above, and batches a
// top-up across multiple Paystack transfers when it exceeds a single
// transfer's practical size. Off by default — classic behavior (constants
// above) is unchanged when this is off.
const SCALE_MODE_TARGET_FLOOR = 107_000;   // ₦107,000 — minimum cushion even at zero recent demand
const SCALE_MODE_MIN_TOPUP = 10_000;       // ₦10,000 — smallest scale-mode transfer worth sending
const SCALE_MODE_CHUNK_MAX = 10_000_000;   // ₦10,000,000 — max per single Paystack transfer
const SCALE_MODE_BULK_BATCH_SIZE = 100;    // Paystack /transfer/bulk max transfers per request
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

    const FLAT_ACQUISITION_FEE = await getSetting(admin, 'flat_acquisition_fee', DEFAULT_FLAT_ACQUISITION_FEE);
    const scaleModeEnabled = await getSetting(admin, 'scale_mode_enabled', false);

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
    let scaleModeTarget = 0;
    if (scaleModeEnabled) {
      // SCALE MODE: target = max(floor, wholesale spend in the last 24h).
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentOrders24h } = await admin
        .from('orders')
        .select('amount_paid, wholesale_cost')
        .in('status', ['pending', 'completed'])
        .gte('created_at', since24h);
      const wholesaleSpend24h = (recentOrders24h || []).reduce((s: number, o: any) => {
        const wc = o.wholesale_cost != null
          ? Number(o.wholesale_cost)
          : Math.max(0, Number(o.amount_paid) - FLAT_ACQUISITION_FEE);
        return s + wc;
      }, 0);
      scaleModeTarget = Math.max(SCALE_MODE_TARGET_FLOOR, wholesaleSpend24h);
      console.log(`Scale mode target: ₦${scaleModeTarget} (24h wholesale spend ₦${wholesaleSpend24h}, floor ₦${SCALE_MODE_TARGET_FLOOR})`);

      if (sociallyBalance >= scaleModeTarget) {
        console.log(`Scale mode: balance ₦${sociallyBalance} >= target ₦${scaleModeTarget}. No top-up needed.`);
        return new Response(JSON.stringify({
          action: 'none',
          reason: 'balance_above_target',
          socially_balance: sociallyBalance,
          target: scaleModeTarget,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    } else if (sociallyBalance > LOW_THRESHOLD) {
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

    // Shared "cannot top up" skip path — used by both the classic and
    // scale-mode branches below.
    const skipInsufficientPaystack = async (minRequired: number, plannedAmt: number, extra?: string) => {
      const msg = `Socially.ng balance is ₦${sociallyBalance.toLocaleString()}${extra ?? ''} and Paystack has less than ₦${minRequired.toLocaleString()} free to top it up. Paystack available: ₦${paystackAvailable.toLocaleString()}, reserved for ambassador payouts: ₦${payoutReserve.toLocaleString()}, free: ₦${paystackFree.toLocaleString()}.`;
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
        planned_amount: plannedAmt,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    };

    let topupAmount: number;
    let plannedAmount: number;
    let isPartial: boolean;

    if (scaleModeEnabled) {
      // SCALE MODE: top up to the 24h-demand-based target computed above,
      // uncapped (no MAX_TOPUP), gated only by what Paystack actually has free.
      const needed = Math.ceil((scaleModeTarget - sociallyBalance) / 1000) * 1000;
      plannedAmount = needed;
      if (needed < SCALE_MODE_MIN_TOPUP) {
        console.log(`Scale mode: needed ₦${needed} is below the minimum ₦${SCALE_MODE_MIN_TOPUP}. No top-up.`);
        return new Response(JSON.stringify({
          action: 'none',
          reason: 'needed_below_minimum',
          socially_balance: sociallyBalance,
          target: scaleModeTarget,
          needed,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      topupAmount = Math.min(needed, Math.floor(paystackFree / 1000) * 1000);
      isPartial = topupAmount < needed;
      console.log(`Scale mode: target ₦${scaleModeTarget}, balance ₦${sociallyBalance}, needed ₦${needed} → sending ₦${topupAmount}`);

      if (paystackFree < SCALE_MODE_MIN_TOPUP) {
        return await skipInsufficientPaystack(
          SCALE_MODE_MIN_TOPUP,
          plannedAmount,
          ` (target ₦${scaleModeTarget.toLocaleString()})`,
        );
      }
    } else {
      // Demand: wholesale cost of numbers sold in the last hour.
      const demandSince = new Date(Date.now() - DEMAND_WINDOW_MINUTES * 60 * 1000).toISOString();
      const { data: recentOrders } = await admin
        .from('orders')
        .select('amount_paid')
        .gte('created_at', demandSince);
      const recentWholesale = (recentOrders || []).reduce(
        (s: number, o: any) => s + Math.max(0, Number(o.amount_paid) - FLAT_ACQUISITION_FEE), 0,
      );
      plannedAmount = Math.min(
        MAX_TOPUP,
        Math.max(MIN_TOPUP, Math.ceil((recentWholesale * DEMAND_MULTIPLIER) / 1000) * 1000),
      );
      topupAmount = Math.min(plannedAmount, Math.floor(paystackFree / 1000) * 1000);
      isPartial = topupAmount < plannedAmount;
      console.log(`Demand: ₦${recentWholesale} wholesale in last ${DEMAND_WINDOW_MINUTES} min → planned ₦${plannedAmount}, sending ₦${topupAmount}`);

      if (topupAmount < MIN_TOPUP) {
        return await skipInsufficientPaystack(MIN_TOPUP, plannedAmount);
      }
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

    // ── 7. Fire Paystack transfer(s) ──────────────────────────────────────────
    if (topupAmount <= SCALE_MODE_CHUNK_MAX) {
      // Single transfer — same for both modes (classic never exceeds
      // MAX_TOPUP=₦200,000, well under the chunk ceiling).
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
    }

    // ── 7b. Scale mode batch: split into ≤₦10,000,000 chunks, send via
    // Paystack /transfer/bulk in groups of ≤100. Only reachable in scale
    // mode — classic mode never exceeds MAX_TOPUP=₦200,000.
    const chunkAmounts: number[] = [];
    let remaining = topupAmount;
    while (remaining > 0) {
      const chunk = Math.min(SCALE_MODE_CHUNK_MAX, remaining);
      chunkAmounts.push(chunk);
      remaining -= chunk;
    }
    console.log(`Scale mode bulk: ₦${topupAmount} split into ${chunkAmounts.length} chunk(s): ${chunkAmounts.join(', ')}`);

    const chunkRows = chunkAmounts.map((amount, i) => ({
      reference: `${ref}_chunk${i + 1}`,
      amount,
    }));

    // Pre-insert one 'pending' row per chunk — not subject to the
    // low_balance_auto unique index (different trigger_reason), so these can
    // coexist freely alongside the single lock row inserted in step 5.
    await admin.from('socially_transfers').insert(
      chunkRows.map((c) => ({
        order_reference: c.reference,
        paystack_transfer_reference: c.reference,
        amount_transferred: c.amount,
        status: 'pending',
        trigger_reason: 'scale_mode_batch',
        recipient_code: recipientCode,
      })),
    );

    let anyFailed = false;
    let anySucceeded = false;
    const failureDetails: string[] = [];

    for (let i = 0; i < chunkRows.length; i += SCALE_MODE_BULK_BATCH_SIZE) {
      const batch = chunkRows.slice(i, i + SCALE_MODE_BULK_BATCH_SIZE);
      const batchNum = Math.floor(i / SCALE_MODE_BULK_BATCH_SIZE) + 1;
      let bulkRes: Response;
      let bulkData: any;
      try {
        bulkRes = await fetch(`${PAYSTACK_BASE}/transfer/bulk`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${paystackSecret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currency: 'NGN',
            source: 'balance',
            transfers: batch.map((c) => ({
              amount: Math.round(c.amount * 100),
              recipient: recipientCode,
              reference: c.reference,
              reason: 'NumVault scale-mode top-up — Socially.ng low balance',
            })),
          }),
        });
        bulkData = await bulkRes.json();
      } catch (fetchErr) {
        const fetchErrMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        console.error(`Bulk transfer batch ${batchNum} fetch threw:`, fetchErrMsg);
        anyFailed = true;
        failureDetails.push(`batch ${batchNum}: request failed — ${fetchErrMsg}`);
        await admin.from('socially_transfers')
          .update({ status: 'failed', error_message: `Bulk transfer request failed: ${fetchErrMsg}` })
          .in('order_reference', batch.map((c) => c.reference));
        continue;
      }
      console.log(`Bulk transfer batch ${batchNum} response:`, JSON.stringify(bulkData));

      if (!bulkRes!.ok || !bulkData.status) {
        anyFailed = true;
        const failMsg = bulkData.message || 'Bulk transfer request rejected';
        failureDetails.push(`batch ${batchNum}: ${failMsg}`);
        await admin.from('socially_transfers')
          .update({ status: 'failed', error_message: `Paystack: ${failMsg}` })
          .in('order_reference', batch.map((c) => c.reference));
        continue;
      }

      const items: any[] = Array.isArray(bulkData.data) ? bulkData.data : [];
      for (const c of batch) {
        const item = items.find((it) => it.reference === c.reference);
        const itemStatus = item?.status;
        if (itemStatus === 'success' || itemStatus === 'pending' || itemStatus === 'processing') {
          anySucceeded = true;
          await admin.from('socially_transfers')
            .update({
              status: itemStatus === 'success' ? 'success' : 'pending',
              paystack_transfer_reference: item?.transfer_code ?? c.reference,
              error_message: null,
            })
            .eq('order_reference', c.reference);
        } else {
          anyFailed = true;
          const itemMsg = item ? `status=${itemStatus}` : 'not found in response';
          failureDetails.push(`${c.reference}: ${itemMsg}`);
          await admin.from('socially_transfers')
            .update({ status: 'failed', error_message: `Paystack: ${itemMsg}` })
            .eq('order_reference', c.reference);
        }
      }
    }

    // Roll the outcome up onto the original lock row from step 5.
    await admin.from('socially_transfers').update({
      status: anyFailed ? (anySucceeded ? 'success' : 'failed') : 'success',
      error_message: anyFailed
        ? `${failureDetails.length} of ${chunkAmounts.length} chunk(s) failed: ${failureDetails.join('; ')}`
        : null,
      recipient_code: recipientCode,
    }).eq('order_reference', ref);

    if (anyFailed) {
      await pushAdmin(
        admin,
        anySucceeded ? '⚠️ Scale-mode top-up partially failed' : '🚨 Scale-mode top-up FAILED',
        `₦${topupAmount.toLocaleString()} scale-mode top-up to Socially.ng: ${failureDetails.length} of ${chunkAmounts.length} chunk(s) failed. ${failureDetails.join('; ')}`,
        { type: 'socially_topup_scale_mode_failed', chunks: chunkAmounts.length, failed: failureDetails.length },
      ).catch(() => {});
    }
    if (isPartial) await alertPartial();

    return new Response(JSON.stringify({
      action: anyFailed ? (anySucceeded ? 'topped_up_partial' : 'error') : 'topped_up',
      amount: topupAmount,
      chunks: chunkAmounts.length,
      reference: ref,
      socially_balance_before: sociallyBalance,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: anyFailed && !anySucceeded ? 500 : 200,
    });

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
