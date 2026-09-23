import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

/**
 * close-blocks — checks a participant for expired blocks and closes them.
 *
 * Called by:
 *   (a) acquisition-program.tsx dashboard load
 *   (b) admin.tsx dashboard load
 *
 * Requires authenticated caller. Returns the close_expired_blocks result.
 * If participant_id is omitted, closes blocks for the calling user's own participant.
 * Admin callers may pass any participant_id.
 */

const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    let participantId: string | null = body.participant_id ?? null;
    const isAdmin = user.email === ADMIN_EMAIL;

    // Non-admin callers can only close their own participant
    if (!isAdmin) {
      const { data: own } = await supabaseAdmin
        .from('acquisition_participants')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();
      participantId = own?.id ?? null;
    }

    if (!participantId) {
      return new Response(JSON.stringify({ ok: true, closed: false, reason: 'no_participant' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Admin: close all active leads if participant_id is 'all'
    if (isAdmin && body.participant_id === 'all') {
      const { data: allActive } = await supabaseAdmin
        .from('acquisition_participants')
        .select('id')
        .eq('status', 'active_lead');

      const results: unknown[] = [];
      for (const p of (allActive ?? [])) {
        const { data } = await supabaseAdmin.rpc('close_expired_blocks', { p_participant_id: p.id });
        if (data?.closed) {
          results.push(data);
          // Notify admin of closure
          await sendAdminPush(supabaseAdmin, p.id, data).catch(() => {});
        }
      }
      return new Response(JSON.stringify({ ok: true, results }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: result, error: rpcErr } = await supabaseAdmin
      .rpc('close_expired_blocks', { p_participant_id: participantId });

    if (rpcErr) {
      console.error('close_expired_blocks error:', rpcErr);
      return new Response(JSON.stringify({ ok: false, error: rpcErr.message }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Qualification windows (block 0) create no payout, so only paid months notify admin.
    if (result?.closed && isAdmin === false && Number(result.block_number) > 0) {
      await sendAdminPush(supabaseAdmin, participantId, result).catch(() => {});
    }
    if (result?.closed && Number(result.carried_over) > 0) {
      await sendCheckpointPush(supabaseAdmin, participantId, Number(result.carried_over)).catch(() => {});
    }

    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('close-blocks unhandled error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function sendCheckpointPush(
  supabase: ReturnType<typeof createClient>,
  participantId: string,
  carried: number,
): Promise<void> {
  const { data: participant } = await supabase
    .from('acquisition_participants')
    .select('user_id')
    .eq('id', participantId)
    .maybeSingle();
  if (!participant?.user_id) return;
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('push_token')
    .eq('id', participant.user_id)
    .maybeSingle();
  const pushToken = profile?.push_token;
  if (!pushToken?.startsWith('ExponentPushToken[')) return;

  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: pushToken,
      title: `🔒 New 30 days started — ${carried} kept`,
      body: `Your ${carried} validated customers carried over. ${76 - carried} more to qualify as a NumVault Lead.`,
      data: { type: 'qualification_rollover', participant_id: participantId, carried },
      sound: 'default',
      priority: 'high',
    }),
  });
}

async function sendAdminPush(
  supabase: ReturnType<typeof createClient>,
  participantId: string,
  closeResult: Record<string, unknown>,
): Promise<void> {
  const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';
  const { data: participant } = await supabase
    .from('acquisition_participants')
    .select('name')
    .eq('id', participantId)
    .maybeSingle();
  const name = participant?.name ?? 'A participant';

  const { data: adminProfile } = await supabase
    .from('user_profiles')
    .select('push_token')
    .eq('email', ADMIN_EMAIL)
    .maybeSingle();
  const pushToken = adminProfile?.push_token;
  if (!pushToken?.startsWith('ExponentPushToken[')) return;

  const blockNum = closeResult.block_number ?? '?';
  const count = closeResult.count ?? 0;
  const newStatus = closeResult.new_status ?? 'closed';

  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: pushToken,
      title: '📋 Block closed',
      body: `${name} Block ${blockNum} closed with ${count} customers → ${newStatus}. Payout ready for review.`,
      data: { type: 'admin_block_closed', participant_id: participantId },
      sound: 'default',
      priority: 'high',
    }),
  });
}
