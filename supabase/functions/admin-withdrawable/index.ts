import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

/**
 * admin-withdrawable — read-only calculation of safe-to-withdraw balance.
 *
 * Returns:
 *   paystack_available  — live NGN balance from Paystack /balance
 *   payouts_owed        — sum of lead_payouts.amount for pending/under_review/approved/held rows
 *   accruing            — estimated earnings in the current month with no payout row yet
 *   topup_reserve       — constant: minimum Socially.ng balance we want to keep funded
 *   cushion             — constant: operational buffer
 *   safe_to_withdraw    — paystack_available - payouts_owed - accruing - topup_reserve - cushion (min 0)
 *
 * All amounts in naira (not kobo).
 * Admin-only: JWT email must equal ADMIN_EMAIL.
 */

const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';
const PAYSTACK_SECRET = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';

// ── Easy-to-adjust constants ──────────────────────────────────────────────────
const TOPUP_RESERVE = 200_000;  // ₦200,000 — kept for Socially.ng top-up headroom
const CUSHION       = 100_000;  // ₦100,000 — operational buffer

// ─────────────────────────────────────────────────────────────────────────────

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

    // ── Paystack balance (NGN) ────────────────────────────────────────────────
    const psRes = await fetch('https://api.paystack.co/balance', {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
    });

    if (!psRes.ok) {
      const psBody = await psRes.text().catch(() => '');
      console.error('Paystack balance fetch failed:', psRes.status, psBody);
      return new Response(
        JSON.stringify({ error: `Paystack balance unavailable (HTTP ${psRes.status})` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const psData = await psRes.json().catch(() => null);
    const ngnEntry = (psData?.data ?? []).find((b: any) => b.currency === 'NGN');
    if (!ngnEntry) {
      console.error('No NGN entry in Paystack balance:', JSON.stringify(psData));
      return new Response(
        JSON.stringify({ error: 'No NGN balance found in Paystack response' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const paystackAvailable = Number(ngnEntry.balance) / 100;

    // ── Payouts owed (owed to leads, not yet sent) ────────────────────────────
    const { data: owedRows, error: owedErr } = await admin
      .from('lead_payouts')
      .select('amount')
      .in('status', ['pending', 'under_review', 'approved', 'held']);

    if (owedErr) {
      console.error('lead_payouts query error:', owedErr);
      return new Response(JSON.stringify({ error: 'Database error fetching payouts' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const payoutsOwed = (owedRows ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0);

    // ── Accruing — estimated unpaid earnings for current active_lead months ───
    // For each active_lead: earned = count * (100000 / 76)
    // The first half-payout (₦50,000) is created at 38 customers,
    // so we subtract it once count >= 38 to avoid double-counting.
    const { data: activeParticipants, error: partErr } = await admin
      .from('acquisition_participants')
      .select('qualification_customers_count')
      .eq('status', 'active_lead');

    if (partErr) {
      console.error('acquisition_participants query error:', partErr);
      return new Response(JSON.stringify({ error: 'Database error fetching participants' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let accruing = 0;
    for (const p of activeParticipants ?? []) {
      const count = Number(p.qualification_customers_count ?? 0);
      const grossEarned = count * (100_000 / 76);
      // Subtract the half already in a payout row once count >= 38
      const alreadyInPayout = count >= 38 ? 50_000 : 0;
      accruing += Math.max(0, grossEarned - alreadyInPayout);
    }

    // ── Safe to withdraw ─────────────────────────────────────────────────────
    const safeToWithdraw = Math.max(
      0,
      paystackAvailable - payoutsOwed - accruing - TOPUP_RESERVE - CUSHION,
    );

    return new Response(
      JSON.stringify({
        paystack_available: paystackAvailable,
        payouts_owed:       payoutsOwed,
        accruing:           Math.round(accruing),
        topup_reserve:      TOPUP_RESERVE,
        cushion:            CUSHION,
        safe_to_withdraw:   Math.round(safeToWithdraw),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('admin-withdrawable unhandled error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
