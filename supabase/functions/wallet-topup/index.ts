import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

const PAYSTACK_BASE = 'https://api.paystack.co';

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    const { amount, email, type, metadata: extraMeta } = await req.json();
    const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY');

    // ── Wholesale cost for direct number purchases ────────────────────────────
    // When the client passes wholesale_cost in metadata, we use Paystack's
    // transaction_charge (a flat kobo amount for the main account) instead of
    // the subaccount's percentage_charge.
    //
    // WHY transaction_charge instead of percentage_charge for number_purchase:
    //   - displayPrice = Math.ceil(wholesale * 1.4) can differ from wholesale * 1.4
    //     by up to ₦0.99 due to ceiling rounding.
    //   - percentage_charge on a ceiling'd retail price therefore sends slightly
    //     the wrong amount to Socially.ng.
    //   - transaction_charge = round((retail - wholesale) * 100) kobo gives NumVault
    //     exactly its markup and lets Socially.ng receive the exact wholesale cost.
    //
    // Formula:
    //   transaction_charge (kobo) = round((retail - wholesale) * 100)
    //   Socially.ng receives:      retail - (transaction_charge / 100)
    //   NumVault receives:         transaction_charge / 100
    const wholesaleCost: number | undefined = extraMeta?.wholesale_cost != null
      ? Number(extraMeta.wholesale_cost)
      : undefined;
    // Remove wholesale_cost from metadata before sending to Paystack (internal field)
    const paystackMeta = extraMeta ? { ...extraMeta } : {};
    if ('wholesale_cost' in paystackMeta) delete paystackMeta.wholesale_cost;

    // Initialize Paystack transaction — supports card + bank transfer
    const reference = `numvault_${user.id.slice(0, 8)}_${Date.now()}`;
    console.log('Initializing Paystack transaction:', reference, 'type:', type);

    // ── Split payment for number purchases ────────────────────────────────────
    // When SOCIALLY_SUBACCOUNT_CODE secret is set (after running setup-subaccount),
    // every number-purchase payment automatically applies a split at Paystack's
    // settlement layer — no manual transfers needed.
    //
    // bearer: 'account' → main account pays the Paystack transaction fee. In
    // practice the Paystack dashboard's "pass charges to customer" setting
    // overrides this, so the customer pays the fee on top (confirmed on real
    // transactions: fees_split.params.bearer comes back "customer" regardless
    // of what this field sends).
    //
    // ⚠️  Verified against real settlement data (fees_split on live transactions):
    // percentage_charge set on the SUBACCOUNT is the cut that goes to the
    // INTEGRATION (main/NumVault) account, not the subaccount. The subaccount
    // (Socially.ng) receives (100 − percentage_charge)%. With the subaccount
    // currently set to percentage_charge=71.43, NumVault keeps 71.43% and
    // Socially.ng gets 28.57% — the reverse of the intended 71.43%-to-Socially.ng
    // business model described below. See setup-subaccount/index.ts to correct.
    const sociallySubaccountCode = Deno.env.get('SOCIALLY_SUBACCOUNT_CODE');
    const isNumberPurchase = type === 'number_purchase';
    // Wallet top-ups also require a split: the customer receives the full top-up
    // amount as purchasing power, but the underlying economics must pre-allocate
    // the supplier share immediately at payment time.
    //
    // Intended business model (1.4× markup applies equally to wallet funding):
    //   Supplier allocation = top-up amount ÷ 1.4  → 71.43% → Socially.ng (Palmpay)
    //   NumVault allocation = top-up amount − supplier allocation → 28.57%
    //
    // ⚠️  As configured today this is NOT what happens — see the percentage_charge
    // note above. Socially.ng actually receives 28.57%, NumVault keeps 71.43%.
    // The customer's wallet is credited with the full top-up amount
    // by the webhook; the split is purely a settlement/account-funding mechanism and
    // does NOT reduce the customer's purchasing balance.
    const isWalletTopup = type === 'wallet_topup';

    // Apply the subaccount split to BOTH direct number purchases AND wallet top-ups.
    const requiresSplit = (isNumberPurchase || isWalletTopup) && !!sociallySubaccountCode;

    const initPayload: Record<string, unknown> = {
      email,
      amount: Math.round(amount * 100), // kobo
      reference,
      callback_url: 'https://numvault.app/payment/callback',
      channels: ['card', 'bank_transfer', 'ussd', 'bank'],
      metadata: {
        ...(paystackMeta || {}),
        // Set after the spread so client metadata can never override who paid or why.
        user_id: user.id,
        type: type || 'number_purchase',
      },
    };

    if (requiresSplit) {
      initPayload.subaccount = sociallySubaccountCode;
      initPayload.bearer = 'account'; // main account absorbs the Paystack fee

      if (isNumberPurchase && wholesaleCost != null && wholesaleCost > 0) {
        // ── Exact flat split for direct number purchases ───────────────────────
        // transaction_charge = what NumVault keeps (markup portion), in kobo.
        // Socially.ng receives: gross_amount - transaction_charge (exact wholesale).
        // This is more precise than percentage_charge when Math.ceil() rounding
        // causes the retail price to differ from wholesale * 1.4 exactly.
        const numvaultMarkupKobo = Math.round((amount - wholesaleCost) * 100);
        initPayload.transaction_charge = numvaultMarkupKobo;
        console.log(
          `Split [number_purchase]: retail=₦${amount}, wholesale=₦${wholesaleCost}, ` +
          `transaction_charge=${numvaultMarkupKobo}kobo (₦${numvaultMarkupKobo / 100}), ` +
          `Socially.ng=₦${(amount - numvaultMarkupKobo / 100).toFixed(2)}, subaccount=${sociallySubaccountCode}`
        );
      } else if (isWalletTopup) {
        // Wallet top-up: uses the subaccount's percentage_charge as-is.
        // No transaction_charge override. NOTE: percentage_charge sets the
        // main (integration) account's cut, not the subaccount's — see the
        // ⚠️ note above. At the current value this under-funds Socially.ng.
        console.log(`Split [wallet_topup]: amount=₦${amount}, subaccount=${sociallySubaccountCode} (using percentage_charge)`);
      } else {
        // number_purchase without wholesale_cost passed (defensive fallback)
        console.warn(`Split [number_purchase]: no wholesale_cost supplied — falling back to subaccount's percentage_charge for amount=₦${amount}`);
      }
    } else if ((isNumberPurchase || isWalletTopup) && !sociallySubaccountCode) {
      console.warn(`SOCIALLY_SUBACCOUNT_CODE not set — split payment skipped for type=${type}`);
    }
    // ────────────────────────────────────────────────────────────────────────

    const initRes = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(initPayload),
    });

    const initData = await initRes.json();
    console.log('Init response:', JSON.stringify(initData));

    if (!initData.status) {
      return new Response(JSON.stringify({ error: initData.message || 'Failed to initialize payment' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    return new Response(JSON.stringify({
      data: {
        authorization_url: initData.data.authorization_url,
        reference: initData.data.reference,
        access_code: initData.data.access_code,
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Payment init error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
