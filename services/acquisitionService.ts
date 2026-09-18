import { getSupabaseClient } from '@/template';

const supabase = getSupabaseClient();

// ── Types ─────────────────────────────────────────────────────────────────────

export type ParticipantStatus =
  | 'qualifying'
  | 'eligible_not_joined'
  | 'active_lead'
  | 'inactive';

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
  active_lead_start_month: string | null;
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

// ── Monthly window helpers ────────────────────────────────────────────────────

export function getCurrentMonthStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

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

// ── Current monthly cycle calculation ─────────────────────────────────────────

export interface CycleProgress {
  windowStart: string;         // ISO date string, first of month
  cycle1Count: number;         // 0–38
  cycle2Count: number;         // 0–38
  cycle1Complete: boolean;
  cycle2Complete: boolean;
  monthLabel: string;
}

export function computeCycleProgress(
  customers: ReferredCustomer[],
  windowStart: string
): CycleProgress {
  const monthStart = new Date(windowStart);
  const monthEnd = new Date(
    monthStart.getFullYear(),
    monthStart.getMonth() + 1,
    1
  );

  const inWindow = customers.filter((c) => {
    if (!c.validated || !c.validated_at) return false;
    const t = new Date(c.validated_at);
    return t >= monthStart && t < monthEnd;
  });

  const total = inWindow.length;
  const cycle1Count = Math.min(total, 38);
  const cycle2Count = Math.max(0, Math.min(total - 38, 38));

  return {
    windowStart,
    cycle1Count,
    cycle2Count,
    cycle1Complete: cycle1Count >= 38,
    cycle2Complete: cycle2Count >= 38,
    monthLabel: getMonthWindowLabel(windowStart),
  };
}

// ── Store referral code on signup ─────────────────────────────────────────────

export async function applyReferralCode(
  customerId: string,
  code: string
): Promise<void> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return;

  const { data: participant, error: pErr } = await supabase
    .from('acquisition_participants')
    .select('id')
    .eq('referral_code', trimmed)
    .maybeSingle();

  if (pErr || !participant) return; // invalid code — silently ignore

  // Avoid duplicate entries
  const { data: existing } = await supabase
    .from('referred_customers')
    .select('id')
    .eq('customer_id', customerId)
    .eq('participant_id', participant.id)
    .maybeSingle();

  if (existing) return;

  await supabase.from('referred_customers').insert({
    customer_id: customerId,
    participant_id: participant.id,
    referral_code_used: trimmed,
    validated: false,
  });
}
