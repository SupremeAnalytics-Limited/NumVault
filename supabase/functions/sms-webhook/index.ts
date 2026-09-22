import { corsHeaders, handleCors } from '../_shared/cors.ts';

/**
 * sms-webhook — acknowledges Socially.ng delivery callbacks without acting on them.
 *
 * The callback is unauthenticated, so its payload cannot be trusted to complete
 * orders or count referrals. Orders are completed only by confirm-otp, which
 * checks the order owner, fetches the OTP from Socially.ng itself, and commits
 * through the atomic complete_order_with_otp database function.
 */
Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  const text = await req.text().catch(() => '');
  console.log('SMS webhook received (ignored; confirm-otp completes orders):', text.slice(0, 500));

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
