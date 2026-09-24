// Flat ₦1,500 acquisition contribution per qualifying direct number purchase.
// Customer price = wholesale price + FLAT_ACQUISITION_FEE.
// MARKUP is retained only for legacy server-side price validation in purchase-number.
export const MARKUP = 1.4; // legacy — only used in purchase-number price guard
export const FLAT_ACQUISITION_FEE = 1500; // ₦1,500 flat fee above wholesale — never reduced by anything, including transfer fees below

// Paystack NGN transfer fees + the ₦50 stamp duty on transfers ≥ ₦10,000.
// Mirrors supabase/functions/_shared/paystack-fees.ts exactly — when
// near_instant_transfer_enabled is on, this is added on top of retail so the
// customer covers it and the ₦1,500 margin is never touched. Client-side use
// is display/charge-amount only; purchase-number enforces the real amount.
export function paystackTransferFee(amountNaira: number): number {
  const base = amountNaira <= 5_000 ? 10 : amountNaira <= 50_000 ? 25 : 50;
  const stampDuty = amountNaira >= 10_000 ? 50 : 0;
  return base + stampDuty;
}

export const PLATFORM_DESCRIPTIONS: Record<string, string> = {
  PayPal: "PayPal blocks Nigerian numbers from verifying accounts. A US or UK number gets you verified instantly so you can send, receive and hold dollars.",
  TikTok: "Got banned or want a fresh start? A new number from any country lets you create a brand new TikTok account with zero links to your old one.",
  Telegram: "Create a private Telegram account or a second number for your business channel without using your personal SIM.",
  Google: "Need a second Gmail for your business or a new Google account? A foreign number bypasses Google's one-account-per-number limit.",
  Gmail: "Need a second Gmail for your business or a new Google account? A foreign number bypasses Google's one-account-per-number limit.",
  Binance: "Verify a Binance account with a number from a supported country to unlock full trading and withdrawal limits.",
  WhatsApp: "Run a WhatsApp Business account separately from your personal number, or create an account for a different country.",
  Instagram: "Create a fresh Instagram account or recover access using a real foreign number for instant verification.",
  Facebook: "Verify a new Facebook account with a foreign number to bypass restrictions on Nigerian SIM cards.",
  Twitter: "Create a new Twitter/X account or verify an existing one using a real temporary number from any country.",
  Uber: "Register a new Uber driver or rider account using a foreign number to access international markets.",
  Amazon: "Verify an Amazon seller account or create a new account with a number from a supported country.",
};

export const PLATFORM_ICONS: Record<string, string> = {
  PayPal: "payment",
  TikTok: "music-video",
  Telegram: "send",
  Google: "search",
  Gmail: "email",
  Binance: "currency-bitcoin",
  WhatsApp: "chat",
  Instagram: "photo-camera",
  Facebook: "people",
  Twitter: "tag",
  Uber: "directions-car",
  Amazon: "shopping-cart",
};

export const OTP_POLL_INTERVAL = 5000;  // 5 seconds
export const OTP_TIMEOUT = 300000;      // 5 minutes — matches Socially.ng OTP delivery window

// AsyncStorage key marking the 3-slide app intro (app/onboarding.tsx) as seen
// on this device. Only consulted when the admin toggle
// app_onboarding_force_every_session is off — otherwise it always shows.
export const APP_ONBOARDING_SEEN_KEY = 'app_onboarding_seen_v1';
