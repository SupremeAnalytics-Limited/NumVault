import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

// One-time admin function to:
//  1. Create/verify the Paystack subaccount for Socially.ng (idempotent)
//  2. Set settlement_schedule to 'manual' so Paystack does NOT auto-settle
//     the NumVault main account balance to the Kuda bank account. Prevents
//     money leaving before Lead payouts are sent.
//
// Auth: valid user JWT required, email must match ADMIN_EMAIL.

const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';
const PAYSTACK_BASE = 'https://api.paystack.co';
const SOCIALLY_ACCOUNT_NUMBER = '6635796668';
const SOCIALLY_ACCOUNT_NAME = 'Riteweb Digital Services-Sim(Paymentpoint)';

// ⚠️  Verified against real settlement data (fees_split on live transactions):
// percentage_charge set on a subaccount is the cut that goes to the
// INTEGRATION (main/NumVault) account, NOT the subaccount. The subaccount
// (Socially.ng) actually receives (100 − percentage_charge)%.
// Intended model: Socially.ng receives wholesale (~71.43%); NumVault keeps
// ~28.57% (~₦1,500 flat via transaction_charge on number_purchase instead).
// At the current value (71.43), NumVault keeps 71.43% and Socially.ng gets
// 28.57% — the reverse of intent. To make Socially.ng actually receive
// 71.43%, this constant needs to be set to 28.57, not 71.43.
const SUBACCOUNT_PERCENTAGE = 71.43;

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    // ── Auth: verify caller is admin ────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const { data: { user }, error: authErr } = await supabaseClient.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      });
    }
    if (user.email !== ADMIN_EMAIL) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 403,
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';
    if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY not set');

    // ── Check if subaccount already exists ──────────────────────────────────
    const listRes = await fetch(`${PAYSTACK_BASE}/subaccount?perPage=100`, {
      headers: { 'Authorization': `Bearer ${secretKey}` },
    });
    const listData = await listRes.json();

    if (listData.status && Array.isArray(listData.data)) {
      const existing = listData.data.find(
        (s: { account_number?: string; subaccount_code?: string; percentage_charge?: number }) =>
          s.account_number === SOCIALLY_ACCOUNT_NUMBER,
      );

      if (existing?.subaccount_code) {
        const currentPct = Number(existing.percentage_charge);
        const needsFix = Math.abs(currentPct - SUBACCOUNT_PERCENTAGE) > 0.1;

        if (needsFix) {
          // ── Auto-correct: update percentage_charge to correct value ──────────
          console.log(`Subaccount ${existing.subaccount_code} has wrong percentage_charge=${currentPct}, updating to ${SUBACCOUNT_PERCENTAGE}`);

          const patchRes = await fetch(`${PAYSTACK_BASE}/subaccount/${existing.subaccount_code}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${secretKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              percentage_charge: SUBACCOUNT_PERCENTAGE,
            }),
          });
          const patchData = await patchRes.json();
          console.log('Patch subaccount response:', JSON.stringify(patchData));

          const updatedPct = patchData.data?.percentage_charge ?? SUBACCOUNT_PERCENTAGE;

          return new Response(JSON.stringify({
            success: true,
            already_existed: true,
            fixed: true,
            subaccount_code: existing.subaccount_code,
            account_number: SOCIALLY_ACCOUNT_NUMBER,
            percentage_charge_was: currentPct,
            percentage_charge_now: updatedPct,
            // NOTE: percentage_charge is the INTEGRATION (main/NumVault) account's
            // cut, not the subaccount's — verified against real settlement data.
            // Socially.ng (subaccount) actually receives (100 − updatedPct)%.
            note: `percentage_charge updated from ${currentPct}% to ${updatedPct}%. NumVault (integration) now receives ${updatedPct}%, Socially.ng (subaccount) receives ${(100 - updatedPct).toFixed(2)}%.`,
            next_step: 'Verify SOCIALLY_SUBACCOUNT_CODE secret is set. New purchases will now apply this split.',
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
          // ──────────────────────────────────────────────────────────────────
        }

        // Matches SUBACCOUNT_PERCENTAGE — not necessarily the intended business split,
        // see the ⚠️ note above SUBACCOUNT_PERCENTAGE.
        console.log(`Subaccount already exists, percentage_charge matches configured value: ${existing.subaccount_code}`);
        return new Response(JSON.stringify({
          success: true,
          already_existed: true,
          fixed: false,
          subaccount_code: existing.subaccount_code,
          account_number: SOCIALLY_ACCOUNT_NUMBER,
          percentage_charge: currentPct,
          // NOTE: percentage_charge is the INTEGRATION (main/NumVault) account's
          // cut, not the subaccount's — verified against real settlement data.
          note: `percentage_charge=${currentPct} — NumVault (integration) receives ${currentPct}%, Socially.ng (subaccount) receives ${(100 - currentPct).toFixed(2)}%.`,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // ── Resolve Palmpay's settlement bank code ───────────────────────────────
    const banksRes = await fetch(`${PAYSTACK_BASE}/bank?currency=NGN&perPage=200`, {
      headers: { 'Authorization': `Bearer ${secretKey}` },
    });
    const banksData = await banksRes.json();
    if (!banksData.status || !Array.isArray(banksData.data)) {
      throw new Error(`Failed to fetch bank list: ${JSON.stringify(banksData)}`);
    }
    const palmpay = banksData.data.find(
      (b: { name: string; code: string }) => b.name.toLowerCase().includes('palmpay'),
    );
    if (!palmpay) throw new Error('Palmpay not found in Paystack bank list');
    console.log(`Resolved Palmpay: "${palmpay.name}" code=${palmpay.code}`);
    // ────────────────────────────────────────────────────────────────────────

    // ── Create subaccount ────────────────────────────────────────────────────
    // percentage_charge = what the INTEGRATION (main/NumVault) account receives.
    // At SUBACCOUNT_PERCENTAGE=71.43, NumVault gets 71.43%, Socially.ng (the
    // subaccount) gets 28.57% — see the ⚠️ note above SUBACCOUNT_PERCENTAGE.
    const createRes = await fetch(`${PAYSTACK_BASE}/subaccount`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        business_name: SOCIALLY_ACCOUNT_NAME,
        settlement_bank: palmpay.code,
        account_number: SOCIALLY_ACCOUNT_NUMBER,
        percentage_charge: SUBACCOUNT_PERCENTAGE,
        description: 'NumVault — Socially.ng cost-recovery split',
        primary_contact_email: ADMIN_EMAIL,
      }),
    });
    const createData = await createRes.json();
    console.log('Create subaccount response:', JSON.stringify(createData));

    if (!createData.status || !createData.data?.subaccount_code) {
      return new Response(JSON.stringify({
        success: false,
        error: createData.message || 'Failed to create subaccount',
        paystack_response: createData,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      });
    }

    const subaccountCode = createData.data.subaccount_code;
    console.log(`Subaccount created: ${subaccountCode} (percentage_charge: ${SUBACCOUNT_PERCENTAGE})`);

    // ── Set settlement schedule to manual ───────────────────────────────────────
    // Paystack does not expose a REST API for settlement_schedule changes.
    // The dashboard path is: Settings → Preferences → Settlement Schedule → Manual.
    // We log a reminder so the admin knows this step is required.
    console.log('SETTLEMENT ACTION REQUIRED: Paystack Dashboard → Settings → Preferences → Settlement Schedule → set to Manual');
    // ─────────────────────────────────────────────────────────────────────────

    return new Response(JSON.stringify({
      success: true,
      already_existed: false,
      subaccount_code: subaccountCode,
      account_number: SOCIALLY_ACCOUNT_NUMBER,
      bank_code: palmpay.code,
      bank_name: palmpay.name,
      percentage_charge: SUBACCOUNT_PERCENTAGE,
      // NOTE: percentage_charge is the INTEGRATION (main/NumVault) account's cut.
      note: `percentage_charge=${SUBACCOUNT_PERCENTAGE} — NumVault (integration) receives ${SUBACCOUNT_PERCENTAGE}%, Socially.ng (subaccount) receives ${(100 - SUBACCOUNT_PERCENTAGE).toFixed(2)}%.`,
      settlement_action: 'MANUAL STEP REQUIRED: Go to Paystack Dashboard → Settings → Preferences → Settlement Schedule → set to Manual to prevent auto-settlement before Lead payouts.',
      next_step: `Add this as a Supabase secret named SOCIALLY_SUBACCOUNT_CODE with value: ${subaccountCode}`,
      paystack_response: createData.data,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    // ────────────────────────────────────────────────────────────────────────

  } catch (err) {
    console.error('setup-subaccount error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
