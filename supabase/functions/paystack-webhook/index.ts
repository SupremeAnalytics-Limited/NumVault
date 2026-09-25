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
    const signatureOk = !!secretKey && (await isValidPaystackSignature(rawBody, signature, secretKey));

    let incoming: { event?: string; data?: { reference?: string } } | null = null;
    try { incoming = JSON.parse(rawBody); } catch { incoming = null; }

    // Payment events are never trusted from the request body: we re-read the
    // transaction from Paystack with our own secret key. That also lets a
    // real payment through if the webhook signature fails (e.g. the secret
    // key was rotated and Paystack signs with a different one), because the
    // data we act on comes from Paystack's API, not from the caller.
    let payload: { event: string; data: any };
    if (incoming?.event === 'charge.success' && incoming.data?.reference && secretKey) {
      const verified = await verifyTransaction(incoming.data.reference, secretKey);
      if (!verified || verified.status !== 'success') {
        console.warn(`Paystack webhook: ${incoming.data.reference} not confirmed by Paystack (signatureOk=${signatureOk})`);
        return new Response(JSON.stringify({ error: 'Not verified' }), {
          status: signatureOk ? 200 : 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (!signatureOk) {
        console.warn(`Paystack webhook: signature mismatch for ${incoming.data.reference}, accepted via API verification. Check PAYSTACK_SECRET_KEY matches the live secret key.`);
      }
      payload = { event: 'charge.success', data: verified };
    } else if (signatureOk && incoming?.event) {
      payload = { event: incoming.event, data: (incoming as any).data };
    } else {
      console.warn('Paystack webhook rejected: invalid or missing signature');
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('Paystack webhook event:', payload.event);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';

    // ── Transfer outcomes (lead payouts, Socially.ng top-ups) ────────────────
    // A transfer request that Paystack accepts usually starts as pending; its
    // real outcome only arrives here. Without this, a transfer that later
    // failed or was reversed stayed recorded as paid.
    if (['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(payload.event)) {
      await handleTransferEvent(supabaseAdmin, payload.event, payload.data, secretKey);
      return new Response(JSON.stringify({ received: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (payload.event === 'charge.success') {
      const { reference, customer, metadata, authorization } = payload.data;
      const userId = metadata?.user_id;
      // Distinguish payment types:
      //   'wallet_topup'    → credit the wallet
      //   'save_card'       → save card auth only
      //   'number_purchase' → complete the SMS number purchase (server-side safety net)
      const type = metadata?.type;
      // Customers pay Paystack's fee on top, so `amount` includes it. Credit /
      // charge what they asked for (requested_amount), not the fee.
      const amount = Number(payload.data.requested_amount ?? payload.data.amount) / 100; // kobo → naira

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
      // wallet-topup's subaccount split (currently 71.43% → NumVault, 28.57%
      // → Socially.ng — see setup-subaccount/index.ts) is a behind-the-scenes
      // account-funding mechanism and must NOT reduce the wallet credit — the
      // customer already paid the full amount.
      //
      // Idempotency guard: if a credit transaction for this Paystack reference
      // already exists, a duplicate webhook delivery must NOT credit the wallet
      // again. This is the single source of truth for wallet funding.
      if (type === 'wallet_topup') {
        // credit_wallet records the credit and updates the balance together,
        // and returns null if this reference was already credited.
        const { data: newBalance, error: creditErr } = await supabaseAdmin.rpc('credit_wallet', {
          p_user_id: userId,
          p_amount: amount,
          p_reference: reference,
          p_description: 'Wallet top-up via Paystack',
        });
        if (creditErr) {
          console.error(`Wallet top-up credit FAILED for ${reference}:`, creditErr);
        } else if (newBalance === null) {
          console.log(`Wallet top-up idempotency: reference ${reference} already credited — skipping duplicate`);
        } else {
          console.log(`Wallet credited: ₦${amount} (full top-up) for user ${userId}, new balance ₦${newBalance}.`);
        }
      }

      // ── Number purchase — server-side safety net ───────────────────────────
      // Triggered when the client-side WebView misses the payment callback
      // (app backgrounded, bank transfer settled async, USSD delay, etc.).
      // No existence check happens here — purchase-number is always called,
      // and its own purchase_locks table decides atomically whether this
      // reference has already been handled (see the comment below).
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

async function verifyTransaction(reference: string, secretKey: string): Promise<any | null> {
  try {
    const res = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const json = await res.json().catch(() => null);
    return json?.status && json.data ? json.data : null;
  } catch (e) {
    console.error(`verifyTransaction(${reference}) failed:`, e);
    return null;
  }
}

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

// ── Transfer events ───────────────────────────────────────────────────────────

const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';

// supabase-js generics don't survive ReturnType<typeof createClient> (every
// table resolves to `never`), so the helpers below take an untyped client.
// deno-lint-ignore no-explicit-any
type AdminClient = any;

async function handleTransferEvent(
  admin: AdminClient,
  event: string,
  data: any,
  secretKey: string,
): Promise<void> {
  const reference: string | undefined = data?.reference;
  if (!reference) return;

  // Trust Paystack's current record over the event body where we can.
  let status: string = event.replace('transfer.', '');
  let transferCode: string | null = data?.transfer_code ?? null;
  try {
    const res = await fetch(`${PAYSTACK_BASE}/transfer/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const json = await res.json();
    if (res.ok && json.status && json.data?.status) {
      status = json.data.status;
      transferCode = json.data.transfer_code ?? transferCode;
    }
  } catch { /* fall back to the signed event body */ }

  const failed = status === 'failed' || status === 'reversed';
  if (status !== 'success' && !failed) {
    console.log(`Transfer ${reference} is ${status}; waiting for a final event`);
    return;
  }

  // ── Socially.ng top-up ─────────────────────────────────────────────────────
  const { data: topup } = await admin
    .from('socially_transfers')
    .select('id, status, amount_transferred')
    .eq('order_reference', reference)
    .limit(1)
    .maybeSingle();

  if (topup) {
    if (!failed) {
      await admin.from('socially_transfers')
        .update({ status: 'success', error_message: null })
        .eq('id', topup.id);
      console.log(`Top-up ${reference} confirmed`);
      return;
    }
    await admin.from('socially_transfers')
      .update({ status: 'failed', error_message: `Paystack transfer ${status}` })
      .eq('id', topup.id);
    await pushAdmin(
      admin,
      `🚨 Socially.ng top-up ${status}`,
      `₦${Number(topup.amount_transferred).toLocaleString()} top-up to Socially.ng was ${status} by Paystack. Retrying automatically.`,
      { type: 'socially_topup_transfer_' + status, reference },
    ).catch(() => {});
    // Retry now instead of waiting for the next purchase to notice.
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5_000);
      await fetch(`${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/ensure-socially-balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''}` },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      clearTimeout(tid);
    } catch { /* non-blocking */ }
    return;
  }

  // ── Lead payout (reference is payout_id, or payout_id-r<attempt>) ─────────
  const payoutId = reference.replace(/-r\d+$/, '');
  const { data: payout } = await admin
    .from('lead_payouts')
    .select('id, participant_id, amount, status, transfer_attempt')
    .eq('id', payoutId)
    .maybeSingle();
  if (!payout) {
    console.log(`Transfer ${reference} matches no top-up or payout`);
    return;
  }

  // Ignore events for an earlier attempt that has already been replaced.
  const attempt = Number(payout.transfer_attempt ?? 0);
  const currentRef = attempt > 0 ? `${payout.id}-r${attempt}` : payout.id;
  if (reference !== currentRef) {
    console.log(`Ignoring stale transfer event ${reference} (current ${currentRef})`);
    return;
  }

  const amountText = `₦${Number(payout.amount).toLocaleString()}`;

  if (!failed) {
    if (payout.status === 'sent') return;
    await admin.from('lead_payouts').update({
      status: 'sent',
      paystack_transfer_code: transferCode,
      sent_at: new Date().toISOString(),
      failure_reason: null,
    }).eq('id', payout.id);
    await pushParticipant(
      admin, payout.participant_id,
      '💸 Payment sent!',
      `Your payout of ${amountText} has been approved and is on its way to your bank account.`,
      { type: 'payout_sent', payout_id: payout.id, transfer_code: transferCode },
    ).catch(() => {});
    return;
  }

  // Failed or reversed: back to failed (re-approvable) with a fresh reference.
  await admin.from('lead_payouts').update({
    status: 'failed',
    failure_reason: `Paystack: transfer ${status}`,
    transfer_attempt: attempt + 1,
  }).eq('id', payout.id);
  await pushAdmin(
    admin,
    `⚠️ Lead payout ${status}`,
    `A ${amountText} lead payout was ${status} by Paystack. Check the lead's bank details, then approve it again.`,
    { type: 'payout_transfer_' + status, payout_id: payout.id },
  ).catch(() => {});
  if (payout.status === 'sent') {
    await pushParticipant(
      admin, payout.participant_id,
      'Payout delayed',
      `Your ${amountText} payout didn't reach your bank. We're sorting it out; please check your bank details in the app.`,
      { type: 'payout_failed', payout_id: payout.id },
    ).catch(() => {});
  }
}

async function pushAdmin(
  admin: AdminClient,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { data: profile } = await admin
    .from('user_profiles')
    .select('push_token')
    .eq('email', ADMIN_EMAIL)
    .maybeSingle();
  await sendExpoPush(profile?.push_token, title, body, data);
}

async function pushParticipant(
  admin: AdminClient,
  participantId: string,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { data: participant } = await admin
    .from('acquisition_participants')
    .select('user_id')
    .eq('id', participantId)
    .maybeSingle();
  if (!participant?.user_id) return;
  const { data: profile } = await admin
    .from('user_profiles')
    .select('push_token')
    .eq('id', participant.user_id)
    .maybeSingle();
  await sendExpoPush(profile?.push_token, title, body, data);
}

async function sendExpoPush(
  token: string | null | undefined,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!token?.startsWith('ExponentPushToken[')) return;
  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ to: token, title, body, data, sound: 'default', priority: 'high' }),
  });
}
