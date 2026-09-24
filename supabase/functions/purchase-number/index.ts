import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { getSetting } from '../_shared/settings.ts';
import { getOrCreateSociallyRecipient } from '../_shared/socially-recipient.ts';
import { paystackTransferFee } from '../_shared/paystack-fees.ts';

const PAYSTACK_BASE = 'https://api.paystack.co';

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    // The Paystack webhook calls with the service role key and x-webhook-user-id.
    // Only that caller may name a user or skip payment verification.
    const isServiceCall = !!token && token === (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const webhookUserId = isServiceCall ? req.headers.get('x-webhook-user-id') : null;
    let user: { id: string };

    if (webhookUserId) {
      user = { id: webhookUserId };
      console.log('purchase-number: webhook-initiated call for user', webhookUserId);
    } else {
      const { data: { user: jwtUser }, error: userError } = await supabaseClient.auth.getUser(token);
      if (userError || !jwtUser) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 401,
        });
      }
      user = jwtUser;
    }

    const body = await req.json();
    const {
      provider_code,
      country_code,
      project_code,
      project_name,
      country_name,
      amount_paid,
      paystack_reference,
      use_wallet,
    } = body;
    const webhook_verified = isServiceCall && body.webhook_verified === true;

    if (!provider_code || !country_code || !project_code) {
      return new Response(JSON.stringify({ error: 'Missing required fields: provider_code, country_code, project_code' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    // ── SERVER-SIDE PRICE VALIDATION ─────────────────────────────────────────
    // Fetch the authoritative price from Socially.ng before debiting anything.
    // This prevents clients from sending a manipulated amount_paid value.
    // Pricing model: customer pays wholesale + ₦1,500 flat fee.
    const FLAT_ACQUISITION_FEE = 1500; // ₦1,500
    let expectedRetail: number | null = null;
    let wholesaleCost: number | null = null; // captured for the near-instant transfer, below
    try {
      const socially_url = Deno.env.get('SUPABASE_URL') ?? '';
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
      const priceRes = await fetch(`${socially_url}/functions/v1/socially-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
        body: JSON.stringify({
          path: '/sms/verification/service/provider/packages',
          method: 'POST',
          body: { provider_code, country_code },
        }),
      });
      const priceData = await priceRes.json();
      const pkgs: any[] =
        Array.isArray(priceData?.packages) ? priceData.packages :
        Array.isArray(priceData?.data) ? priceData.data :
        Array.isArray(priceData?.result) ? priceData.result :
        Array.isArray(priceData) ? priceData : [];
      const matchingPkg = pkgs.find(
        (p: any) => String(p.project_code ?? p.id ?? '') === String(project_code)
      );
      if (matchingPkg) {
        const wholesale = Number(matchingPkg.price ?? 0);
        wholesaleCost = wholesale;
        expectedRetail = Math.ceil(wholesale + FLAT_ACQUISITION_FEE);
        const clientRetail = Math.ceil(Number(amount_paid));
        // Allow ±50 naira tolerance (covers rounding and temporary price shifts)
        if (Math.abs(clientRetail - expectedRetail) > 50) {
          console.warn(
            `Price mismatch: client sent ${clientRetail}, server expects ${expectedRetail} for ${project_code}/${country_code}`
          );
          return new Response(JSON.stringify({
            error: 'The price for this service has changed. Please go back and try again.',
            price_changed: true,
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 409,
          });
        }
        console.log(`Price validated: client=${clientRetail}, server=${expectedRetail} (wholesale=${wholesale} + fee=1500) ✓`);
      } else {
        console.warn(`Price validation: package ${project_code} not found in response`);
      }
    } catch (priceErr) {
      console.warn('Price validation fetch failed:', priceErr);
    }
    if (expectedRetail === null) {
      // Without a server price we cannot trust amount_paid, so nothing is charged.
      return new Response(JSON.stringify({
        error: 'We could not confirm the price for this service. Please try again in a moment.',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 503,
      });
    }
    // ── END PRICE VALIDATION ─────────────────────────────────────────────────
    if (!use_wallet && !paystack_reference) {
      return new Response(JSON.stringify({ error: 'Provide paystack_reference or set use_wallet: true' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    // ── ATOMIC IDEMPOTENCY RESERVATION ──────────────────────────────────────
    // For Paystack-backed purchases, attempt to INSERT a lock row BEFORE doing
    // anything else. The PRIMARY KEY on paystack_reference means only one
    // concurrent caller can succeed. The loser gets a unique-violation and
    // returns the existing order, closing the race window entirely.
    if (paystack_reference && !use_wallet) {
      const { error: lockError } = await supabaseAdmin
        .from('purchase_locks')
        .insert({ paystack_reference, user_id: user.id });

      if (lockError) {
        // unique_violation (23505) = another call already claimed this reference
        if (lockError.code === '23505') {
          // Wait briefly for the winning call to commit, then return its order
          await new Promise((r) => setTimeout(r, 1500));
          const { data: existingOrder } = await supabaseAdmin
            .from('orders')
            .select('*')
            .eq('paystack_reference', paystack_reference)
            .maybeSingle();

          if (existingOrder) {
            console.log(`Idempotency lock: order ${existingOrder.id} already exists for ${paystack_reference} — returning existing`);
            return new Response(JSON.stringify({ data: { order: existingOrder, idempotent: true } }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          // Winning call may still be in-flight; return 409 so client can retry
          console.log(`Idempotency lock: duplicate call for ${paystack_reference} while winning call is still processing`);
          return new Response(JSON.stringify({ error: 'Purchase already in progress for this reference. Please wait and retry.' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 409,
          });
        }
        // Any other DB error — bail out
        console.error('purchase_locks insert error:', lockError);
        return new Response(JSON.stringify({ error: 'Failed to reserve purchase lock. Please try again.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        });
      }

      console.log(`Idempotency lock acquired for ${paystack_reference}`);
    }
    // ── END ATOMIC RESERVATION ───────────────────────────────────────────────

    let paidAmount: number;

    if (use_wallet) {
      // ── WALLET PATH ──────────────────────────────────────────────────────────
      paidAmount = Number(amount_paid);
      if (!paidAmount || paidAmount <= 0) {
        return new Response(JSON.stringify({ error: 'Invalid amount_paid for wallet purchase' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        });
      }

      const { data: newBalanceRow, error: debitRpcErr } = await supabaseAdmin
        .rpc('debit_wallet', { p_user_id: user.id, p_amount: paidAmount });

      if (debitRpcErr) {
        const isInsufficient = debitRpcErr.message?.includes('INSUFFICIENT_BALANCE');
        if (isInsufficient) {
          const { data: profileCheck } = await supabaseAdmin
            .from('user_profiles').select('wallet_balance').eq('id', user.id).single();
          const available = profileCheck?.wallet_balance ?? 0;
          return new Response(JSON.stringify({
            error: `Insufficient wallet balance. Available: ₦${Number(available).toLocaleString()}, required: ₦${paidAmount.toLocaleString()}.`,
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 402,
          });
        }
        console.error('Wallet debit RPC error:', debitRpcErr);
        return new Response(JSON.stringify({ error: 'Failed to debit wallet. Please try again.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        });
      }

      const newBalance = Number(newBalanceRow);
      const walletRef = `wlt_${user.id.slice(0, 8)}_${Date.now()}`;
      await supabaseAdmin.from('transactions').insert({
        user_id: user.id,
        amount: paidAmount,
        type: 'debit',
        reference: walletRef,
        description: `${project_name || project_code} number - ${country_name || country_code} (wallet)`,
      });
      console.log(`Wallet debited: ₦${paidAmount} from user ${user.id}, new balance: ${newBalance}`);
      // ────────────────────────────────────────────────────────────────────────
    } else {
      // ── PAYSTACK PATH ────────────────────────────────────────────────────────
      if (webhook_verified) {
        console.log(`Skipping Paystack verify for webhook-initiated call (ref: ${paystack_reference})`);
        paidAmount = Number(amount_paid);
        if (!paidAmount || paidAmount <= 0) {
          return new Response(JSON.stringify({ error: 'Invalid amount in webhook-initiated purchase' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
          });
        }
      } else {
        console.log('Verifying Paystack payment:', paystack_reference);
        const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
        const verifyRes = await fetch(`${PAYSTACK_BASE}/transaction/verify/${paystack_reference}`, {
          headers: {
            'Authorization': `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          },
        });

        const verifyData = await verifyRes.json();
        console.log('Paystack verify response:', JSON.stringify(verifyData));

        if (!verifyData.status || verifyData.data?.status !== 'success') {
          // Release the lock — payment not confirmed means we shouldn't block retries
          await supabaseAdmin
            .from('purchase_locks')
            .delete()
            .eq('paystack_reference', paystack_reference);

          return new Response(JSON.stringify({ error: 'Payment not confirmed. Please try again.' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 402,
          });
        }

        paidAmount = verifyData.data.amount / 100;

        let meta = verifyData.data.metadata;
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
        const payerOk = meta?.user_id === user.id;
        const typeOk = (meta?.type ?? 'number_purchase') === 'number_purchase';
        if (!payerOk || !typeOk) {
          console.warn(`Paystack ref ${paystack_reference} rejected: metadata user=${meta?.user_id} type=${meta?.type}, caller=${user.id}`);
          return new Response(JSON.stringify({ error: 'This payment does not belong to this purchase.' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 403,
          });
        }
      }

      // Both Paystack routes: the amount actually paid must cover the price.
      if (paidAmount < expectedRetail - 50) {
        console.warn(`Paystack ref ${paystack_reference} underpaid: paid ₦${paidAmount}, price ₦${expectedRetail}`);
        return new Response(JSON.stringify({
          error: `Payment of ₦${paidAmount.toLocaleString()} does not cover the price of ₦${expectedRetail.toLocaleString()}. Please contact support.`,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 402,
        });
      }
      // ────────────────────────────────────────────────────────────────────────
    }

    // Generate a unique reference for Socially.ng
    const sociallyReference = `nv_${user.id.slice(0, 8)}_${Date.now()}`;

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    console.log(`Purchasing number via socially-proxy: provider=${provider_code}, country=${country_code}, project=${project_code}, ref=${sociallyReference}`);

    const proxyRes = await fetch(`${supabaseUrl}/functions/v1/socially-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        path: '/buy/sms/verification/number',
        method: 'POST',
        body: {
          provider_code,
          country_code,
          project_code,
          reference: sociallyReference,
        },
      }),
    });

    const sociallyData = await proxyRes.json();
    console.log('Socially proxy response:', JSON.stringify(sociallyData));

    if (!proxyRes.ok || sociallyData.status === false) {
      const rawSociallyError =
        sociallyData.message ||
        sociallyData.error ||
        sociallyData.errors ||
        sociallyData.msg ||
        (typeof sociallyData === 'string' ? sociallyData : null) ||
        null;

      // NV-901: generic / unrecognised provider failure — surface a clean
      // customer-friendly message instead of raw API noise.
      const isGenericFailure = !rawSociallyError ||
        String(rawSociallyError).toLowerCase().includes('transaction failed') ||
        String(rawSociallyError).toLowerCase().includes('unknown error') ||
        String(rawSociallyError).toLowerCase() === 'false' ||
        String(rawSociallyError).trim() === '';

      const sociallyError = isGenericFailure
        ? 'NV-901: Transaction could not be completed. Your payment has been refunded — please try again in a moment.'
        : rawSociallyError;

      // ── Balance check on failure (before refund) ────────────────────────────
      // A Socially failure may indicate low balance — check and top up now.
      // One call only, 5 s timeout, never retried and never blocks the refund.
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 5_000);
        const supabaseUrl3 = Deno.env.get('SUPABASE_URL') ?? '';
        const svcKey3 = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
        await fetch(`${supabaseUrl3}/functions/v1/ensure-socially-balance`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${svcKey3}` },
          body: JSON.stringify({}),
          signal: controller.signal,
        });
        clearTimeout(tid);
      } catch { /* non-blocking */ }
      // ─────────────────────────────────────────────────────────────────────────

      // ── REFUND/ROLLBACK ──────────────────────────────────────────────────────
      // Safe to refund here: the lock insert succeeded above, meaning this is
      // guaranteed to be the ONLY caller that reaches this point for this reference.
      console.log(`Socially purchase failed. Refunding ₦${paidAmount} to user ${user.id}`);
      try {
        const refundRef = use_wallet
          ? `rollback_${user.id.slice(0, 8)}_${Date.now()}`
          : paystack_reference;

        const { data: newBalance, error: refundErr } = await supabaseAdmin.rpc('credit_wallet', {
          p_user_id: user.id,
          p_amount: paidAmount,
          p_reference: refundRef,
          p_description: use_wallet
            ? `Wallet rollback: ${project_name || project_code} purchase failed — ${sociallyError}`
            : `Refund: ${project_name || project_code} purchase failed — ${sociallyError}`,
        });
        if (refundErr) throw refundErr;
        console.log(newBalance === null
          ? `Refund skipped: ${refundRef} was already credited`
          : `Refund/rollback credited: ₦${paidAmount} → user ${user.id}, new balance: ${newBalance}`);
      } catch (refundErr) {
        console.error('CRITICAL: Refund/rollback step failed after Socially error:', refundErr);
      }
      // ────────────────────────────────────────────────────────────────────────

      return new Response(JSON.stringify({
        error: `Socially: ${sociallyError}`,
        refunded: true,
        refund_amount: paidAmount,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      });
    }

    const numberData = sociallyData.data;
    const phoneNumber = numberData?.mobile_number || numberData?.phone || numberData?.number || String(numberData);

    // ── Trigger balance check AFTER successful Socially.ng purchase ──────────
    // Fire-and-forget with 5 s timeout — must never slow the customer response.
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

    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        user_id: user.id,
        provider_code,
        country_id: String(country_code),
        country_name: country_name || String(country_code),
        project_id: String(project_code),
        project_name: project_name || project_code,
        phone_number: phoneNumber,
        amount_paid: paidAmount,
        status: 'pending',
        socially_order_id: sociallyReference,
        order_reference: sociallyReference,
        paystack_reference: paystack_reference || null,
      })
      .select()
      .single();

    if (orderError) {
      console.error('Order insert error:', orderError);
      try {
        const { error: refundErr } = await supabaseAdmin.rpc('credit_wallet', {
          p_user_id: user.id,
          p_amount: paidAmount,
          p_reference: use_wallet ? `rollback_${user.id.slice(0, 8)}_${Date.now()}` : paystack_reference,
          p_description: use_wallet
            ? `Wallet rollback: order save failed for ${project_name || project_code}`
            : `Refund: order save failed for ${project_name || project_code}`,
        });
        if (refundErr) throw refundErr;
        console.log(`Refund/rollback credited (order save failure): ₦${paidAmount} → user ${user.id}`);
      } catch (refundErr) {
        console.error('CRITICAL: Refund/rollback step failed after order insert error:', refundErr);
      }
      return new Response(JSON.stringify({ error: 'Failed to save order', refunded: true, refund_amount: paidAmount }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      });
    }

    if (!use_wallet) {
      await supabaseAdmin.from('transactions').insert({
        user_id: user.id,
        amount: paidAmount,
        type: 'debit',
        reference: paystack_reference,
        description: `${project_name || project_code} number - ${country_name || country_code}`,
      });
    }

    // ── Near-instant transfer: pay Socially.ng the exact wholesale cost ──────
    // Admin toggle (app_settings.near_instant_transfer_enabled). When on, this
    // purchase's wholesale cost is sent to Socially.ng right now via a direct
    // Paystack transfer, instead of relying on the next-day settlement split.
    // Awaited (not fire-and-forget) so a dropped connection can't leave a real
    // money transfer unaccounted for — wrapped in try/catch so a transfer
    // failure only logs, it never fails a sale the customer already received.
    // The order above is already committed either way.
    if (wholesaleCost != null && wholesaleCost > 0) {
      const nearInstantTransferEnabled = await getSetting(supabaseAdmin, 'near_instant_transfer_enabled', false);
      if (nearInstantTransferEnabled) {
        try {
          const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';
          const recipientCode = await getOrCreateSociallyRecipient(secretKey);
          const fee = paystackTransferFee(wholesaleCost);
          const transferRef = `nvxfer_${sociallyReference}`;
          const transferRes = await fetch(`${PAYSTACK_BASE}/transfer`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: 'balance',
              amount: Math.round(wholesaleCost * 100),
              recipient: recipientCode,
              reason: `NumVault wholesale — ${sociallyReference}`,
              reference: transferRef,
            }),
          });
          const transferData = await transferRes.json();
          if (!transferRes.ok || !transferData.status) {
            console.error(`Near-instant transfer FAILED for ${sociallyReference}: ₦${wholesaleCost} (Paystack fee ₦${fee}) —`, JSON.stringify(transferData));
          } else {
            console.log(`Near-instant transfer sent: ₦${wholesaleCost} → Socially.ng (Paystack fee ₦${fee}, absorbed by NumVault) for ${sociallyReference}, ref=${transferRef}`);
          }
        } catch (transferErr) {
          console.error(`Near-instant transfer EXCEPTION for ${sociallyReference}:`, transferErr);
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    return new Response(JSON.stringify({
      data: {
        order,
        number_data: numberData,
        socially_reference: sociallyReference,
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Purchase number error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
