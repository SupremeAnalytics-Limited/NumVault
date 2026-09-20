import { getSupabaseClient } from '@/template';

const supabase = getSupabaseClient();

// ── Types ─────────────────────────────────────────────────────────────────────

export type ParticipantStatus =
  | 'qualifying'           // Actively building toward 76 within their 30-day window
  | 'pending_review'       // Hit 76 — awaiting admin approval before activation
  | 'eligible_not_joined'  // Legacy: approved but bank details not yet provided
  | 'active_lead'          // Paid staff — in a 30-day earning period
  | 'needs_requalification'// Completed a paid period but missed target — must re-qualify
  | 'inactive'             // Disqualified / timed out / never re-enrolled
  | 'contract_complete';   // All 6 paid periods completed

export interface AcquisitionParticipant {
  id: string;
  user_id: string;
  name: string;
  referral_code: string;
  status: ParticipantStatus;
  bank_account_number: string | null;
  bank_code: string | null;
  bank_name: string | null;
  paystack_recipient_code: string | null;
  /** Timestamp when their current qualifying window started */
  qualification_start_date: string | null;
  /** Validated customer count — frozen at 76 during qualification */
  qualification_customers_count: number;
  /** Date the first paid period began (legacy column) */
  active_lead_start_month: string | null;
  /** Exact timestamp when their current paid period started */
  paid_period_start_date: string | null;
  /** How many paid periods they have completed out of 6 */
  paid_periods_completed: number;
  /** Timestamp of when they were first approved as an active lead — used to enforce 6-month cap */
  original_activation_timestamp: string | null;
  /** Calculated end of current paid period: paid_period_start_date + 30 days */
  paid_period_end_date: string | null;
  created_at: string;
}

export interface ReferredCustomer {
  id: string;
  customer_id: string;
  participant_id: string;
  referral_code_used: string;
  signup_at: string;
  first_purchase_at: string | null;
  validated: boolean;
  validated_at: string | null;
  order_id: string | null;
  current_cycle_number: number | null;
  created_at: string;
  // joined from user_profiles when fetched by admin
  customer_email?: string;
  customer_name?: string;
}

export interface LeadPayout {
  id: string;
  participant_id: string;
  cycle_number: 1 | 2;
  monthly_window_start: string;
  amount: number;
  customers_in_cycle: number;
  paystack_transfer_code: string | null;
  status: 'pending' | 'sent' | 'failed';
  failure_reason: string | null;
  triggered_at: string;
  sent_at: string | null;
}

export interface AcquisitionLedgerEntry {
  id: string;
  order_id: string;
  amount: number;
  participant_id: string | null;
  entry_type: 'lead_obligation' | 'unattributed_profit';
  created_at: string;
}

export interface PitchItem {
  id: string;
  audience: string;
  headline: string;
  body: string;
  sort_order: number;
}

// ── Window helpers ────────────────────────────────────────────────────────────

/** @deprecated Use period-based windows instead. Kept for legacy compatibility. */
export function getCurrentMonthStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function getMonthWindowLabel(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
}

/** Days remaining in a 30-day window starting at startDateStr */
export function daysRemainingInQualification(startDateStr: string | null): number {
  if (!startDateStr) return 0;
  const start = new Date(startDateStr).getTime();
  const deadline = start + 30 * 24 * 60 * 60 * 1000;
  const remaining = Math.ceil((deadline - Date.now()) / (24 * 60 * 60 * 1000));
  return Math.max(0, remaining);
}

/** Days remaining in the current paid period (30 days from paid_period_start_date) */
export function daysRemainingInPaidPeriod(periodStartStr: string | null): number {
  return daysRemainingInQualification(periodStartStr);
}

/** End timestamp of a 30-day window starting at startDateStr */
export function getPeriodEndDate(startDateStr: string): Date {
  return new Date(new Date(startDateStr).getTime() + 30 * 24 * 60 * 60 * 1000);
}

/**
 * How many paid periods remain out of 6, based on original_activation_timestamp.
 * Returns 0 when the contract is exhausted.
 */
export function paidPeriodsRemaining(participant: AcquisitionParticipant): number {
  return Math.max(0, 6 - (participant.paid_periods_completed ?? 0));
}

/**
 * Whether the participant's 6-month contract window has expired.
 * Checks if original_activation_timestamp + 6 calendar months < now.
 */
export function isContractExpired(participant: AcquisitionParticipant): boolean {
  if (!participant.original_activation_timestamp) return false;
  const activation = new Date(participant.original_activation_timestamp);
  const contractEnd = new Date(activation);
  contractEnd.setMonth(contractEnd.getMonth() + 6);
  return Date.now() > contractEnd.getTime();
}

// ── Generate unique referral code ────────────────────────────────────────────

function generateReferralCode(name: string): string {
  const base = name
    .replace(/\s+/g, '')
    .toUpperCase()
    .slice(0, 4)
    .replace(/[^A-Z0-9]/g, 'X');
  const rand = Math.random().toString(36).toUpperCase().slice(2, 6);
  return `NV${base}${rand}`;
}

// ── Participant queries ───────────────────────────────────────────────────────

export async function getMyParticipant(): Promise<AcquisitionParticipant | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('acquisition_participants')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ?? null;
}

export async function enrollInProgram(
  name: string
): Promise<AcquisitionParticipant> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // Generate a unique referral code — retry up to 3 times on collision
  let code = generateReferralCode(name);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: existing } = await supabase
      .from('acquisition_participants')
      .select('id')
      .eq('referral_code', code)
      .maybeSingle();
    if (!existing) break;
    code = generateReferralCode(name); // regenerate on collision
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('acquisition_participants')
    .insert({
      user_id: user.id,
      name: name.trim(),
      referral_code: code,
      status: 'qualifying',
      qualification_start_date: now,
      qualification_customers_count: 0,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function reEnrollInProgram(participantId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('acquisition_participants')
    .update({
      status: 'qualifying',
      qualification_start_date: now,
      qualification_customers_count: 0,
    })
    .eq('id', participantId);
  if (error) throw new Error(error.message);
}

export async function getMyReferredCustomers(
  participantId: string
): Promise<ReferredCustomer[]> {
  const { data, error } = await supabase
    .from('referred_customers')
    .select('*')
    .eq('participant_id', participantId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

export async function getMyPayouts(
  participantId: string
): Promise<LeadPayout[]> {
  const { data, error } = await supabase
    .from('lead_payouts')
    .select('*')
    .eq('participant_id', participantId)
    .order('triggered_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data || []) as LeadPayout[];
}

export async function getPitchLibrary(): Promise<PitchItem[]> {
  const { data, error } = await supabase
    .from('pitch_library')
    .select('id,audience,headline,body,sort_order')
    .order('sort_order', { ascending: true });

  if (error) throw new Error(error.message);
  return data || [];
}

// ── Period-based cycle calculation ────────────────────────────────────────────
// Periods are exactly 30 days from the activation timestamp, NOT calendar months.

export interface CycleProgress {
  /** ISO timestamp — exact start of this 30-day period */
  periodStart: string;
  /** ISO timestamp — exact end of this 30-day period (start + 30 days) */
  periodEnd: string;
  cycle1Count: number;   // 0–38  (customers 1–38)
  cycle2Count: number;   // 0–38  (customers 39–76)
  cycle1Complete: boolean;
  cycle2Complete: boolean;
  daysRemaining: number;
  /** @deprecated kept for display labels only */
  windowStart: string;
  /** @deprecated */
  monthLabel: string;
}

/**
 * Computes cycle progress for a 30-day window starting at periodStartStr.
 * periodStartStr must be the exact paid_period_start_date timestamp.
 */
export function computeCycleProgress(
  customers: ReferredCustomer[],
  periodStartStr: string
): CycleProgress {
  const periodStart = new Date(periodStartStr);
  const periodEnd = getPeriodEndDate(periodStartStr);

  const inPeriod = customers.filter((c) => {
    if (!c.validated || !c.validated_at) return false;
    const t = new Date(c.validated_at);
    return t >= periodStart && t < periodEnd;
  });

  const total = Math.min(inPeriod.length, 76); // never count past 76
  const cycle1Count = Math.min(total, 38);
  const cycle2Count = Math.max(0, Math.min(total - 38, 38));
  const daysRemaining = daysRemainingInPaidPeriod(periodStartStr);

  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    cycle1Count,
    cycle2Count,
    cycle1Complete: cycle1Count >= 38,
    cycle2Complete: cycle2Count >= 38,
    daysRemaining,
    // Legacy fields
    windowStart: periodStartStr,
    monthLabel: getMonthWindowLabel(periodStartStr),
  };
}

/**
 * Computes qualifying progress for the 30-day qualification window.
 * Uses qualification_start_date as the window start.
 */
export function computeQualifyingProgress(
  customers: ReferredCustomer[],
  qualStartStr: string
): { count: number; daysRemaining: number; windowExpired: boolean } {
  const windowStart = new Date(qualStartStr);
  const windowEnd = getPeriodEndDate(qualStartStr);
  const daysRemaining = daysRemainingInQualification(qualStartStr);

  // During qualification we rely on the DB counter (qualification_customers_count)
  // for accuracy, but we can also count locally from referred_customers.
  const inWindow = customers.filter((c) => {
    if (!c.validated || !c.validated_at) return false;
    const t = new Date(c.validated_at);
    return t >= windowStart && t < windowEnd;
  });

  return {
    count: Math.min(inWindow.length, 76),
    daysRemaining,
    windowExpired: daysRemaining === 0,
  };
}

// ── Store referral code on signup ─────────────────────────────────────────────
// Routed through the apply-referral-code edge function so the insert uses
// service_role — authenticated users no longer have direct INSERT on
// referred_customers. All validation (self-referral, duplicates) is server-side.

export async function applyReferralCode(
  _customerId: string,
  code: string
): Promise<void> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return;

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  await fetch(`${supabaseUrl}/functions/v1/apply-referral-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ code: trimmed }),
  });
  // Failure is intentionally swallowed — caller wraps this in .catch() anyway
}
