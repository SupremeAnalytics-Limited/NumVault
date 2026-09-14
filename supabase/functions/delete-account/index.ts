import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // ── Authenticate the requesting user via JWT ──────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');

    // User-scoped client — used only to verify the JWT
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser(token);
    if (userError || !user) {
      console.error('delete-account: auth error', userError?.message);
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userId = user.id;
    console.log(`delete-account: starting deletion for user ${userId}`);

    // ── Service-role client — bypass RLS for full cleanup ─────────────────
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // 1. Delete purchase_locks (references user_profiles via FK)
    const { error: locksError } = await supabaseAdmin
      .from('purchase_locks')
      .delete()
      .eq('user_id', userId);
    if (locksError) console.error('delete-account: purchase_locks delete error', locksError.message);

    // 2. Delete transactions
    const { error: txError } = await supabaseAdmin
      .from('transactions')
      .delete()
      .eq('user_id', userId);
    if (txError) console.error('delete-account: transactions delete error', txError.message);

    // 3. Delete orders
    const { error: ordersError } = await supabaseAdmin
      .from('orders')
      .delete()
      .eq('user_id', userId);
    if (ordersError) console.error('delete-account: orders delete error', ordersError.message);

    // 4. Delete user_profile row (must be before auth.users delete because of FK)
    const { error: profileError } = await supabaseAdmin
      .from('user_profiles')
      .delete()
      .eq('id', userId);
    if (profileError) console.error('delete-account: user_profiles delete error', profileError.message);

    // 5. Delete the auth user — this is the authoritative deletion
    const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authDeleteError) {
      console.error('delete-account: auth.admin.deleteUser error', authDeleteError.message);
      return new Response(
        JSON.stringify({ error: `Auth.Admin.DeleteUser: ${authDeleteError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`delete-account: user ${userId} fully deleted`);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('delete-account: unexpected error', err?.message);
    return new Response(JSON.stringify({ error: err?.message || 'Unexpected error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
