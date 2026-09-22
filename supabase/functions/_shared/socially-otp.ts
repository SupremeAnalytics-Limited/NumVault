const SOCIALLY_BASE = 'https://socially.ng/api/v1';

// Asks Socially.ng whether an OTP has arrived for an order. Null means no OTP
// yet, or Socially.ng could not be reached.
export async function fetchSociallyOtp(reference: string): Promise<string | null> {
  const token = Deno.env.get('SOCIALLY_API_TOKEN');
  if (!token || !reference) return null;
  try {
    const res = await fetch(
      `${SOCIALLY_BASE}/request/sms/verification/${encodeURIComponent(reference)}/otp`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    const data = await res.json().catch(() => null);
    const responseField = data?.data?.response;
    if (responseField !== undefined && responseField !== null && String(responseField).trim() !== '') {
      return String(responseField).trim();
    }
    const otpMatch = String(data?.message ?? '').match(/\(([\d\s]{4,12})\)/);
    return otpMatch ? otpMatch[1].replace(/\s+/g, '') : null;
  } catch (e) {
    console.warn(`fetchSociallyOtp(${reference}) failed:`, e);
    return null;
  }
}
