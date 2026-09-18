import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

/**
 * create-transfer-recipient
 *
 * Multipurpose edge function for bank onboarding:
 *  action=list_banks        → returns Paystack NGN bank list
 *  action=resolve           → resolves account_number + bank_code → account_name
 *  action=create_recipient  → creates Paystack transfer recipient, saves to participant
 *
 * All actions require an authenticated user JWT.
 */
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

    const { data: { user }, error: authErr } = await supabaseClient.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';
    if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY not set');

    const body = await req.json();
    const { action } = body;

    // ── List banks ────────────────────────────────────────────────────────────
    if (action === 'list_banks') {
      const res = await fetch('https://api.paystack.co/bank?currency=NGN&perPage=200&active=1', {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      const data = await res.json();
      if (!data.status) throw new Error(data.message || 'Failed to fetch banks');
      return new Response(JSON.stringify({ banks: data.data }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Resolve account ───────────────────────────────────────────────────────
    if (action === 'resolve') {
      const { account_number, bank_code } = body;
      if (!account_number || !bank_code) {
        return new Response(JSON.stringify({ error: 'account_number and bank_code required' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        });
      }
      const res = await fetch(
        `https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
        { headers: { Authorization: `Bearer ${secretKey}` } }
      );
      const data = await res.json();
      if (!data.status) {
        return new Response(JSON.stringify({ error: data.message || 'Account not found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 404,
        });
      }
      return new Response(JSON.stringify({ account_name: data.data.account_name, account_number: data.data.account_number }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Create transfer recipient ──────────────────────────────────────────────
    if (action === 'create_recipient') {
      const { participant_id, account_number, bank_code, bank_name, account_name } = body;

      // Verify participant belongs to this user
      const { data: participant } = await supabaseAdmin
        .from('acquisition_participants')
        .select('id, user_id')
        .eq('id', participant_id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (!participant) {
        return new Response(JSON.stringify({ error: 'Participant not found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 404,
        });
      }

      const res = await fetch('https://api.paystack.co/transferrecipient', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'nuban',
          name: account_name,
          account_number,
          bank_code,
          currency: 'NGN',
          description: `NumVault Lead payout recipient — ${account_name}`,
        }),
      });
      const data = await res.json();
      console.log('Create recipient response:', JSON.stringify(data));

      if (!data.status || !data.data?.recipient_code) {
        return new Response(JSON.stringify({ error: data.message || 'Failed to create transfer recipient', paystack_response: data }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        });
      }

      const recipientCode = data.data.recipient_code;
      console.log(`Transfer recipient created: ${recipientCode} for participant ${participant_id}`);

      return new Response(JSON.stringify({ recipient_code: recipientCode, recipient_data: data.data }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });

  } catch (err) {
    console.error('create-transfer-recipient error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
