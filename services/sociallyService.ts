import { getSupabaseClient } from '@/template';
import { FLAT_ACQUISITION_FEE as DEFAULT_FLAT_ACQUISITION_FEE } from '@/constants/config';
import { getSetting } from '@/services/settingsService';

const supabase = getSupabaseClient();

export interface Provider {
  provider_code: string;
  provider_name: string;
}

/**
 * For Server B: country_code is a SERVICE STRING (e.g. "tiktok").
 * For Server A: country_code is a NUMERIC STRING (e.g. "88") representing a real country.
 */
export interface Country {
  country_code: string;   // string for both — numeric string for A, service string for B
  title: string;
  code: string;
}

export interface Package {
  country_code: string;
  project_code: string;
  project_name: string;
  price: number;
  displayPrice: number;
}

/** A service item with pre-loaded price — only services with valid prices are included. */
export interface ServiceItem {
  country_code: string;
  title: string;
  code: string;
  package: Package;
  category: ServiceCategory;
}

export type ServiceCategory =
  | 'All'
  | 'Social'
  | 'Messaging'
  | 'Finance'
  | 'Shopping'
  | 'Other';

export type CountryRegion =
  | 'All'
  | 'Popular'
  | 'Africa'
  | 'Europe'
  | 'Americas'
  | 'Asia'
  | 'Middle East'
  | 'Other';

// ── Category detection ──────────────────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<ServiceCategory, string[]> = {
  All: [],
  Social: [
    'tiktok', 'instagram', 'facebook', 'twitter', 'x.com', 'snapchat', 'youtube',
    'pinterest', 'linkedin', 'reddit', 'tumblr', 'vk', 'ok.ru', 'weibo', 'douyin',
    'clubhouse', 'discord', 'twitch',
  ],
  Messaging: [
    'whatsapp', 'telegram', 'signal', 'viber', 'line', 'wechat', 'kakao',
    'skype', 'imo', 'zalo', 'kik', 'textme', 'textplus', 'talkatone',
  ],
  Finance: [
    'paypal', 'binance', 'coinbase', 'cashapp', 'cash app', 'stripe', 'revolut',
    'wise', 'transferwise', 'crypto', 'bitcoin', 'blockchain', 'bybit', 'okx',
    'kraken', 'kucoin', 'huobi', 'bank', 'mpesa', 'paga', 'chipper',
  ],
  Shopping: [
    'amazon', 'alibaba', 'aliexpress', 'ebay', 'shopify', 'etsy',
    'wish', 'shein', 'jumia', 'konga',
  ],
  Other: [],
};

// ── Well-known service ordering ────────────────────────────────────────────

const WELL_KNOWN_SERVICES = [
  'tiktok', 'whatsapp', 'instagram', 'facebook', 'telegram', 'twitter',
  'snapchat', 'youtube', 'gmail', 'google', 'discord', 'signal',
  'paypal', 'binance', 'amazon', 'uber', 'linkedin', 'reddit',
];

export function getServicePopularityRank(title: string): number {
  const lower = title.toLowerCase();
  const idx = WELL_KNOWN_SERVICES.findIndex((s) => lower.includes(s));
  return idx === -1 ? 999 : idx;
}

// ── Country region detection ─────────────────────────────────────────────────

const POPULAR_COUNTRIES = [
  'united states', 'usa', 'us', 'united kingdom', 'uk', 'canada',
  'australia', 'germany', 'france', 'india', 'nigeria', 'ghana',
];

const REGION_MAP: Record<CountryRegion, string[]> = {
  All: [],
  Popular: POPULAR_COUNTRIES,
  Africa: [
    'nigeria', 'ghana', 'kenya', 'south africa', 'ethiopia', 'tanzania',
    'uganda', 'senegal', 'ivory coast', 'cameroon', 'zimbabwe', 'zambia',
    'mozambique', 'angola', 'namibia', 'botswana', 'rwanda', 'mali',
    'madagascar', 'malawi', 'somalia', 'sudan', 'egypt', 'morocco',
    'algeria', 'tunisia', 'libya', 'chad', 'niger', 'burkina',
    'benin', 'togo', 'sierra leone', 'liberia', 'gambia', 'guinea',
  ],
  Europe: [
    'united kingdom', 'germany', 'france', 'spain', 'italy', 'netherlands',
    'belgium', 'portugal', 'poland', 'sweden', 'norway', 'denmark',
    'finland', 'switzerland', 'austria', 'czech', 'hungary', 'romania',
    'bulgaria', 'greece', 'ukraine', 'russia', 'ireland', 'scotland',
    'croatia', 'serbia', 'slovakia', 'estonia', 'latvia', 'lithuania',
    'luxembourg', 'malta', 'cyprus', 'iceland', 'moldova', 'albania',
  ],
  Americas: [
    'united states', 'usa', 'canada', 'brazil', 'mexico', 'argentina',
    'colombia', 'chile', 'peru', 'venezuela', 'ecuador', 'bolivia',
    'paraguay', 'uruguay', 'cuba', 'dominican', 'puerto rico', 'jamaica',
    'haiti', 'panama', 'costa rica', 'guatemala', 'honduras', 'nicaragua',
    'el salvador', 'trinidad', 'barbados',
  ],
  Asia: [
    'india', 'china', 'japan', 'south korea', 'indonesia', 'vietnam',
    'thailand', 'philippines', 'malaysia', 'singapore', 'hong kong',
    'taiwan', 'bangladesh', 'pakistan', 'sri lanka', 'nepal', 'myanmar',
    'cambodia', 'laos', 'mongolia', 'kazakhstan', 'uzbekistan',
    'azerbaijan', 'georgia', 'armenia',
  ],
  'Middle East': [
    'saudi arabia', 'uae', 'united arab', 'turkey', 'israel', 'qatar',
    'kuwait', 'bahrain', 'oman', 'jordan', 'lebanon', 'iraq', 'iran',
    'syria', 'yemen', 'palestine', 'afghanistan',
  ],
  Other: [],
};

export function detectCountryRegion(title: string): CountryRegion {
  const lower = title.toLowerCase();
  if (POPULAR_COUNTRIES.some((p) => lower.includes(p))) return 'Popular';
  for (const [region, names] of Object.entries(REGION_MAP) as [CountryRegion, string[]][]) {
    if (region === 'All' || region === 'Other' || region === 'Popular') continue;
    if (names.some((n) => lower.includes(n))) return region;
  }
  return 'Other';
}

export function detectCategory(title: string): ServiceCategory {
  const lower = title.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS) as [ServiceCategory, string[]][]) {
    if (cat === 'All' || cat === 'Other') continue;
    if (keywords.some((kw) => lower.includes(kw))) return cat;
  }
  return 'Other';
}

// ── Live margin (admin-editable) ──────────────────────────────────────────────
// Cached briefly so rapid price lookups while browsing don't each hit the DB —
// an admin change is picked up within a minute, well before it matters for
// display; purchase-number is the actual source of truth at purchase time.
let cachedMargin: { value: number; fetchedAt: number } | null = null;
const MARGIN_CACHE_MS = 60_000;

async function getFlatAcquisitionFee(): Promise<number> {
  if (cachedMargin && Date.now() - cachedMargin.fetchedAt < MARGIN_CACHE_MS) {
    return cachedMargin.value;
  }
  const value = await getSetting<number>('flat_acquisition_fee', DEFAULT_FLAT_ACQUISITION_FEE);
  cachedMargin = { value, fetchedAt: Date.now() };
  return value;
}

// ── Proxy helper ────────────────────────────────────────────────────────────

async function sociallyProxy(path: string, method = 'GET', body?: Record<string, unknown>) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const res = await supabase.functions.invoke('socially-proxy', {
    body: { path, method, body },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });

  if (res.error) {
    let msg = res.error.message;
    try {
      const txt = await (res.error as any).context?.text?.();
      if (txt) msg = txt;
    } catch {}
    throw new Error(msg);
  }

  return res.data;
}

// ── API functions ────────────────────────────────────────────────────────────

export async function getProviders(): Promise<Provider[]> {
  const data = await sociallyProxy('/sms/verification/providers');
  // API returns { providers: [...] }
  const raw: any[] =
    Array.isArray(data?.providers) ? data.providers :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data) ? data : [];
  return raw.map((p: any) => ({
    provider_code: String(p.provider_code ?? p.code ?? p.id ?? ''),
    provider_name: String(p.provider_name ?? p.name ?? p.title ?? ''),
  })).filter((p) => p.provider_code !== '');
}

export async function getCountries(providerCode: string): Promise<Country[]> {
  const data = await sociallyProxy(`/sms/verification/provider/${providerCode}/countries`);
  // API returns { countries: [...] }; fall back to data.data or bare array
  const raw: any[] =
    Array.isArray(data?.countries) ? data.countries :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data) ? data : [];
  return raw
    .filter((item: any) => item && (item.country_code !== undefined || item.id !== undefined))
    .map((item: any) => ({
      country_code: String(item.country_code ?? item.id ?? ''),
      title: item.title || item.name || item.country_name || String(item.country_code ?? item.id ?? ''),
      code: item.code || item.iso_code || item.flag_code || '',
    }))
    .filter((c) => c.country_code !== '');
}

/**
 * Get packages for a provider + country.
 * For Server B: countryCode is a service string (e.g. "tiktok")
 * For Server A: countryCode is a numeric string (e.g. "88")
 * The packages endpoint always uses the field name "country_code".
 */
export async function getPackages(providerCode: string, countryCode: string): Promise<Package[]> {
  const data = await sociallyProxy('/sms/verification/service/provider/packages', 'POST', {
    provider_code: providerCode,
    country_code: countryCode,
  });

  // API returns { packages: [...] }; fall back to data.data or bare array
  const raw: any[] =
    Array.isArray(data?.packages) ? data.packages :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.result) ? data.result :
    Array.isArray(data) ? data : [];

  const margin = await getFlatAcquisitionFee();

  const packages: Package[] = raw
    .filter((pkg: any) => pkg && (pkg.project_code || pkg.project_name))
    .map((pkg: any) => {
      const rawPrice = Number(pkg.price ?? pkg.cost ?? pkg.amount ?? 0);
      return {
        country_code: String(pkg.country_code ?? countryCode),
        project_code: String(pkg.project_code ?? pkg.id ?? ''),
        project_name: String(pkg.project_name ?? pkg.name ?? pkg.title ?? ''),
        price: rawPrice,
        displayPrice: rawPrice > 0 ? Math.ceil(rawPrice + margin) : 0,
      };
    });

  return packages;
}

/**
 * Load just the service list for a provider — NO price fetching.
 * Fast single API call. Prices are lazy-loaded per service on demand.
 */
export async function getServiceList(providerCode: string): Promise<ServiceItem[]> {
  const countries = await getCountries(providerCode);
  return countries.map((c) => ({
    country_code: c.country_code,
    title: c.title,
    code: c.code,
    package: { country_code: c.country_code, project_code: '', project_name: '', price: 0, displayPrice: 0 },
    category: detectCategory(c.title),
  }));
}

/**
 * Fetch the price for a single service on demand.
 * Returns null if no pricing available.
 */
export async function getServicePrice(providerCode: string, countryCode: string): Promise<Package | null> {
  try {
    const pkgs = await getPackages(providerCode, countryCode);
    const valid = pkgs.filter((p) => p.price > 0 && p.displayPrice > 0);
    return valid.length > 0 ? valid[0] : null;
  } catch {
    return null;
  }
}

/** @deprecated Use getServiceList + getServicePrice instead — eager-loading 2000+ prices times out. */
export async function getServicesWithPrices(providerCode: string): Promise<ServiceItem[]> {
  return getServiceList(providerCode);
}

/**
 * For Server A: given a country, load all available packages (platforms).
 * Returns packages with displayPrice applied.
 */
export async function getPackagesForCountry(providerCode: string, countryCode: string): Promise<Package[]> {
  const pkgs = await getPackages(providerCode, countryCode);
  return pkgs.filter((p) => p.price > 0 && p.displayPrice > 0);
}

/**
 * GET /request/sms/verification/{reference}/otp
 * Parses the OTP from the message string (e.g. "Your OTP (1234) has been received").
 */
export async function getOTP(reference: string): Promise<{ otp: string | null; mobile_number: string | null }> {
  try {
    const data = await sociallyProxy(`/request/sms/verification/${reference}/otp`);
    // Primary: read the clean OTP code directly from data.data.response
    // More reliable than regex-parsing the human-readable message which can
    // contain spaces inside parentheses (e.g. "(914 947)") or be reworded.
    let otp: string | null = null;
    const responseField = data?.data?.response;
    if (responseField !== undefined && responseField !== null && String(responseField).trim() !== '') {
      otp = String(responseField).trim();
    } else {
      // Fallback: parse message string, allowing optional spaces inside parens
      const message: string = data?.message || '';
      const otpMatch = message.match(/\(([\d\s]{4,12})\)/);
      if (otpMatch) otp = otpMatch[1].replace(/\s+/g, '');
    }

    const mobileNumber = data?.data?.mobile_number || null;
    return { otp, mobile_number: mobileNumber };
  } catch {
    return { otp: null, mobile_number: null };
  }
}
