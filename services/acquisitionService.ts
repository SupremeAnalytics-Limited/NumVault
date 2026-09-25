import { getSupabaseClient } from '@/template';

const supabase = getSupabaseClient();

// ── Types ─────────────────────────────────────────────────────────────────────

export type ParticipantStatus =
  | 'qualifying'
  | 'pending_review'          // Legacy — no longer used for new participants
  | 'eligible_not_joined'     // Legacy
  | 'active_lead'
  | 'needs_requalification'
  | 'inactive'
  | 'contract_complete';

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
  qualification_start_date: string | null;
  qualification_customers_count: number;
  qualification_carried_over?: number;
  active_lead_start_month: string | null;
  paid_period_start_date: string | null;
  paid_periods_completed: number;
  original_activation_timestamp: string | null;
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
  block_number: number | null;
  payout_id: string | null;
  email_normalized: string | null;
  validation_note: string | null;
  created_at: string;
  // joined from user_profiles when fetched by admin
  customer_email?: string;
  customer_name?: string;
}

export interface LeadPayout {
  id: string;
  participant_id: string;
  block_number: number | null;
  cycle_number: 1 | 2;
  monthly_window_start: string;
  period_start_timestamp: string | null;
  amount: number;
  customers_in_cycle: number;
  paystack_transfer_code: string | null;
  /** under_review | approved | sent | failed | held */
  status: 'under_review' | 'approved' | 'sent' | 'failed' | 'held' | 'pending';
  approved_at: string | null;
  review_note: string | null;
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

export function getMonthWindowLabel(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
}

export function daysRemainingInQualification(startDateStr: string | null): number {
  if (!startDateStr) return 0;
  const start = new Date(startDateStr).getTime();
  const deadline = start + 30 * 24 * 60 * 60 * 1000;
  const remaining = Math.ceil((deadline - Date.now()) / (24 * 60 * 60 * 1000));
  return Math.max(0, remaining);
}

export function daysRemainingInPaidPeriod(periodStartStr: string | null): number {
  return daysRemainingInQualification(periodStartStr);
}

export function getPeriodEndDate(startDateStr: string): Date {
  return new Date(new Date(startDateStr).getTime() + 30 * 24 * 60 * 60 * 1000);
}

export function paidPeriodsRemaining(participant: AcquisitionParticipant): number {
  return Math.max(0, 6 - (participant.paid_periods_completed ?? 0));
}

export function isContractExpired(participant: AcquisitionParticipant): boolean {
  if (!participant.original_activation_timestamp) return false;
  const activation = new Date(participant.original_activation_timestamp);
  const contractEnd = new Date(activation);
  contractEnd.setMonth(contractEnd.getMonth() + 6);
  return Date.now() > contractEnd.getTime();
}

/** Current block number for an active_lead: paid_periods_completed + 1 */
export function currentBlockNumber(participant: AcquisitionParticipant): number {
  return (participant.paid_periods_completed ?? 0) + 1;
}

/** Days remaining in current window (qualification or paid period) */
export function daysRemainingInCurrentWindow(participant: AcquisitionParticipant): number {
  if (participant.status === 'active_lead') {
    return daysRemainingInPaidPeriod(participant.paid_period_start_date);
  }
  return daysRemainingInQualification(participant.qualification_start_date);
}

// ── Participant queries ───────────────────────────────────────────────────────

export async function getMyParticipant(): Promise<AcquisitionParticipant | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('acquisition_participants')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

export async function enrollInProgram(name: string): Promise<AcquisitionParticipant> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase.rpc('enroll_in_program', { p_name: name.trim() });
  if (error) throw new Error(error.message);
  return data as AcquisitionParticipant;
}

// participantId is kept for callers; the server re-enrols the signed-in user.
export async function reEnrollInProgram(_participantId: string): Promise<void> {
  const { error } = await supabase.rpc('reenroll_in_program');
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

export interface PendingReferral {
  id: string;
  signup_at: string;
  label: string;
}

// Signed up with the lead's code but hasn't bought yet — for follow-ups.
export async function getMyPendingReferrals(): Promise<PendingReferral[]> {
  const { data, error } = await supabase.rpc('get_my_pending_referrals');
  if (error) throw new Error(error.message);
  return (data || []) as PendingReferral[];
}

export async function getMyPayouts(participantId: string): Promise<LeadPayout[]> {
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

// ── Cycle progress ────────────────────────────────────────────────────────────

export interface CycleProgress {
  periodStart: string;
  periodEnd: string;
  cycle1Count: number;
  cycle2Count: number;
  cycle1Complete: boolean;
  cycle2Complete: boolean;
  daysRemaining: number;
  windowStart: string;
  monthLabel: string;
}

export function computeCycleProgress(
  customers: ReferredCustomer[],
  periodStartStr: string,
  blockNumber: number,
): CycleProgress {
  const periodStart = new Date(periodStartStr);
  const periodEnd = getPeriodEndDate(periodStartStr);

  const inBlock = customers.filter((c) => c.validated && c.block_number === blockNumber);
  const total = Math.min(inBlock.length, 76);
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
    windowStart: periodStartStr,
    monthLabel: getMonthWindowLabel(periodStartStr),
  };
}

export function computeQualifyingProgress(
  customers: ReferredCustomer[],
  qualStartStr: string,
): { count: number; daysRemaining: number; windowExpired: boolean } {
  const daysRemaining = daysRemainingInQualification(qualStartStr);
  const inWindow = customers.filter((c) => c.validated && c.block_number === 0);
  return {
    count: Math.min(inWindow.length, 76),
    daysRemaining,
    windowExpired: daysRemaining === 0,
  };
}

// ── Apply referral code (via edge function) ───────────────────────────────────

export async function applyReferralCode(
  _customerId: string,
  code: string,
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
}

// ── Close expired blocks (via edge function) ──────────────────────────────────

export async function closeMyExpiredBlocks(): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
    await fetch(`${supabaseUrl}/functions/v1/close-blocks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({}),
    });
  } catch (e) {
    console.warn('closeMyExpiredBlocks failed (non-blocking):', e);
  }
}
