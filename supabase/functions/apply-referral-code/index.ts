import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    // ── Authenticate caller ──────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');

    // Use anon client just to verify the JWT and get caller identity
    const anonClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authErr } = await anonClient.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const customerId = user.id;

    // ── Parse body ───────────────────────────────────────────────────────────
    const { code } = await req.json();
    const trimmed = (code ?? '').trim().toUpperCase();
    if (!trimmed) {
      return new Response(JSON.stringify({ ok: true, reason: 'empty_code' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Service-role client for all DB writes ────────────────────────────────
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Look up the participant who owns this referral code
    const { data: participant, error: pErr } = await admin
      .from('acquisition_participants')
      .select('id, user_id')
      .eq('referral_code', trimmed)
      .maybeSingle();

    if (pErr || !participant) {
      // Invalid code — silent ignore (not an error to the caller)
      return new Response(JSON.stringify({ ok: true, reason: 'invalid_code' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Reject self-referral
    if (participant.user_id === customerId) {
      return new Response(JSON.stringify({ ok: true, reason: 'self_referral' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Idempotent insert — skip if row already exists for this customer
    const { data: existing } = await admin
      .from('referred_customers')
      .select('id')
      .eq('customer_id', customerId)
      .maybeSingle();

    if (existing) {
      return new Response(JSON.stringify({ ok: true, reason: 'already_referred' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { error: insertErr } = await admin.from('referred_customers').insert({
      customer_id: customerId,
      participant_id: participant.id,
      referral_code_used: trimmed,
      validated: false,
    });

    if (insertErr) {
      // Unique violation on (customer_id, participant_id) is fine — already referred
      if (insertErr.code === '23505') {
        return new Response(JSON.stringify({ ok: true, reason: 'already_referred' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      console.error('apply-referral-code insert error:', insertErr);
      return new Response(JSON.stringify({ error: insertErr.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true, reason: 'applied' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('apply-referral-code unexpected error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
