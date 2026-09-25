import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

/**
 * notify-admin — sends a push notification to the admin account.
 *
 * Currently handles:
 *   action: 'enrollment' — a student just enrolled in the acquisition program.
 *     Required: participant_name (string). Any signed-in user may send this.
 *   action: 'refund_failed' — purchase-number could not refund a Paystack
 *     payment that failed its price check. Fields: paystack_reference,
 *     user_id, detail. Accepted ONLY from server-side callers (service role
 *     key), so a customer can't send the admin fake refund alerts.
 *
 * A failed notification never returns an error to the caller — it is always
 * fire-and-forget from the app's perspective.
 */

const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    // Caller must be authenticated
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Server-to-server calls send the service role key, which is not a user
    // session, so getUser() would reject it — check for it first.
    const isServiceCall = token === (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    if (!isServiceCall) {
      const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token);
      if (userErr || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 401,
        });
      }
    }

    const body = await req.json().catch(() => ({}));
    const { action, participant_name } = body;

    if (action === 'refund_failed') {
      if (!isServiceCall) {
        console.warn('notify-admin: refund_failed rejected — not a server-side caller');
      } else {
        const ref: string = body.paystack_reference ?? 'unknown';
        await sendAdminPush(
          supabaseAdmin,
          '🚨 Refund failed — customer money needs manual refund',
          `Paystack payment ${ref} (user ${body.user_id ?? 'unknown'}) failed the price check and could not be refunded automatically. ${body.detail ?? ''}`.trim(),
          { type: 'admin_refund_failed', paystack_reference: ref, user_id: body.user_id ?? null },
        );
      }
    } else if (action === 'enrollment') {
      const name: string = participant_name ?? 'Someone';
      await sendAdminPush(
        supabaseAdmin,
        '🚀 New enrollment',
        `${name} just joined the program.`,
        { type: 'admin_new_enrollment', participant_name: name },
      );
    } else {
      console.warn('notify-admin: unknown action', action);
    }

    // Always return success — notification failure must never surface to the app
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('notify-admin unhandled error:', err);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function sendAdminPush(
  supabase: ReturnType<typeof createClient>,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { data: adminProfile } = await supabase
    .from('user_profiles')
    .select('push_token')
    .eq('email', ADMIN_EMAIL)
    .maybeSingle();

  const pushToken = adminProfile?.push_token;
  if (!pushToken || !pushToken.startsWith('ExponentPushToken[')) {
    console.log('notify-admin: admin push token not available — skipping');
    return;
  }

  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: pushToken,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
    }),
  });

  if (!res.ok) {
    console.warn('notify-admin: Expo push HTTP error', res.status);
  } else {
    console.log('notify-admin: push sent successfully');
  }
}
