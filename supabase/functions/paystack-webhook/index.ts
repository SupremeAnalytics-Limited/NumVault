import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

const PAYSTACK_BASE = 'https://api.paystack.co';

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';
    const rawBody = await req.text();
    const signature = req.headers.get('x-paystack-signature') ?? '';
    if (!secretKey || !(await isValidPaystackSignature(rawBody, signature, secretKey))) {
      console.warn('Paystack webhook rejected: invalid or missing signature');
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const payload = JSON.parse(rawBody);
    console.log('Paystack webhook event:', payload.event);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';

    if (payload.event === 'charge.success') {
      const { reference, customer, metadata, authorization } = payload.data;
      const userId = metadata?.user_id;
      // Distinguish payment types:
      //   'wallet_topup'    → credit the wallet
      //   'save_card'       → save card auth only
      //   'number_purchase' → complete the SMS number purchase (server-side safety net)
      const type = metadata?.type;
      const amount = payload.data.amount / 100; // kobo → naira

      console.log(`Payment success: ${reference}, type: ${type}, user: ${userId}, amount: ${amount}`);

      if (!userId) {
        console.log('No user_id in metadata, skipping');
        return new Response(JSON.stringify({ received: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ── Save card authorization (all payment types that carry auth data) ──
      if (authorization?.authorization_code && authorization.reusable) {
        await supabaseAdmin.from('user_profiles').update({
          paystack_customer_code: customer?.customer_code || null,
          card_last4: authorization.last4,
          card_auth_code: authorization.authorization_code,
          card_brand: authorization.card_type,
          card_exp_month: authorization.exp_month,
          card_exp_year: authorization.exp_year,
        }).eq('id', userId);
        console.log('Card saved for user:', userId);
      }

      // ── Wallet top-up ──────────────────────────────────────────────────────
      // The customer's wallet is credited with the FULL top-up amount.
      // Paystack's settlement split (71.43% → Socially.ng, 28.57% → NumVault)
      // is a behind-the-scenes account-funding mechanism and must NOT reduce
      // the wallet credit — the customer already paid the full amount.
      //
      // Idempotency guard: if a credit transaction for this Paystack reference
      // already exists, a duplicate webhook delivery must NOT credit the wallet
      // again. This is the single source of truth for wallet funding.
      if (type === 'wallet_topup') {
        // Check for duplicate webhook delivery
        const { data: existingTx } = await supabaseAdmin
          .from('transactions')
          .select('id')
          .eq('reference', reference)
          .eq('type', 'credit')
          .maybeSingle();

        if (existingTx) {
          console.log(`Wallet top-up idempotency: reference ${reference} already credited (tx: ${existingTx.id}) — skipping duplicate`);
        } else {
          const { data: profile } = await supabaseAdmin
            .from('user_profiles')
            .select('wallet_balance')
            .eq('id', userId)
            .single();

          const newBalance = Number(profile?.wallet_balance || 0) + amount;
          await supabaseAdmin.from('user_profiles')
            .update({ wallet_balance: newBalance })
            .eq('id', userId);

          await supabaseAdmin.from('transactions').insert({
            user_id: userId,
            amount,
            type: 'credit',
            reference,
            description: 'Wallet top-up via Paystack',
          });

          console.log(`Wallet credited: ₦${amount} (full top-up) for user ${userId}. Paystack split settled separately to Socially.ng subaccount.`);
        }
      }

      // ── Number purchase — server-side safety net ───────────────────────────
      // Triggered when the client-side WebView misses the payment callback
      // (app backgrounded, bank transfer settled async, USSD delay, etc.).
      // Guard: check whether an order for this Paystack reference already exists.
      // If client-side already completed the purchase, skip cleanly.
      if (type === 'number_purchase') {
        const providerCode   = metadata?.provider_code;
        const countryCode    = metadata?.country_code;
        const projectCode    = metadata?.project_code;
        const projectName    = metadata?.project_name ?? projectCode;
        const countryName    = metadata?.country_name ?? countryCode;

        if (!providerCode || !countryCode || !projectCode) {
          console.warn('number_purchase webhook missing purchase metadata — cannot complete server-side', metadata);
        } else {
          // Idempotency is enforced atomically inside purchase-number via the
          // purchase_locks table (unique INSERT on paystack_reference). No need
          // for a SELECT-then-act check here — it was itself a race condition.
          // Always call purchase-number; it will reject any duplicate atomically.
          console.log(`Webhook: triggering server-side number purchase for ${reference}`);

          try {
              const purchaseRes = await fetch(`${supabaseUrl}/functions/v1/purchase-number`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  // Use service role key: the webhook itself is already authenticated
                  // by Paystack's signature + our secret. We bypass user JWT here.
                  'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''}`,
                  // Pass a special header so purchase-number knows to skip its own
                  // user-JWT check and trust the service role auth.
                  'x-webhook-user-id': userId,
                },
                body: JSON.stringify({
                  provider_code: providerCode,
                  country_code: String(countryCode),
                  project_code: String(projectCode),
                  project_name: projectName,
                  country_name: countryName,
                  amount_paid: amount,
                  paystack_reference: reference,
                  // Signal that we verified payment ourselves at webhook level
                  webhook_verified: true,
                }),
              });

              const purchaseData = await purchaseRes.json();
              if (purchaseRes.ok && purchaseData?.data?.order) {
                console.log(`Webhook purchase SUCCESS for ${reference}: order ${purchaseData.data.order.id}`);
              } else if (purchaseRes.status === 409 || purchaseData?.data?.idempotent) {
                // 409 = lock already held by client call; idempotent = order existed
                console.log(`Webhook purchase: reference ${reference} already handled by client call — no action needed`);
              } else {
                console.error(`Webhook purchase FAILED for ${reference}:`, JSON.stringify(purchaseData));
              }
            } catch (purchaseErr) {
              console.error(`Webhook purchase EXCEPTION for ${reference}:`, purchaseErr);
            }
        }
      }
      // ── End number purchase safety net ─────────────────────────────────────
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Paystack webhook error:', err);
    // Always return 200 to Paystack so it doesn't retry unnecessarily
    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function isValidPaystackSignature(rawBody: string, signature: string, secretKey: string): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secretKey), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
