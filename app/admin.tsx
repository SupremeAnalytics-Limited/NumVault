import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, RefreshControl, Modal,
  Platform, TextInput, Switch,
} from 'react-native';
import { getSetting, setSetting } from '@/services/settingsService';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAlert, getSupabaseClient } from '@/template';
import {
  AcquisitionParticipant, ReferredCustomer, LeadPayout, AcquisitionLedgerEntry,
  daysRemainingInQualification,
} from '@/services/acquisitionService';
import { FunctionsHttpError } from '@supabase/supabase-js';

const supabase = getSupabaseClient();
const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';

// ── Design tokens ─────────────────────────────────────────────────────────────
const BG = '#0a0d0a';
const SURFACE = '#0d1f0d';
const SURFACE2 = '#0f240f';
const BORDER = '#1a3a1a';
const BORDER2 = '#1e3a1e';
const GREEN = '#4ade80';
const MUTED = '#4a7a4a';
const MUTED2 = '#3a6a3a';
const TEXT = '#fff';
const TEXT2 = '#a0c0a0';
const ORANGE = '#fb923c';
const ORANGE_BG = 'rgba(251,146,60,0.12)';
const RED = '#f87171';
const RED_BG = 'rgba(248,113,113,0.12)';
const GOLD = '#fbbf24';
const GOLD_BG = 'rgba(251,191,36,0.12)';
const BLUE = '#60a5fa';
const BLUE_BG = 'rgba(96,165,250,0.12)';

// Default job-ad copy — mirrors LANDING_STEPS in app/acquisition-program.tsx.
// Used to seed the editor and as the reset target; the live screen's own
// fallback lives in that file so it never depends on this admin screen loading.
const DEFAULT_JOB_AD_STEPS: JobAdStep[] = [
  {
    title: 'A side income that fits your life',
    body: "Whether you're in school, at work, or building your own thing — we've created a way for you to earn on the side without changing anything about your routine. No office. No fixed hours. Just results.",
  },
  {
    title: 'Protect your number. Power your business.',
    body: "NumVault gives you a dedicated number for any platform — one that's yours permanently, with no recurring fees. It keeps your personal number private while giving your businesses their own dedicated phone numbers across 2,300+ apps and services. This protects your private contact information from data reselling and spam messages from other platforms.",
  },
  {
    title: 'Earn Your Job Position with our company as a Customer Acquisition Staff',
    body: '',
    sections: [
      { heading: 'The Money', text: 'Earn up to ₦600,000 over six months. Move fast enough and you could earn the full ₦600,000 in one day.' },
      { heading: 'How We Pay You', text: 'We pay via Paystack to Nigerian bank accounts (Palmpay, Kuda, Opay). No card details needed. 76 customers = ₦100,000. Two ₦50,000 payments: one at 38 customers, one at 76.' },
      { heading: 'What It Takes', text: 'You share your referral code. A referral counts when a new customer signs up with your code and pays for at least one number. 30 days per month to reach 76. Progress saved at 19, 38, and 57 customers.' },
      { heading: 'Extend Your Contract', text: "If you earn ₦600,000 in one day—meaning you're that efficient—contact support@numvault.cloud to extend your contract to a full year." },
    ],
  },
];

// ── Types ─────────────────────────────────────────────────────────────────────
interface AdminParticipant extends AcquisitionParticipant {
  referred_count: number;
  validated_count: number;
  total_paid: number;
}
type AdminTab = 'overview' | 'participants' | 'payouts' | 'settings';

// Mirrors LANDING_STEPS in app/acquisition-program.tsx — the pitch copy shown
// on that screen. Editing here overrides the hardcoded fallback there.
type JobAdSection = { heading: string; text: string };
type JobAdStep = { title: string; body: string; sections?: JobAdSection[] };

// Payout enriched with customer list for review
interface ReviewPayout extends LeadPayout {
  participant_name: string;
  customers: Array<{
    id: string;
    email_normalized: string | null;
    customer_name: string | null;
    validated_at: string | null;
    order_id: string | null;
    validation_note: string | null;
  }>;
}

function statusMeta(s: string): { label: string; color: string; bg: string } {
  switch (s) {
    case 'qualifying':            return { label: 'Qualifying',        color: GREEN,  bg: 'rgba(74,222,128,0.12)' };
    case 'pending_review':        return { label: 'Pending Review',    color: GOLD,   bg: GOLD_BG };
    case 'eligible_not_joined':   return { label: 'Eligible',          color: GREEN,  bg: 'rgba(74,222,128,0.12)' };
    case 'active_lead':           return { label: 'Active Lead',       color: GREEN,  bg: 'rgba(74,222,128,0.18)' };
    case 'needs_requalification': return { label: 'Re-qualify',        color: ORANGE, bg: ORANGE_BG };
    case 'contract_complete':     return { label: 'Contract Complete', color: MUTED,  bg: '#111a11' };
    case 'inactive':              return { label: 'Inactive',          color: MUTED,  bg: '#111a11' };
    default:                      return { label: s,                   color: MUTED,  bg: '#111a11' };
  }
}

function payoutStatusMeta(s: string): { label: string; color: string; bg: string } {
  switch (s) {
    case 'under_review': return { label: 'Under Review', color: GOLD,   bg: GOLD_BG };
    case 'approved':     return { label: 'Approved',     color: BLUE,   bg: BLUE_BG };
    case 'sent':         return { label: 'Sent',         color: GREEN,  bg: 'rgba(74,222,128,0.12)' };
    case 'failed':       return { label: 'Failed',       color: RED,    bg: RED_BG };
    case 'held':         return { label: 'Held',         color: ORANGE, bg: ORANGE_BG };
    case 'pending':      return { label: 'Under Review', color: GOLD,   bg: GOLD_BG };
    default:             return { label: s,              color: MUTED,  bg: '#111a11' };
  }
}

function maskAccount(num: string | null): string {
  if (!num) return '—';
  if (num.length <= 4) return num;
  return '•'.repeat(num.length - 4) + num.slice(-4);
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function AdminDashboardScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { showAlert } = useAlert();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  const [participants, setParticipants] = useState<AdminParticipant[]>([]);
  const [allPayouts, setAllPayouts] = useState<LeadPayout[]>([]);
  const [reviewPayouts, setReviewPayouts] = useState<ReviewPayout[]>([]);
  const [unattributedTotal, setUnattributedTotal] = useState(0);
  const [obligationTotal, setObligationTotal] = useState(0);
  const [totalTransferred, setTotalTransferred] = useState(0);

  // Withdrawable card — fetched manually (not on 30s auto-refresh)
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  const [withdrawable, setWithdrawable] = useState<{
    paystack_available: number;
    payouts_owed: number;
    accruing: number;
    topup_reserve: number;
    cushion: number;
    safe_to_withdraw: number;
  } | null>(null);
  const [withdrawableLoading, setWithdrawableLoading] = useState(false);
  const [withdrawableError, setWithdrawableError] = useState<string | null>(null);

  const [detailP, setDetailP] = useState<AdminParticipant | null>(null);
  const [detailRefs, setDetailRefs] = useState<ReferredCustomer[]>([]);
  const [detailPayouts, setDetailPayouts] = useState<LeadPayout[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const [participantFilter, setParticipantFilter] = useState<string>('all');
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectNoteInput, setRejectNoteInput] = useState('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [selectedPayoutForReject, setSelectedPayoutForReject] = useState<ReviewPayout | null>(null);

  // ── Settings tab ──────────────────────────────────────────────────────────
  const [nearInstantTransfer, setNearInstantTransfer] = useState(false);
  const [transferToggleSaving, setTransferToggleSaving] = useState(false);
  const [marginValue, setMarginValue] = useState('1500');
  const [marginDirty, setMarginDirty] = useState(false);
  const [marginSaving, setMarginSaving] = useState(false);
  const [jobAdSteps, setJobAdSteps] = useState<JobAdStep[] | null>(null);
  const [jobAdLoading, setJobAdLoading] = useState(false);
  const [jobAdSaving, setJobAdSaving] = useState(false);
  const [jobAdDirty, setJobAdDirty] = useState(false);

  const loadSettings = useCallback(async () => {
    setJobAdLoading(true);
    try {
      const [enabled, steps, margin] = await Promise.all([
        getSetting<boolean>('near_instant_transfer_enabled', false),
        getSetting<JobAdStep[] | null>('job_ad_content', null),
        getSetting<number>('flat_acquisition_fee', 1500),
      ]);
      setNearInstantTransfer(!!enabled);
      setJobAdSteps(steps ?? DEFAULT_JOB_AD_STEPS);
      setJobAdDirty(false);
      setMarginValue(String(margin));
      setMarginDirty(false);
    } catch (e) {
      console.warn('Failed to load settings:', e);
    } finally {
      setJobAdLoading(false);
    }
  }, []);

  useEffect(() => { checkAndLoad(); }, []);
  useEffect(() => { if (activeTab === 'settings' && jobAdSteps === null) loadSettings(); }, [activeTab, jobAdSteps, loadSettings]);

  const toggleNearInstantTransfer = async (value: boolean) => {
    setTransferToggleSaving(true);
    const previous = nearInstantTransfer;
    setNearInstantTransfer(value); // optimistic
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await setSetting('near_instant_transfer_enabled', value);
    } catch (e: any) {
      setNearInstantTransfer(previous);
      showAlert('Could not save', e.message || 'Failed to update the transfer mode.');
    } finally {
      setTransferToggleSaving(false);
    }
  };

  const saveMargin = async () => {
    const parsed = Number(marginValue);
    if (!Number.isFinite(parsed) || parsed < 0) {
      showAlert('Invalid amount', 'Enter a margin of ₦0 or more.');
      return;
    }
    setMarginSaving(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await setSetting('flat_acquisition_fee', parsed);
      setMarginValue(String(parsed));
      setMarginDirty(false);
      showAlert('Saved', `Every number sale now adds ₦${parsed.toLocaleString()} margin — applies immediately, across all providers and services.`);
    } catch (e: any) {
      showAlert('Could not save', e.message || 'Failed to update the margin.');
    } finally {
      setMarginSaving(false);
    }
  };

  const updateJobAdField = (stepIdx: number, field: 'title' | 'body', value: string) => {
    setJobAdSteps((prev) => {
      if (!prev) return prev;
      const next = prev.map((s, i) => (i === stepIdx ? { ...s, [field]: value } : s));
      return next;
    });
    setJobAdDirty(true);
  };

  const updateJobAdSectionText = (stepIdx: number, sectionIdx: number, value: string) => {
    setJobAdSteps((prev) => {
      if (!prev) return prev;
      const next = prev.map((s, i) => {
        if (i !== stepIdx || !s.sections) return s;
        const sections = s.sections.map((sec, j) => (j === sectionIdx ? { ...sec, text: value } : sec));
        return { ...s, sections };
      });
      return next;
    });
    setJobAdDirty(true);
  };

  const saveJobAdContent = async () => {
    if (!jobAdSteps) return;
    setJobAdSaving(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await setSetting('job_ad_content', jobAdSteps);
      setJobAdDirty(false);
      showAlert('Saved', 'The acquisition program screen will show this text on next load — no app update needed.');
    } catch (e: any) {
      showAlert('Could not save', e.message || 'Failed to save the job ad text.');
    } finally {
      setJobAdSaving(false);
    }
  };

  const resetJobAdContent = () => {
    showAlert('Reset to default text?', 'This discards your edits and restores the built-in copy.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: () => { setJobAdSteps(DEFAULT_JOB_AD_STEPS); setJobAdDirty(true); } },
    ]);
  };

  useEffect(() => {
    if (!isAdmin) return;
    const interval = setInterval(() => { loadAll(); }, 30_000);
    return () => clearInterval(interval);
  }, [isAdmin, loadAll]);

  const fetchWithdrawable = useCallback(async () => {
    setWithdrawableLoading(true);
    setWithdrawableError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const res = await fetch(`${supabaseUrl}/functions/v1/admin-withdrawable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setWithdrawableError(data.error || 'Unavailable');
      } else {
        setWithdrawable(data);
      }
    } catch (e: any) {
      setWithdrawableError(e.message || 'Unavailable');
    } finally {
      setWithdrawableLoading(false);
    }
  }, []);

  const checkAndLoad = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.email !== ADMIN_EMAIL) { setIsAdmin(false); setLoading(false); return; }
    setIsAdmin(true);
    fetchWithdrawable();
    // Close expired blocks for all active leads on admin load
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
        await fetch(`${supabaseUrl}/functions/v1/close-blocks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
          body: JSON.stringify({ participant_id: 'all' }),
        });
      }
    } catch { /* non-blocking */ }
    await loadAll();
  };

  const loadAll = useCallback(async () => {
    try {
      const [{ data: parts }, { data: pays }, { data: ledger }] = await Promise.all([
        supabase.from('acquisition_participants').select('*').order('created_at', { ascending: false }),
        supabase.from('lead_payouts').select('*').order('triggered_at', { ascending: false }),
        supabase.from('acquisition_ledger_entries').select('*'),
      ]);

      if (parts) {
        const enriched: AdminParticipant[] = await Promise.all(
          parts.map(async (p) => {
            const [{ count: refCount }, { count: valCount }, { data: paidOuts }] = await Promise.all([
              supabase.from('referred_customers').select('*', { count: 'exact', head: true }).eq('participant_id', p.id),
              supabase.from('referred_customers').select('*', { count: 'exact', head: true }).eq('participant_id', p.id).eq('validated', true),
              supabase.from('lead_payouts').select('amount').eq('participant_id', p.id).eq('status', 'sent'),
            ]);
            return { ...p, referred_count: refCount ?? 0, validated_count: valCount ?? 0, total_paid: (paidOuts || []).reduce((s: number, x: any) => s + Number(x.amount), 0) } as AdminParticipant;
          })
        );
        setParticipants(enriched);
      }

      const paysData = (pays || []) as LeadPayout[];
      setAllPayouts(paysData);
      setTotalTransferred(paysData.filter((p) => p.status === 'sent').reduce((s, p) => s + Number(p.amount), 0));

      // Build review payouts (under_review, approved, failed)
      const reviewable = paysData.filter((p) =>
        p.status === 'under_review' || p.status === 'approved' || p.status === 'failed' || p.status === 'pending'
      );

      const enrichedReview: ReviewPayout[] = await Promise.all(
        reviewable.map(async (pout) => {
          const participant = (parts || []).find((p) => p.id === pout.participant_id);
          // Fetch customers attached to this payout
          const { data: customers } = await supabase
            .from('referred_customers')
            .select('id, email_normalized, validated_at, order_id, validation_note, customer_id')
            .eq('payout_id', pout.id)
            .eq('validated', true)
            .order('validated_at', { ascending: true });

          // Fetch customer names
          const enrichedCustomers = await Promise.all(
            (customers || []).map(async (c) => {
              const { data: profile } = await supabase
                .from('user_profiles')
                .select('name, email')
                .eq('id', c.customer_id)
                .maybeSingle();
              return {
                id: c.id,
                email_normalized: c.email_normalized,
                customer_name: profile?.name ?? null,
                validated_at: c.validated_at,
                order_id: c.order_id,
                validation_note: c.validation_note,
              };
            })
          );

          return {
            ...pout,
            participant_name: participant?.name ?? 'Unknown',
            customers: enrichedCustomers,
          } as ReviewPayout;
        })
      );
      setReviewPayouts(enrichedReview);

      const allLedger = ledger || [];
      setUnattributedTotal(allLedger.filter((l: any) => l.entry_type === 'unattributed_profit').reduce((s: number, l: any) => s + Number(l.amount), 0));

      // Obligation = unsent payouts + accruing earnings for active leads
      const payoutsOwed = (paysData)
        .filter((p) => ['pending','under_review','approved','held','failed'].includes(p.status))
        .reduce((s, p) => s + Number(p.amount), 0);
      const activeLeadAccruing = (parts ?? []).filter((p) => p.status === 'active_lead').reduce((s, p) => {
        const count = Number((p as any).qualification_customers_count ?? 0);
        return s + Math.max(0, count * (100000 / 76) - (count >= 38 ? 50000 : 0));
      }, 0);
      setObligationTotal(Math.round(payoutsOwed + activeLeadAccruing));
    } catch (e) {
      console.error('Admin load error', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const openDetail = async (p: AdminParticipant) => {
    setDetailP(p);
    setDetailLoading(true);
    const [{ data: refs }, { data: pays }] = await Promise.all([
      supabase.from('referred_customers').select('*').eq('participant_id', p.id).order('validated_at', { ascending: false }),
      supabase.from('lead_payouts').select('*').eq('participant_id', p.id).order('triggered_at', { ascending: false }),
    ]);
    setDetailRefs((refs || []) as ReferredCustomer[]);
    setDetailPayouts((pays || []) as LeadPayout[]);
    setDetailLoading(false);
  };

  // ── Payout actions ────────────────────────────────────────────────────────

  const handleApprovePayout = async (payout: ReviewPayout) => {
    showAlert(
      `Approve ₦${Number(payout.amount).toLocaleString()}?`,
      `Block ${payout.block_number ?? '?'} Half ${payout.cycle_number} · ${payout.customers_in_cycle} customers. This will send a Paystack transfer.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve & Send',
          style: 'default',
          onPress: async () => {
            setActionLoading(true);
            try {
              const { data: { session } } = await supabase.auth.getSession();
              const token = session?.access_token;
              const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
              const res = await fetch(`${supabaseUrl}/functions/v1/approve-payout`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({ payout_id: payout.id, action: 'approve' }),
              });
              const data = await res.json();
              if (!res.ok || data.error) {
                showAlert('Error', data.error || 'Approval failed');
              } else if (data.status === 'sent') {
                showAlert('Sent', `Transfer sent. Code: ${data.transfer_code || '—'}`);
              } else if (data.status === 'failed') {
                showAlert('Transfer Failed', data.reason || 'Paystack transfer failed');
              } else {
                showAlert('Approved', 'Payout approved. Transfer processing.');
              }
              await loadAll();
            } catch (e: any) {
              showAlert('Error', e.message || 'Unexpected error');
            } finally {
              setActionLoading(false);
            }
          },
        },
      ]
    );
  };

  const handleRetryPayout = async (payout: ReviewPayout) => {
    showAlert(
      `Retry ₦${Number(payout.amount).toLocaleString()}?`,
      `Re-attempt Paystack transfer for Block ${payout.block_number ?? '?'} Half ${payout.cycle_number}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Retry',
          style: 'default',
          onPress: async () => {
            setActionLoading(true);
            try {
              const { data: { session } } = await supabase.auth.getSession();
              const token = session?.access_token;
              const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
              const res = await fetch(`${supabaseUrl}/functions/v1/approve-payout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ payout_id: payout.id, action: 'approve' }),
              });
              const data = await res.json();
              if (!res.ok || data.error) {
                showAlert('Error', data.error || 'Retry failed');
              } else {
                showAlert('Retried', 'Transfer re-attempted.');
              }
              await loadAll();
            } catch (e: any) {
              showAlert('Error', e.message);
            } finally {
              setActionLoading(false);
            }
          },
        },
      ]
    );
  };

  const openRejectModal = (payout: ReviewPayout) => {
    setSelectedPayoutForReject(payout);
    setRejectNoteInput('');
    setShowRejectModal(true);
  };

  const confirmReject = async () => {
    if (!selectedPayoutForReject) return;
    setShowRejectModal(false);
    setActionLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const res = await fetch(`${supabaseUrl}/functions/v1/approve-payout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ payout_id: selectedPayoutForReject.id, action: 'reject', review_note: rejectNoteInput }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        showAlert('Error', data.error || 'Reject failed');
      } else {
        showAlert('Held', 'Payout held. Participant notified.');
      }
      await loadAll();
    } catch (e: any) {
      showAlert('Error', e.message);
    } finally {
      setActionLoading(false);
      setSelectedPayoutForReject(null);
    }
  };

  // ── Guards ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={GREEN} size="large" />
      </View>
    );
  }

  if (isAdmin === false) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <View style={styles.accessDeniedIcon}><MaterialIcons name="lock" size={32} color={RED} /></View>
        <Text style={styles.accessDeniedTitle}>Admin access only</Text>
        <Text style={styles.accessDeniedSub}>This area is restricted to authorised staff.</Text>
        <TouchableOpacity style={styles.accessDeniedBtn} onPress={() => router.back()} activeOpacity={0.8}>
          <Text style={styles.accessDeniedBtnText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Derived stats ─────────────────────────────────────────────────────────
  const activeLeads = participants.filter((p) => p.status === 'active_lead').length;
  const qualifying  = participants.filter((p) => p.status === 'qualifying').length;
  const failedPayouts = allPayouts.filter((t) => t.status === 'failed').length;
  const underReviewCount = reviewPayouts.length;

  const filteredParticipants = participantFilter === 'all'
    ? participants
    : participants.filter((p) => p.status === participantFilter);

  const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'qualifying', label: 'Qualifying' },
    { key: 'active_lead', label: 'Active' },
    { key: 'needs_requalification', label: 'Re-qualify' },
    { key: 'contract_complete', label: 'Done' },
  ];

  const TABS: { key: AdminTab; label: string; icon: keyof typeof MaterialIcons.glyphMap; badge?: number }[] = [
    { key: 'overview',      label: 'Overview',   icon: 'dashboard' },
    { key: 'participants',  label: 'Team',        icon: 'groups',   badge: participants.length },
    { key: 'payouts',       label: 'Approvals',   icon: 'payments', badge: underReviewCount || undefined },
    { key: 'settings',      label: 'Settings',    icon: 'tune' },
  ];

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={BG} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
          <MaterialIcons name="arrow-back" size={20} color={GREEN} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Admin Dashboard</Text>
          <Text style={styles.headerSub}>NumVault Acquisition Program</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn}
          onPress={() => { setRefreshing(true); loadAll(); fetchWithdrawable(); }} activeOpacity={0.7}>
          {refreshing ? <ActivityIndicator size="small" color={GREEN} /> : <MaterialIcons name="refresh" size={19} color={MUTED} />}
        </TouchableOpacity>
      </View>

      <View style={styles.tabBarWrap}>
        {TABS.map((t) => {
          const active = activeTab === t.key;
          return (
            <TouchableOpacity key={t.key}
              style={[styles.tabItem, active && styles.tabItemActive]}
              onPress={async () => { await Haptics.selectionAsync(); setActiveTab(t.key); }}
              activeOpacity={0.8}>
              <MaterialIcons name={t.icon} size={16} color={active ? GREEN : MUTED} />
              <Text style={[styles.tabItemText, active && styles.tabItemTextActive]}>{t.label}</Text>
              {t.badge ? (
                <View style={[styles.tabBadge, active && styles.tabBadgeActive]}>
                  <Text style={[styles.tabBadgeText, active && styles.tabBadgeTextActive]}>{t.badge}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadAll(); }}
            tintColor={GREEN} colors={[GREEN]} />
        }
      >
        {/* ─────────────────── OVERVIEW ─────────────────── */}
        {activeTab === 'overview' && (
          <>
            {underReviewCount > 0 && (
              <TouchableOpacity style={styles.alertBanner} onPress={() => setActiveTab('payouts')} activeOpacity={0.8}>
                <View style={styles.alertBannerDot} />
                <Text style={styles.alertBannerText}>{underReviewCount} payout{underReviewCount > 1 ? 's' : ''} waiting for your approval</Text>
                <MaterialIcons name="chevron-right" size={16} color={GOLD} />
              </TouchableOpacity>
            )}
            {failedPayouts > 0 && (
              <TouchableOpacity style={[styles.alertBanner, styles.alertBannerRed]} onPress={() => setActiveTab('payouts')} activeOpacity={0.8}>
                <View style={[styles.alertBannerDot, { backgroundColor: RED }]} />
                <Text style={[styles.alertBannerText, { color: RED }]}>{failedPayouts} failed transfer{failedPayouts > 1 ? 's' : ''} — action required</Text>
                <MaterialIcons name="chevron-right" size={16} color={RED} />
              </TouchableOpacity>
            )}

            <View style={styles.sectionLabel}><Text style={styles.sectionLabelText}>FINANCIAL OVERVIEW</Text></View>

            {/* Available withdrawal card */}
            <View style={[finStyles.card, { borderColor: GREEN + '44', gap: 0 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <View style={[finStyles.iconWrap, { backgroundColor: GREEN + '18' }]}>
                  <MaterialIcons name="savings" size={18} color={GREEN} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[finStyles.label, { marginBottom: 0 }]}>Available withdrawal</Text>
                  <Text style={[finStyles.sub, { marginTop: 1 }]}>After all obligations and reserves</Text>
                </View>
                <TouchableOpacity
                  onPress={fetchWithdrawable}
                  disabled={withdrawableLoading}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  activeOpacity={0.7}
                >
                  {withdrawableLoading
                    ? <ActivityIndicator size="small" color={GREEN} />
                    : <MaterialIcons name="refresh" size={16} color={MUTED} />}
                </TouchableOpacity>
              </View>
              {withdrawableError ? (
                <Text style={{ color: RED, fontSize: 13, fontWeight: '600', marginBottom: 8 }}>Unavailable</Text>
              ) : withdrawable ? (
                <>
                  <Text style={{ color: GREEN, fontSize: 28, fontWeight: '700', marginBottom: 4 }}>
                    ₦{withdrawable.safe_to_withdraw.toLocaleString()}
                  </Text>
                  <Text style={{ color: MUTED, fontSize: 11, marginBottom: 10 }}>
                    Paystack balance ₦{withdrawable.paystack_available.toLocaleString()}
                  </Text>
                  <TouchableOpacity
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginBottom: breakdownOpen ? 10 : 0 }}
                    onPress={() => setBreakdownOpen((v) => !v)}
                    activeOpacity={0.7}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={{ fontSize: 11, color: MUTED, fontWeight: '600' }}>See breakdown</Text>
                    <MaterialIcons name={breakdownOpen ? 'keyboard-arrow-up' : 'keyboard-arrow-down'} size={14} color={MUTED} />
                  </TouchableOpacity>
                  {breakdownOpen ? (
                    <View style={{ gap: 6 }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: MUTED2, letterSpacing: 1, marginBottom: 2 }}>HELD BACK FROM YOUR BALANCE</Text>
                      {[
                        { label: 'Payouts owed', value: `₦${withdrawable.payouts_owed.toLocaleString()}`, warn: withdrawable.payouts_owed > 0 },
                        { label: 'Earning this month', value: `₦${withdrawable.accruing.toLocaleString()}`, warn: withdrawable.accruing > 0 },
                        { label: 'Top-up reserve', value: `₦${withdrawable.topup_reserve.toLocaleString()}` },
                        { label: 'Cushion', value: `₦${withdrawable.cushion.toLocaleString()}` },
                      ].map((row) => (
                        <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                          <Text style={{ fontSize: 11, color: MUTED }}>{row.label}</Text>
                          <Text style={{ fontSize: 11, fontWeight: '600', color: row.warn ? GOLD : TEXT2 }}>{row.value}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </>
              ) : withdrawableLoading ? (
                <Text style={{ color: MUTED, fontSize: 13, marginBottom: 10 }}>Loading...</Text>
              ) : null}
            </View>
            <View style={styles.finRow}>
              <FinCard label="Lead Obligations" value={`₦${obligationTotal.toLocaleString()}`} icon="account-balance" accent={GREEN} sub="Total owed to leads" />
              <FinCard label="Unattributed" value={`₦${unattributedTotal.toLocaleString()}`} icon="trending-up" accent="#60a5fa" sub="No referral attached" />
            </View>
            <View style={styles.finRow}>
              <FinCard label="Total Transferred" value={`₦${totalTransferred.toLocaleString()}`} icon="send" accent={GREEN} sub={`${allPayouts.filter((t) => t.status === 'sent').length} sent`} />
              <FinCard label="Under Review" value={String(underReviewCount)} icon="pending" accent={GOLD} sub="Awaiting approval" />
            </View>

            <View style={styles.sectionLabel}><Text style={styles.sectionLabelText}>PROGRAM STATS</Text></View>
            <View style={styles.statsGrid}>
              <StatTile icon="groups" label="Total Enrolled" value={String(participants.length)} />
              <StatTile icon="star" label="Active Leads" value={String(activeLeads)} accent={GREEN} />
              <StatTile icon="school" label="Qualifying" value={String(qualifying)} accent={GREEN} />
              <StatTile icon="fact-check" label="For Approval" value={String(underReviewCount)} accent={underReviewCount > 0 ? GOLD : MUTED} />
              <StatTile icon="error-outline" label="Failed Pays" value={String(failedPayouts)} accent={failedPayouts > 0 ? RED : MUTED} />
              <StatTile icon="how-to-reg" label="Contracts Done" value={String(participants.filter((p) => p.status === 'contract_complete').length)} />
            </View>
          </>
        )}

        {/* ─────────────────── TEAM ─────────────────── */}
        {activeTab === 'participants' && (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
              {FILTERS.map((f) => (
                <TouchableOpacity key={f.key}
                  style={[styles.filterChip, participantFilter === f.key && styles.filterChipActive]}
                  onPress={() => setParticipantFilter(f.key)} activeOpacity={0.8}>
                  <Text style={[styles.filterChipText, participantFilter === f.key && styles.filterChipTextActive]}>{f.label}</Text>
                  {f.key !== 'all' && (
                    <Text style={[styles.filterChipCount, participantFilter === f.key && { color: GREEN }]}>
                      {participants.filter((p) => p.status === f.key).length}
                    </Text>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>

            {filteredParticipants.length === 0 ? (
              <EmptyState icon="groups" title="No participants" sub="Nobody matches this filter yet." />
            ) : (
              filteredParticipants.map((p) => (
                <TouchableOpacity key={p.id} style={styles.participantCard}
                  onPress={() => openDetail(p)} activeOpacity={0.8}>
                  <View style={styles.participantAvatar}>
                    <Text style={styles.participantAvatarText}>{p.name.charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={styles.participantName} numberOfLines={1}>{p.name}</Text>
                    <Text style={styles.participantCode}>{p.referral_code}</Text>
                    <View style={styles.participantMetaRow}>
                      <Text style={styles.participantMeta}>{p.validated_count} validated</Text>
                      {p.total_paid > 0 && (
                        <>
                          <Text style={[styles.participantMeta, { color: MUTED2 }]}>·</Text>
                          <Text style={[styles.participantMeta, { color: GREEN }]}>₦{p.total_paid.toLocaleString()} paid</Text>
                        </>
                      )}
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 6 }}>
                    <StatusPill status={p.status} />
                    <MaterialIcons name="chevron-right" size={16} color={MUTED2} />
                  </View>
                </TouchableOpacity>
              ))
            )}
          </>
        )}

        {/* ─────────────────── PAYOUT APPROVALS ─────────────────── */}
        {activeTab === 'payouts' && (
          <>
            {/* Summary strip */}
            <View style={styles.payoutSummaryRow}>
              <PayoutSummaryItem label="Under Review" value={String(allPayouts.filter((t) => t.status === 'under_review' || t.status === 'pending').length)} color={GOLD} />
              <PayoutSummaryItem label="Approved" value={String(allPayouts.filter((t) => t.status === 'approved').length)} color={BLUE} />
              <PayoutSummaryItem label="Sent" value={String(allPayouts.filter((t) => t.status === 'sent').length)} color={GREEN} />
              <PayoutSummaryItem label="Failed" value={String(failedPayouts)} color={failedPayouts > 0 ? RED : MUTED} />
            </View>

            {reviewPayouts.length === 0 ? (
              <EmptyState icon="payments" title="No payouts awaiting approval"
                sub="Payout records will appear here when participants hit 38 or 76 customers in a block." />
            ) : null}

            {reviewPayouts.map((pout) => {
              const sm = payoutStatusMeta(pout.status);
              return (
                <View key={pout.id} style={[styles.reviewPayoutCard, { borderColor: sm.color + '44' }]}>
                  {/* Header */}
                  <View style={styles.reviewPayoutHeader}>
                    <View style={[styles.payoutIconWrap, { backgroundColor: sm.bg }]}>
                      <MaterialIcons
                        name={pout.status === 'sent' ? 'check-circle' : pout.status === 'failed' ? 'error' : pout.status === 'held' ? 'pause-circle' : 'pending'}
                        size={18} color={sm.color}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.reviewPayoutName}>{pout.participant_name}</Text>
                      <Text style={styles.reviewPayoutMeta}>
                        Block {pout.block_number ?? '?'} · Half {pout.cycle_number} · {pout.customers_in_cycle} customers
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 4 }}>
                      <Text style={[styles.reviewPayoutAmount, { color: sm.color }]}>
                        ₦{Number(pout.amount).toLocaleString()}
                      </Text>
                      <View style={[styles.statusChip, { backgroundColor: sm.bg, borderColor: sm.color + '55' }]}>
                        <Text style={[styles.statusChipText, { color: sm.color }]}>{sm.label}</Text>
                      </View>
                    </View>
                  </View>

                  {/* Failure reason */}
                  {pout.status === 'failed' && pout.failure_reason ? (
                    <View style={styles.failureBox}>
                      <MaterialIcons name="error-outline" size={12} color={RED} />
                      <Text style={styles.failureText} numberOfLines={2}>{pout.failure_reason}</Text>
                    </View>
                  ) : null}

                  {/* Hold note */}
                  {pout.status === 'held' && pout.review_note ? (
                    <View style={styles.holdBox}>
                      <MaterialIcons name="info" size={12} color={ORANGE} />
                      <Text style={styles.holdText}>{pout.review_note}</Text>
                    </View>
                  ) : null}

                  {/* Customer list */}
                  {pout.customers.length > 0 ? (
                    <View style={styles.customerListWrap}>
                      <Text style={styles.customerListTitle}>
                        Customers ({pout.customers.length})
                      </Text>
                      {pout.customers.map((c, i) => (
                        <View key={c.id} style={[styles.customerRow, i === pout.customers.length - 1 && { borderBottomWidth: 0 }]}>
                          <View style={[styles.customerIcon, c.validation_note === 'duplicate_email' ? { backgroundColor: RED_BG } : null]}>
                            <MaterialIcons
                              name={c.validation_note === 'duplicate_email' ? 'error' : 'person'}
                              size={12}
                              color={c.validation_note === 'duplicate_email' ? RED : GREEN}
                            />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.customerEmail} numberOfLines={1}>
                              {c.email_normalized ?? '—'}
                            </Text>
                            {c.customer_name ? (
                              <Text style={styles.customerName}>{c.customer_name}</Text>
                            ) : null}
                            {c.validated_at ? (
                              <Text style={styles.customerTime}>
                                {new Date(c.validated_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}
                              </Text>
                            ) : null}
                            {c.validation_note ? (
                              <Text style={[styles.customerNote, { color: RED }]}>{c.validation_note}</Text>
                            ) : null}
                          </View>
                          {c.order_id ? (
                            <Text style={styles.orderIdChip} numberOfLines={1}>
                              {c.order_id.slice(0, 8)}…
                            </Text>
                          ) : null}
                        </View>
                      ))}
                    </View>
                  ) : (
                    <Text style={styles.noCustomersText}>No customers linked to this payout yet.</Text>
                  )}

                  {/* Actions */}
                  {(pout.status === 'under_review' || pout.status === 'pending' || pout.status === 'approved') ? (
                    <View style={styles.payoutActions}>
                      <TouchableOpacity
                        style={[styles.actionBtn, styles.rejectBtn]}
                        onPress={() => openRejectModal(pout)}
                        disabled={actionLoading}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.rejectBtnText}>Hold</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.actionBtn, styles.approveBtn, actionLoading && { opacity: 0.5 }]}
                        onPress={() => handleApprovePayout(pout)}
                        disabled={actionLoading}
                        activeOpacity={0.85}
                      >
                        {actionLoading ? <ActivityIndicator size="small" color={BG} /> : (
                          <>
                            <MaterialIcons name="send" size={14} color={BG} />
                            <Text style={styles.approveBtnText}>Approve & Send</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </View>
                  ) : pout.status === 'failed' ? (
                    <TouchableOpacity
                      style={[styles.retryBtn, actionLoading && { opacity: 0.5 }]}
                      onPress={() => handleRetryPayout(pout)}
                      disabled={actionLoading}
                      activeOpacity={0.85}
                    >
                      <MaterialIcons name="refresh" size={14} color={GOLD} />
                      <Text style={styles.retryBtnText}>Retry Transfer</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })}

            {/* Sent payouts summary */}
            {allPayouts.filter((p) => p.status === 'sent').length > 0 ? (
              <>
                <View style={[styles.sectionLabel, { marginTop: 8 }]}>
                  <Text style={styles.sectionLabelText}>SENT PAYOUTS</Text>
                </View>
                {allPayouts.filter((p) => p.status === 'sent').map((t) => {
                  const p = participants.find((x) => x.id === t.participant_id);
                  return (
                    <View key={t.id} style={[styles.sentPayoutRow]}>
                      <View style={[styles.payoutIconWrap, { backgroundColor: 'rgba(74,222,128,0.12)' }]}>
                        <MaterialIcons name="check-circle" size={16} color={GREEN} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.sentPayoutName}>{p?.name ?? '—'}</Text>
                        <Text style={styles.sentPayoutMeta}>
                          Block {(t as any).block_number ?? '?'} · Half {t.cycle_number} · {t.customers_in_cycle} customers
                        </Text>
                        {t.sent_at ? (
                          <Text style={styles.sentPayoutDate}>
                            Sent {new Date(t.sent_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </Text>
                        ) : null}
                      </View>
                      <Text style={[styles.reviewPayoutAmount, { color: GREEN }]}>
                        ₦{Number(t.amount).toLocaleString()}
                      </Text>
                    </View>
                  );
                })}
              </>
            ) : null}
          </>
        )}

        {/* ─────────────────── SETTINGS ─────────────────── */}
        {activeTab === 'settings' && (
          <>
            <View style={settingsStyles.card}>
              <View style={settingsStyles.rowBetween}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={settingsStyles.cardTitle}>Near-instant Socially.ng transfers</Text>
                  <Text style={settingsStyles.cardSub}>
                    {nearInstantTransfer
                      ? 'ON — every number purchase pays Socially.ng its exact wholesale cost via a direct Paystack transfer, right away. No settlement split.'
                      : 'OFF — using the current T+1 settlement split. Wholesale account depreciates at purchase time and is replenished the next day; margin is still kept immediately either way.'}
                  </Text>
                </View>
                {transferToggleSaving ? (
                  <ActivityIndicator color={GREEN} />
                ) : (
                  <Switch
                    value={nearInstantTransfer}
                    onValueChange={toggleNearInstantTransfer}
                    trackColor={{ false: BORDER2, true: 'rgba(74,222,128,0.4)' }}
                    thumbColor={nearInstantTransfer ? GREEN : MUTED}
                  />
                )}
              </View>
              <Text style={settingsStyles.hint}>
                Turn this on once Paystack has approved the business account and transfers are confirmed working. Turning it off at any time reverts immediately to the split.
              </Text>
            </View>

            <View style={settingsStyles.card}>
              <Text style={settingsStyles.cardTitle}>Margin per number sale</Text>
              <Text style={settingsStyles.cardSub}>
                Added on top of wholesale cost for every number, across all providers and services. Takes effect immediately on save — no app update needed.
              </Text>
              <View style={[settingsStyles.rowBetween, { alignItems: 'center', marginTop: 4 }]}>
                <View style={settingsStyles.marginInputWrap}>
                  <Text style={settingsStyles.marginPrefix}>₦</Text>
                  <TextInput
                    style={settingsStyles.marginInput}
                    value={marginValue}
                    onChangeText={(t) => { setMarginValue(t.replace(/[^0-9.]/g, '')); setMarginDirty(true); }}
                    keyboardType="numeric"
                    placeholder="1500"
                    placeholderTextColor={MUTED}
                  />
                </View>
                <TouchableOpacity
                  style={[settingsStyles.saveBtn, { marginTop: 0, paddingHorizontal: 20 }, (!marginDirty || marginSaving) && settingsStyles.saveBtnDisabled]}
                  onPress={saveMargin}
                  disabled={!marginDirty || marginSaving}
                  activeOpacity={0.85}
                >
                  {marginSaving ? <ActivityIndicator color="#061006" /> : (
                    <Text style={settingsStyles.saveBtnText}>{marginDirty ? 'Save' : 'Saved'}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>

            <View style={settingsStyles.card}>
              <View style={settingsStyles.rowBetween}>
                <Text style={settingsStyles.cardTitle}>Job ad text (acquisition-program screen)</Text>
                <TouchableOpacity onPress={resetJobAdContent} activeOpacity={0.7}>
                  <Text style={settingsStyles.resetLink}>Reset to default</Text>
                </TouchableOpacity>
              </View>
              <Text style={settingsStyles.cardSub}>
                Edits here go live the next time someone opens that screen — no app update needed.
              </Text>

              {jobAdLoading || !jobAdSteps ? (
                <ActivityIndicator color={GREEN} style={{ marginTop: 16 }} />
              ) : (
                <>
                  {jobAdSteps.map((step, i) => (
                    <View key={i} style={settingsStyles.stepBlock}>
                      <Text style={settingsStyles.stepLabel}>Step {i + 1}</Text>
                      <Text style={settingsStyles.fieldLabel}>Title</Text>
                      <TextInput
                        style={settingsStyles.input}
                        value={step.title}
                        onChangeText={(t) => updateJobAdField(i, 'title', t)}
                        multiline
                      />
                      {step.sections ? (
                        step.sections.map((sec, j) => (
                          <View key={j}>
                            <Text style={settingsStyles.fieldLabel}>{sec.heading}</Text>
                            <TextInput
                              style={[settingsStyles.input, settingsStyles.inputMultiline]}
                              value={sec.text}
                              onChangeText={(t) => updateJobAdSectionText(i, j, t)}
                              multiline
                            />
                          </View>
                        ))
                      ) : (
                        <>
                          <Text style={settingsStyles.fieldLabel}>Body</Text>
                          <TextInput
                            style={[settingsStyles.input, settingsStyles.inputMultiline]}
                            value={step.body}
                            onChangeText={(t) => updateJobAdField(i, 'body', t)}
                            multiline
                          />
                        </>
                      )}
                    </View>
                  ))}

                  <TouchableOpacity
                    style={[settingsStyles.saveBtn, (!jobAdDirty || jobAdSaving) && settingsStyles.saveBtnDisabled]}
                    onPress={saveJobAdContent}
                    disabled={!jobAdDirty || jobAdSaving}
                    activeOpacity={0.85}
                  >
                    {jobAdSaving ? <ActivityIndicator color="#061006" /> : (
                      <Text style={settingsStyles.saveBtnText}>{jobAdDirty ? 'Save changes' : 'Saved'}</Text>
                    )}
                  </TouchableOpacity>
                </>
              )}
            </View>
          </>
        )}
      </ScrollView>

      {/* ── Detail Modal ── */}
      <Modal visible={!!detailP} animationType="slide" onRequestClose={() => setDetailP(null)}>
        {detailP ? (
          <View style={[styles.container, { paddingTop: insets.top }]}>
            <View style={styles.modalHeader}>
              <TouchableOpacity style={styles.backBtn} onPress={() => setDetailP(null)} activeOpacity={0.7}>
                <MaterialIcons name="close" size={20} color={GREEN} />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={styles.headerTitle} numberOfLines={1}>{detailP.name}</Text>
                <StatusPill status={detailP.status} />
              </View>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}>

              <View style={styles.detailCard}>
                {[
                  { label: 'Referral Code', value: detailP.referral_code, mono: true },
                  { label: 'Validated Customers', value: String(detailP.validated_count), color: GREEN },
                  { label: 'Total Paid Out', value: detailP.total_paid > 0 ? `₦${detailP.total_paid.toLocaleString()}` : '₦0', color: detailP.total_paid > 0 ? GREEN : TEXT2 },
                  { label: 'Bank', value: detailP.bank_name || '—' },
                  { label: 'Account', value: maskAccount(detailP.bank_account_number), mono: true },
                  ...(detailP.paid_period_start_date ? [{ label: 'Period Started', value: new Date(detailP.paid_period_start_date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) }] : []),
                  ...(detailP.paid_periods_completed > 0 ? [{ label: 'Blocks Completed', value: `${detailP.paid_periods_completed} / 6`, color: GREEN }] : []),
                ].map((row, i, arr) => (
                  <React.Fragment key={row.label}>
                    <View style={styles.detailCardRow}>
                      <Text style={styles.detailLabel}>{row.label}</Text>
                      <Text style={[styles.detailValue, row.mono ? styles.mono : null, row.color ? { color: row.color } : null]}>{row.value}</Text>
                    </View>
                    {i < arr.length - 1 ? <View style={styles.detailCardDivider} /> : null}
                  </React.Fragment>
                ))}
              </View>

              {detailLoading ? <ActivityIndicator color={GREEN} style={{ marginVertical: 24 }} /> : (
                <>
                  <View style={styles.sectionLabel}>
                    <Text style={styles.sectionLabelText}>REFERRED CUSTOMERS ({detailRefs.length})</Text>
                  </View>
                  {detailRefs.length === 0 ? (
                    <Text style={styles.emptyDetailText}>No referred customers yet.</Text>
                  ) : (
                    detailRefs.map((r) => (
                      <View key={r.id} style={styles.refCustomerRow}>
                        <View style={[styles.refCustomerIcon, { backgroundColor: r.validated ? 'rgba(74,222,128,0.15)' : SURFACE2 }]}>
                          <MaterialIcons name={r.validated ? 'check' : 'schedule'} size={13}
                            color={r.validated ? GREEN : MUTED} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.refCustomerId} numberOfLines={1}>
                            {(r as any).email_normalized ?? r.customer_id}
                          </Text>
                          <Text style={styles.refCustomerMeta}>
                            {r.validated_at
                              ? `Block ${r.block_number ?? '—'} · Validated ${new Date(r.validated_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}`
                              : 'Not validated'}
                          </Text>
                          {(r as any).validation_note ? (
                            <Text style={{ fontSize: 10, color: RED }}>{(r as any).validation_note}</Text>
                          ) : null}
                        </View>
                        <Text style={[styles.refCustomerStatus, { color: r.validated ? GREEN : MUTED }]}>
                          {r.validated ? (r.block_number === 0 ? 'Qual' : `Blk ${r.block_number}`) : 'Pending'}
                        </Text>
                      </View>
                    ))
                  )}

                  {detailPayouts.length > 0 ? (
                    <>
                      <View style={styles.sectionLabel}>
                        <Text style={styles.sectionLabelText}>PAYOUT HISTORY</Text>
                      </View>
                      {detailPayouts.map((pay) => {
                        const sm = payoutStatusMeta(pay.status);
                        return (
                          <View key={pay.id} style={[styles.sentPayoutRow, { borderColor: sm.color + '44' }]}>
                            <View style={[styles.payoutIconWrap, { backgroundColor: sm.bg }]}>
                              <MaterialIcons name="payments" size={14} color={sm.color} />
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.sentPayoutName}>Block {(pay as any).block_number ?? '?'} · Half {pay.cycle_number}</Text>
                              <Text style={styles.sentPayoutMeta}>{sm.label} · {pay.customers_in_cycle} customers</Text>
                            </View>
                            <Text style={[styles.reviewPayoutAmount, { color: sm.color }]}>
                              ₦{Number(pay.amount).toLocaleString()}
                            </Text>
                          </View>
                        );
                      })}
                    </>
                  ) : null}
                </>
              )}
            </ScrollView>
          </View>
        ) : null}
      </Modal>

      {/* ── Reject / Hold note modal ── */}
      <Modal visible={showRejectModal} transparent animationType="slide"
        onRequestClose={() => setShowRejectModal(false)}>
        <View style={styles.rejectOverlay}>
          <View style={styles.rejectSheet}>
            <Text style={styles.rejectSheetTitle}>Hold payout</Text>
            <Text style={styles.rejectSheetSub}>Enter a note for the participant (optional)</Text>
            <TextInput
              style={styles.rejectNoteInput}
              value={rejectNoteInput}
              onChangeText={setRejectNoteInput}
              placeholder="Reason for hold..."
              placeholderTextColor={MUTED2}
              multiline
              numberOfLines={3}
            />
            <View style={styles.rejectSheetActions}>
              <TouchableOpacity style={styles.rejectCancelBtn} onPress={() => setShowRejectModal(false)} activeOpacity={0.8}>
                <Text style={styles.rejectCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.rejectConfirmBtn} onPress={confirmReject} activeOpacity={0.8}>
                <Text style={styles.rejectConfirmText}>Hold Payout</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FinCard({ label, value, icon, accent, sub }: { label: string; value: string; icon: keyof typeof MaterialIcons.glyphMap; accent: string; sub: string }) {
  return (
    <View style={[finStyles.card, { borderColor: accent + '33' }]}>
      <View style={[finStyles.iconWrap, { backgroundColor: accent + '18' }]}>
        <MaterialIcons name={icon} size={18} color={accent} />
      </View>
      <Text style={finStyles.value}>{value}</Text>
      <Text style={finStyles.label}>{label}</Text>
      <Text style={finStyles.sub}>{sub}</Text>
    </View>
  );
}
const finStyles = StyleSheet.create({
  card: { flex: 1, backgroundColor: SURFACE, borderWidth: 1, borderRadius: 14, padding: 14, gap: 5 },
  iconWrap: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  value: { fontSize: 22, fontWeight: '700', color: TEXT },
  label: { fontSize: 12, fontWeight: '600', color: TEXT2 },
  sub: { fontSize: 10, color: MUTED, lineHeight: 15 },
});

function StatTile({ icon, label, value, accent }: { icon: keyof typeof MaterialIcons.glyphMap; label: string; value: string; accent?: string }) {
  return (
    <View style={statStyles.tile}>
      <MaterialIcons name={icon} size={18} color={accent || MUTED} />
      <Text style={[statStyles.value, accent ? { color: accent } : null]}>{value}</Text>
      <Text style={statStyles.label}>{label}</Text>
    </View>
  );
}
const statStyles = StyleSheet.create({
  tile: { width: '31%', backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, borderRadius: 12, padding: 12, alignItems: 'flex-start', gap: 4 },
  value: { fontSize: 24, fontWeight: '700', color: TEXT },
  label: { fontSize: 10, color: MUTED, lineHeight: 14 },
});

function StatusPill({ status }: { status: string }) {
  const { label, color, bg } = statusMeta(status);
  return (
    <View style={[pillStyles.pill, { backgroundColor: bg, borderColor: color + '55' }]}>
      <Text style={[pillStyles.text, { color }]}>{label}</Text>
    </View>
  );
}
const pillStyles = StyleSheet.create({
  pill: { borderWidth: 1, borderRadius: 100, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },
  text: { fontSize: 10, fontWeight: '700' },
});

function PayoutSummaryItem({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={psStyles.wrap}>
      <Text style={[psStyles.value, { color }]}>{value}</Text>
      <Text style={psStyles.label}>{label}</Text>
    </View>
  );
}
const psStyles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', paddingVertical: 14, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, borderRadius: 12 },
  value: { fontSize: 22, fontWeight: '700' },
  label: { fontSize: 10, color: MUTED, marginTop: 2 },
});

function EmptyState({ icon, title, sub }: { icon: keyof typeof MaterialIcons.glyphMap; title: string; sub: string }) {
  return (
    <View style={emStyles.wrap}>
      <View style={emStyles.iconWrap}><MaterialIcons name={icon} size={28} color={MUTED} /></View>
      <Text style={emStyles.title}>{title}</Text>
      <Text style={emStyles.sub}>{sub}</Text>
    </View>
  );
}
const emStyles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingVertical: 56, gap: 10 },
  iconWrap: { width: 64, height: 64, borderRadius: 32, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '700', color: TEXT },
  sub: { fontSize: 12, color: MUTED, textAlign: 'center', maxWidth: 240, lineHeight: 20 },
});

const settingsStyles = StyleSheet.create({
  card: {
    backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: BORDER,
    padding: 16, marginBottom: 12, gap: 8,
  },
  rowBetween: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  cardTitle: { fontSize: 14, fontWeight: '700', color: TEXT },
  cardSub: { fontSize: 12, color: TEXT2, lineHeight: 18 },
  hint: { fontSize: 11, color: MUTED, lineHeight: 16, marginTop: 4 },
  resetLink: { fontSize: 12, color: ORANGE, fontWeight: '600' },
  marginInputWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: SURFACE2, borderWidth: 1, borderColor: BORDER2, borderRadius: 10,
    paddingHorizontal: 12,
  },
  marginPrefix: { color: GREEN, fontSize: 16, fontWeight: '700', marginRight: 4 },
  marginInput: { flex: 1, color: TEXT, fontSize: 16, fontWeight: '700', paddingVertical: 10 },
  stepBlock: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: BORDER, gap: 6 },
  stepLabel: { fontSize: 11, fontWeight: '700', color: GREEN, letterSpacing: 0.5, textTransform: 'uppercase' },
  fieldLabel: { fontSize: 11, color: MUTED, marginTop: 6 },
  input: {
    backgroundColor: SURFACE2, borderWidth: 1, borderColor: BORDER2, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, color: TEXT, fontSize: 13,
  },
  inputMultiline: { minHeight: 70, textAlignVertical: 'top' },
  saveBtn: {
    backgroundColor: GREEN, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 16,
  },
  saveBtnDisabled: { backgroundColor: MUTED2, opacity: 0.6 },
  saveBtnText: { color: '#061006', fontWeight: '700', fontSize: 14 },
});

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16 },
  accessDeniedIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: RED_BG, borderWidth: 1, borderColor: RED + '55', alignItems: 'center', justifyContent: 'center' },
  accessDeniedTitle: { fontSize: 20, fontWeight: '700', color: TEXT },
  accessDeniedSub: { fontSize: 13, color: TEXT2, textAlign: 'center' },
  accessDeniedBtn: { backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, borderRadius: 100, paddingHorizontal: 24, paddingVertical: 12 },
  accessDeniedBtnText: { color: TEXT2, fontSize: 14, fontWeight: '600' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 12 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 12, borderBottomWidth: 1, borderBottomColor: BORDER },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#111a11', borderWidth: 1, borderColor: BORDER2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  refreshBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#111a11', borderWidth: 1, borderColor: BORDER, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: TEXT },
  headerSub: { fontSize: 11, color: MUTED, marginTop: 1 },
  tabBarWrap: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 12, backgroundColor: '#111a11', borderWidth: 1, borderColor: BORDER2, borderRadius: 14, padding: 4, gap: 2 },
  tabItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 9, borderRadius: 10 },
  tabItemActive: { backgroundColor: '#1a3a1a' },
  tabItemText: { fontSize: 11, fontWeight: '500', color: MUTED },
  tabItemTextActive: { color: GREEN, fontWeight: '700' },
  tabBadge: { backgroundColor: BORDER, borderRadius: 100, minWidth: 16, paddingHorizontal: 4, height: 16, alignItems: 'center', justifyContent: 'center' },
  tabBadgeActive: { backgroundColor: 'rgba(74,222,128,0.2)' },
  tabBadgeText: { fontSize: 9, fontWeight: '700', color: MUTED },
  tabBadgeTextActive: { color: GREEN },
  content: { paddingHorizontal: 16, gap: 10 },
  alertBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: GOLD_BG, borderWidth: 1, borderColor: GOLD + '55', borderRadius: 12, padding: 13 },
  alertBannerRed: { backgroundColor: RED_BG, borderColor: RED + '55' },
  alertBannerDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: GOLD, flexShrink: 0 },
  alertBannerText: { flex: 1, fontSize: 12, fontWeight: '500', color: GOLD },
  sectionLabel: { marginTop: 4 },
  sectionLabelText: { fontSize: 10, fontWeight: '700', color: MUTED2, letterSpacing: 1.2 },
  finRow: { flexDirection: 'row', gap: 10 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filterRow: { gap: 8, paddingRight: 16, paddingBottom: 2 },
  filterChip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, borderRadius: 100, paddingHorizontal: 14, paddingVertical: 8 },
  filterChipActive: { borderColor: GREEN, backgroundColor: 'rgba(74,222,128,0.1)' },
  filterChipText: { fontSize: 12, fontWeight: '500', color: TEXT2 },
  filterChipTextActive: { color: GREEN, fontWeight: '700' },
  filterChipCount: { fontSize: 11, fontWeight: '700', color: MUTED },
  participantCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, borderRadius: 14, padding: 14 },
  participantAvatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(74,222,128,0.12)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.25)', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  participantAvatarText: { color: GREEN, fontSize: 16, fontWeight: '700' },
  participantName: { fontSize: 14, fontWeight: '600', color: TEXT },
  participantCode: { fontSize: 11, color: MUTED, letterSpacing: 0.5 },
  participantMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  participantMeta: { fontSize: 11, color: TEXT2 },
  payoutSummaryRow: { flexDirection: 'row', gap: 8 },

  // Review payout card
  reviewPayoutCard: {
    backgroundColor: SURFACE, borderWidth: 1,
    borderRadius: 16, padding: 16, gap: 12,
  },
  reviewPayoutHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  payoutIconWrap: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  reviewPayoutName: { fontSize: 14, fontWeight: '700', color: TEXT },
  reviewPayoutMeta: { fontSize: 11, color: TEXT2, marginTop: 2 },
  reviewPayoutAmount: { fontSize: 16, fontWeight: '700' },
  statusChip: { borderWidth: 1, borderRadius: 100, paddingHorizontal: 7, paddingVertical: 2 },
  statusChipText: { fontSize: 10, fontWeight: '700' },

  failureBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, backgroundColor: RED_BG, borderWidth: 1, borderColor: RED + '44', borderRadius: 8, padding: 10 },
  failureText: { flex: 1, fontSize: 11, color: RED, lineHeight: 16 },
  holdBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, backgroundColor: ORANGE_BG, borderWidth: 1, borderColor: ORANGE + '44', borderRadius: 8, padding: 10 },
  holdText: { flex: 1, fontSize: 11, color: ORANGE, lineHeight: 16 },

  customerListWrap: { backgroundColor: SURFACE2, borderWidth: 1, borderColor: BORDER, borderRadius: 10, overflow: 'hidden' },
  customerListTitle: { fontSize: 10, fontWeight: '700', color: MUTED2, letterSpacing: 1, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  customerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: BORDER },
  customerIcon: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(74,222,128,0.12)', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 },
  customerEmail: { fontSize: 12, color: TEXT, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  customerName: { fontSize: 11, color: TEXT2, marginTop: 1 },
  customerTime: { fontSize: 10, color: MUTED, marginTop: 1 },
  customerNote: { fontSize: 10, fontWeight: '700', marginTop: 2 },
  orderIdChip: { fontSize: 9, color: MUTED, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', flexShrink: 0, maxWidth: 70 },
  noCustomersText: { fontSize: 11, color: MUTED, textAlign: 'center', paddingVertical: 12 },

  payoutActions: { flexDirection: 'row', gap: 10 },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 44, borderRadius: 10 },
  approveBtn: { backgroundColor: GREEN },
  approveBtnText: { color: BG, fontWeight: '700', fontSize: 13 },
  rejectBtn: { borderWidth: 1, borderColor: ORANGE + '55', backgroundColor: ORANGE_BG },
  rejectBtnText: { color: ORANGE, fontWeight: '700', fontSize: 13 },
  retryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: GOLD + '55', backgroundColor: GOLD_BG, borderRadius: 10, height: 40 },
  retryBtnText: { color: GOLD, fontWeight: '700', fontSize: 12 },

  sentPayoutRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, borderRadius: 12, padding: 12 },
  sentPayoutName: { fontSize: 13, fontWeight: '600', color: TEXT },
  sentPayoutMeta: { fontSize: 11, color: TEXT2, marginTop: 1 },
  sentPayoutDate: { fontSize: 10, color: MUTED, marginTop: 1 },

  // Reject modal
  rejectOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  rejectSheet: { backgroundColor: SURFACE, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: BORDER, padding: 24, gap: 16 },
  rejectSheetTitle: { fontSize: 18, fontWeight: '700', color: TEXT },
  rejectSheetSub: { fontSize: 13, color: TEXT2 },
  rejectNoteInput: { backgroundColor: BG, borderWidth: 1, borderColor: BORDER, borderRadius: 12, padding: 14, color: TEXT, fontSize: 14, minHeight: 80, textAlignVertical: 'top' },
  rejectSheetActions: { flexDirection: 'row', gap: 10 },
  rejectCancelBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: BORDER, borderRadius: 10, height: 46 },
  rejectCancelText: { color: TEXT2, fontWeight: '600', fontSize: 14 },
  rejectConfirmBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: ORANGE_BG, borderWidth: 1, borderColor: ORANGE + '55', borderRadius: 10, height: 46 },
  rejectConfirmText: { color: ORANGE, fontWeight: '700', fontSize: 14 },

  // Detail modal
  detailCard: { backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, borderRadius: 14, overflow: 'hidden' },
  detailCardRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 13 },
  detailCardDivider: { height: 1, backgroundColor: BORDER },
  detailLabel: { fontSize: 13, color: TEXT2 },
  detailValue: { fontSize: 13, fontWeight: '600', color: TEXT, textAlign: 'right', flex: 1 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12 },
  emptyDetailText: { fontSize: 12, color: MUTED, textAlign: 'center', padding: 20 },
  refCustomerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, borderRadius: 10, padding: 12 },
  refCustomerIcon: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  refCustomerId: { fontSize: 11, color: TEXT2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  refCustomerMeta: { fontSize: 10, color: MUTED, marginTop: 2 },
  refCustomerStatus: { fontSize: 11, fontWeight: '700', flexShrink: 0 },
});
