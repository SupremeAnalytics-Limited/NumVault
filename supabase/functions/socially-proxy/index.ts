import { corsHeaders, handleCors } from '../_shared/cors.ts';

const SOCIALLY_BASE = 'https://socially.ng/api/v1';

// Read-only catalogue calls anyone may make (prices and availability).
const PUBLIC_PATHS = [
  /^\/sms\/verification\/providers$/,
  /^\/sms\/verification\/provider\/[A-Za-z0-9_-]+\/countries$/,
  /^\/sms\/verification\/service\/provider\/packages$/,
];

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}

Deno.serve(async (req: Request) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  let path = '';
  let method = 'GET';
  let body: Record<string, unknown> | undefined;

  try {
    // Parse request body safely
    const text = await req.text();
    if (text) {
      const parsed = JSON.parse(text);
      path = parsed.path || '';
      method = (parsed.method || 'GET').toUpperCase();
      body = parsed.body;
    }
  } catch (parseErr) {
    console.error('Socially proxy: failed to parse request body:', parseErr);
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });
  }

  if (!path) {
    return jsonError('Missing path parameter', 400);
  }

  // Only Socially.ng paths — never forward the API token to another host.
  if (!path.startsWith('/') || path.includes('..') || path.includes('//')) {
    return jsonError('Invalid path', 400);
  }

  // ── Access control ──────────────────────────────────────────────────────────
  // Server functions (purchase-number, confirm-otp) use the service role key and
  // may call any path. The app may only read the catalogue: OTPs are released
  // through confirm-otp, which completes the order at the same time, so a
  // customer can't read a code and still get the order refunded.
  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const isServiceCall = !!bearer && bearer === serviceRoleKey;

  if (!isServiceCall && !PUBLIC_PATHS.some((re) => re.test(path))) {
    return jsonError('Forbidden', 403);
  }

  try {
    const token = Deno.env.get('SOCIALLY_API_TOKEN');
    if (!token) {
      console.error('Socially proxy: SOCIALLY_API_TOKEN not configured');
      return new Response(JSON.stringify({ error: 'Socially API token not configured' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      });
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    };

    let fetchOptions: RequestInit = { method, headers };

    if (body && (method === 'POST' || method === 'PUT')) {
      // Send as JSON — Socially.ng accepts application/json for POST endpoints
      headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(body);
    }

    const url = `${SOCIALLY_BASE}${path}`;
    console.log(`Socially proxy: ${method} ${url}`, body ? `body: ${JSON.stringify(body)}` : '');

    const res = await fetch(url, fetchOptions);
    const responseText = await res.text();

    console.log(`Socially proxy response: status=${res.status}, body=${responseText.slice(0, 500)}`);

    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { message: responseText };
    }

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: res.status,
    });
  } catch (err) {
    console.error('Socially proxy fetch error:', err?.message || err);
    return new Response(JSON.stringify({ error: String(err?.message || err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
