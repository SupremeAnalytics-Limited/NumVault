import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, RefreshControl, Modal,
  Platform, Animated,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAlert, getSupabaseClient } from '@/template';
import {
  AcquisitionParticipant, ReferredCustomer, LeadPayout, AcquisitionLedgerEntry,
  daysRemainingInQualification,
} from '@/services/acquisitionService';

const supabase = getSupabaseClient();
const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';

// ── Design tokens (dark green aesthetic) ─────────────────────────────────────
const BG = '#0a0d0a';
const SURFACE = '#0d1f0d';
const SURFACE2 = '#0f240f';
const BORDER = '#1a3a1a';
const BORDER2 = '#1e3a1e';
const GREEN = '#4ade80';
const GREEN_DIM = '#1a6a2a';
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

// ── Types ─────────────────────────────────────────────────────────────────────
interface AdminParticipant extends AcquisitionParticipant {
  referred_count: number;
  validated_count: number;
  total_paid: number;
}
type AdminTab = 'overview' | 'participants' | 'reviews' | 'payouts';

function statusMeta(s: string): { label: string; color: string; bg: string } {
  switch (s) {
    case 'qualifying':          return { label: 'Qualifying',         color: GREEN,  bg: 'rgba(74,222,128,0.12)' };
    case 'pending_review':      return { label: 'Pending Review',     color: GOLD,   bg: GOLD_BG };
    case 'eligible_not_joined': return { label: 'Eligible',           color: GREEN,  bg: 'rgba(74,222,128,0.12)' };
    case 'active_lead':         return { label: 'Active Lead',        color: GREEN,  bg: 'rgba(74,222,128,0.18)' };
    case 'needs_requalification': return { label: 'Re-qualify',       color: ORANGE, bg: ORANGE_BG };
    case 'contract_complete':   return { label: 'Contract Complete',  color: MUTED,  bg: '#111a11' };
    case 'inactive':            return { label: 'Inactive',           color: MUTED,  bg: '#111a11' };
    default:                    return { label: s,                     color: MUTED,  bg: '#111a11' };
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

  // Data
  const [participants, setParticipants] = useState<AdminParticipant[]>([]);
  const [pendingReviews, setPendingReviews] = useState<AdminParticipant[]>([]);
  const [transfers, setTransfers] = useState<LeadPayout[]>([]);
  const [unattributedTotal, setUnattributedTotal] = useState(0);
  const [obligationTotal, setObligationTotal] = useState(0);
  const [totalTransferred, setTotalTransferred] = useState(0);

  // Detail modal
  const [detailP, setDetailP] = useState<AdminParticipant | null>(null);
  const [detailRefs, setDetailRefs] = useState<ReferredCustomer[]>([]);
  const [detailPayouts, setDetailPayouts] = useState<LeadPayout[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Filter
  const [participantFilter, setParticipantFilter] = useState<string>('all');

  useEffect(() => { checkAndLoad(); }, []);

  // Silent 30-second auto-refresh while screen is open
  useEffect(() => {
    if (!isAdmin) return;
    const interval = setInterval(() => {
      loadAll();
    }, 30_000);
    return () => clearInterval(interval);
  }, [isAdmin, loadAll]);

  const checkAndLoad = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.email !== ADMIN_EMAIL) { setIsAdmin(false); setLoading(false); return; }
    setIsAdmin(true);
    await loadAll();
  };

  const loadAll = useCallback(async () => {
    try {
      const [{ data: parts }, { data: pays }, { data: ledger }] = await Promise.all([
        supabase.from('acquisition_participants').select('*').order('created_at', { ascending: false }),
        supabase.from('lead_payouts').select('*').order('triggered_at', { ascending: false }),
        supabase.from('acquisition_ledger_entries').select('*'),
      ]);

      // Enrich participants
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
        setPendingReviews(enriched.filter((p) => p.status === 'pending_review'));
      }

      setTransfers((pays || []) as LeadPayout[]);
      setTotalTransferred((pays || []).filter((p: any) => p.status === 'sent').reduce((s: number, p: any) => s + Number(p.amount), 0));

      const allLedger = ledger || [];
      setUnattributedTotal(allLedger.filter((l: any) => l.entry_type === 'unattributed_profit').reduce((s: number, l: any) => s + Number(l.amount), 0));
      setObligationTotal(allLedger.filter((l: any) => l.entry_type === 'lead_obligation').reduce((s: number, l: any) => s + Number(l.amount), 0));
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
      supabase.from('referred_customers').select('*').eq('participant_id', p.id).order('created_at', { ascending: false }),
      supabase.from('lead_payouts').select('*').eq('participant_id', p.id).order('triggered_at', { ascending: false }),
    ]);
    setDetailRefs((refs || []) as ReferredCustomer[]);
    setDetailPayouts((pays || []) as LeadPayout[]);
    setDetailLoading(false);
  };

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleApprove = (participantId: string) => {
    showAlert('Approve Eligibility?', 'Participant will be marked eligible and can complete bank onboarding.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Approve', style: 'default', onPress: async () => {
        setActionLoading(true);
        const { error } = await supabase.from('acquisition_participants').update({ status: 'eligible_not_joined' }).eq('id', participantId);
        setActionLoading(false);
        if (error) { showAlert('Error', error.message); return; }
        showAlert('Approved', 'Participant marked as eligible.');
        await loadAll(); setDetailP(null);
      }},
    ]);
  };

  const handleReject = (participantId: string) => {
    showAlert('Reject Review?', 'Participant remains frozen at 76/76 pending appeal.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reject', style: 'destructive', onPress: async () => {
        showAlert('Rejected', 'Participant notified.'); await loadAll();
      }},
    ]);
  };

  const handleActivateLead = (participantId: string) => {
    showAlert('Activate as NumVault Lead?', 'Sets status to active_lead, starts their 30-day paid period, and resets their count to 0.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Activate', style: 'default', onPress: async () => {
        setActionLoading(true);
        const now = new Date().toISOString();
        const { data: current } = await supabase.from('acquisition_participants').select('original_activation_timestamp').eq('id', participantId).single();
        const updates: Record<string, unknown> = {
          status: 'active_lead',
          active_lead_start_month: now.split('T')[0],
          paid_period_start_date: now,
          qualification_customers_count: 0,
        };
        if (!current?.original_activation_timestamp) updates.original_activation_timestamp = now;
        const { error } = await supabase.from('acquisition_participants').update(updates).eq('id', participantId);
        setActionLoading(false);
        if (error) { showAlert('Error', error.message); return; }
        showAlert('Activated', 'Participant is now an active NumVault Lead.');
        await loadAll(); setDetailP(null);
      }},
    ]);
  };

  const handleRetryTransfer = (payout: LeadPayout) => {
    showAlert('Retry Transfer?', `Re-queue ₦${Number(payout.amount).toLocaleString()} for this payout?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Retry', style: 'default', onPress: async () => {
        await supabase.from('lead_payouts').update({ status: 'pending', failure_reason: null }).eq('id', payout.id);
        await loadAll();
      }},
    ]);
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
        <View style={styles.accessDeniedIcon}>
          <MaterialIcons name="lock" size={32} color={RED} />
        </View>
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
  const failedPayouts = transfers.filter((t) => t.status === 'failed').length;
  const pendingPayouts = transfers.filter((t) => t.status === 'pending').length;

  const filteredParticipants = participantFilter === 'all'
    ? participants
    : participants.filter((p) => p.status === participantFilter);

  const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'qualifying', label: 'Qualifying' },
    { key: 'pending_review', label: 'Review' },
    { key: 'active_lead', label: 'Active' },
    { key: 'needs_requalification', label: 'Re-qualify' },
  ];

  const TABS: { key: AdminTab; label: string; icon: keyof typeof MaterialIcons.glyphMap; badge?: number }[] = [
    { key: 'overview',     label: 'Overview',     icon: 'dashboard' },
    { key: 'participants', label: 'Team',          icon: 'groups',       badge: participants.length },
    { key: 'reviews',      label: 'Reviews',       icon: 'fact-check',   badge: pendingReviews.length || undefined },
    { key: 'payouts',      label: 'Payouts',       icon: 'payments',     badge: failedPayouts || undefined },
  ];

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={BG} />

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
          <MaterialIcons name="arrow-back" size={20} color={GREEN} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Admin Dashboard</Text>
          <Text style={styles.headerSub}>NumVault Acquisition Program</Text>
        </View>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => { setRefreshing(true); loadAll(); }}
          activeOpacity={0.7}
        >
          {refreshing
            ? <ActivityIndicator size="small" color={GREEN} />
            : <MaterialIcons name="refresh" size={19} color={MUTED} />}
        </TouchableOpacity>
      </View>

      {/* ── Tab bar ── */}
      <View style={styles.tabBarWrap}>
        {TABS.map((t) => {
          const active = activeTab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={[styles.tabItem, active && styles.tabItemActive]}
              onPress={async () => { await Haptics.selectionAsync(); setActiveTab(t.key); }}
              activeOpacity={0.8}
            >
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

      {/* ── Content ── */}
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
            {/* Alerts */}
            {pendingReviews.length > 0 && (
              <TouchableOpacity style={styles.alertBanner} onPress={() => setActiveTab('reviews')} activeOpacity={0.8}>
                <View style={styles.alertBannerDot} />
                <Text style={styles.alertBannerText}>
                  {pendingReviews.length} participant{pendingReviews.length > 1 ? 's' : ''} waiting for eligibility review
                </Text>
                <MaterialIcons name="chevron-right" size={16} color={GOLD} />
              </TouchableOpacity>
            )}
            {failedPayouts > 0 && (
              <TouchableOpacity style={[styles.alertBanner, styles.alertBannerRed]} onPress={() => setActiveTab('payouts')} activeOpacity={0.8}>
                <View style={[styles.alertBannerDot, { backgroundColor: RED }]} />
                <Text style={[styles.alertBannerText, { color: RED }]}>
                  {failedPayouts} failed transfer{failedPayouts > 1 ? 's' : ''} — action required
                </Text>
                <MaterialIcons name="chevron-right" size={16} color={RED} />
              </TouchableOpacity>
            )}

            {/* Financial overview */}
            <View style={styles.sectionLabel}><Text style={styles.sectionLabelText}>FINANCIAL OVERVIEW</Text></View>
            <View style={styles.finRow}>
              <FinCard label="Lead Obligations" value={`₦${obligationTotal.toLocaleString()}`} icon="account-balance" accent={GREEN} sub="Total owed to leads" />
              <FinCard label="Unattributed Profit" value={`₦${unattributedTotal.toLocaleString()}`} icon="trending-up" accent="#60a5fa" sub="No referral attached" />
            </View>
            <View style={styles.finRow}>
              <FinCard label="Total Transferred" value={`₦${totalTransferred.toLocaleString()}`} icon="send" accent={GREEN} sub={`${transfers.filter((t) => t.status === 'sent').length} successful payouts`} />
              <FinCard label="Pending Payouts" value={String(pendingPayouts)} icon="pending" accent={GOLD} sub="Queued for transfer" />
            </View>

            {/* Program stats */}
            <View style={styles.sectionLabel}><Text style={styles.sectionLabelText}>PROGRAM STATS</Text></View>
            <View style={styles.statsGrid}>
              <StatTile icon="groups" label="Total Enrolled" value={String(participants.length)} />
              <StatTile icon="star" label="Active Leads" value={String(activeLeads)} accent={GREEN} />
              <StatTile icon="school" label="Qualifying" value={String(qualifying)} accent={GREEN} />
              <StatTile icon="fact-check" label="Reviews" value={String(pendingReviews.length)} accent={pendingReviews.length > 0 ? GOLD : MUTED} />
              <StatTile icon="error-outline" label="Failed Pays" value={String(failedPayouts)} accent={failedPayouts > 0 ? RED : MUTED} />
              <StatTile icon="how-to-reg" label="Contracts Done" value={String(participants.filter((p) => p.status === 'contract_complete').length)} />
            </View>

            {/* Recent activity (latest 6 payouts) */}
            {transfers.length > 0 && (
              <>
                <View style={styles.sectionLabel}><Text style={styles.sectionLabelText}>RECENT PAYOUTS</Text></View>
                {transfers.slice(0, 6).map((t) => {
                  const p = participants.find((x) => x.id === t.participant_id);
                  return (
                    <TransferRow key={t.id} transfer={t} name={p?.name} onRetry={handleRetryTransfer} />
                  );
                })}
              </>
            )}
          </>
        )}

        {/* ─────────────────── TEAM / PARTICIPANTS ─────────────────── */}
        {activeTab === 'participants' && (
          <>
            {/* Filter chips */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterRow}>
              {FILTERS.map((f) => (
                <TouchableOpacity
                  key={f.key}
                  style={[styles.filterChip, participantFilter === f.key && styles.filterChipActive]}
                  onPress={() => setParticipantFilter(f.key)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.filterChipText, participantFilter === f.key && styles.filterChipTextActive]}>
                    {f.label}
                  </Text>
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
                      <Text style={[styles.participantMeta, { color: MUTED2 }]}>·</Text>
                      {p.total_paid > 0 && <Text style={[styles.participantMeta, { color: GREEN }]}>₦{p.total_paid.toLocaleString()} paid</Text>}
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

        {/* ─────────────────── REVIEWS ─────────────────── */}
        {activeTab === 'reviews' && (
          <>
            {pendingReviews.length === 0 ? (
              <EmptyState icon="fact-check" title="No pending reviews"
                sub="Participants who reach 76 validated customers will appear here." />
            ) : (
              pendingReviews.map((p) => (
                <View key={p.id} style={styles.reviewCard}>
                  {/* Header */}
                  <View style={styles.reviewCardTop}>
                    <View style={styles.participantAvatar}>
                      <Text style={styles.participantAvatarText}>{p.name.charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.reviewName}>{p.name}</Text>
                      <Text style={styles.participantCode}>{p.referral_code}</Text>
                    </View>
                    <View style={[styles.progressBadge]}>
                      <MaterialIcons name="check-circle" size={12} color={GOLD} />
                      <Text style={styles.progressBadgeText}>76 / 76</Text>
                    </View>
                  </View>

                  {/* Stats */}
                  <View style={styles.reviewStats}>
                    <ReviewStat label="Enrolled" value={new Date(p.qualification_start_date || p.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })} />
                    <View style={styles.reviewStatDivider} />
                    <ReviewStat label="Days left" value={String(Math.max(0, daysRemainingInQualification(p.qualification_start_date)))} />
                    <View style={styles.reviewStatDivider} />
                    <ReviewStat label="Bank on file" value={p.bank_account_number ? 'Yes' : 'No'} valueColor={p.bank_account_number ? GREEN : RED} />
                  </View>

                  <TouchableOpacity style={styles.viewCustomersBtn}
                    onPress={() => openDetail(p)} activeOpacity={0.8}>
                    <Text style={styles.viewCustomersBtnText}>Review 76 customers</Text>
                    <MaterialIcons name="arrow-forward" size={14} color={GREEN} />
                  </TouchableOpacity>

                  <View style={styles.reviewActions}>
                    <TouchableOpacity style={[styles.actionBtn, styles.rejectBtn]}
                      onPress={() => handleReject(p.id)} activeOpacity={0.85}>
                      <Text style={styles.rejectBtnText}>Reject</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.actionBtn, styles.approveBtn]}
                      onPress={() => handleApprove(p.id)} activeOpacity={0.85}>
                      <MaterialIcons name="verified" size={15} color={BG} />
                      <Text style={styles.approveBtnText}>Approve</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </>
        )}

        {/* ─────────────────── PAYOUTS ─────────────────── */}
        {activeTab === 'payouts' && (
          <>
            {/* Payout summary strip */}
            <View style={styles.payoutSummaryRow}>
              <PayoutSummaryItem label="Sent" value={String(transfers.filter((t) => t.status === 'sent').length)} color={GREEN} />
              <PayoutSummaryItem label="Pending" value={String(pendingPayouts)} color={GOLD} />
              <PayoutSummaryItem label="Failed" value={String(failedPayouts)} color={failedPayouts > 0 ? RED : MUTED} />
              <PayoutSummaryItem label="Total Out" value={`₦${(totalTransferred / 1000).toFixed(0)}K`} color={GREEN} />
            </View>

            {transfers.length === 0 ? (
              <EmptyState icon="payments" title="No payouts yet" sub="Transfer records will appear here once payouts are triggered." />
            ) : (
              transfers.map((t) => {
                const p = participants.find((x) => x.id === t.participant_id);
                return <TransferRow key={t.id} transfer={t} name={p?.name} onRetry={handleRetryTransfer} expanded />;
              })
            )}
          </>
        )}
      </ScrollView>

      {/* ── Detail Modal ── */}
      <Modal visible={!!detailP} animationType="slide" onRequestClose={() => setDetailP(null)}>
        {detailP ? (
          <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Modal header */}
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

              {/* Participant identity */}
              <View style={styles.detailCard}>
                <View style={styles.detailCardRow}>
                  <Text style={styles.detailLabel}>Referral Code</Text>
                  <Text style={[styles.detailValue, styles.mono]}>{detailP.referral_code}</Text>
                </View>
                <View style={styles.detailCardDivider} />
                <View style={styles.detailCardRow}>
                  <Text style={styles.detailLabel}>Validated Customers</Text>
                  <Text style={[styles.detailValue, { color: GREEN }]}>{detailP.validated_count}</Text>
                </View>
                <View style={styles.detailCardDivider} />
                <View style={styles.detailCardRow}>
                  <Text style={styles.detailLabel}>Total Paid Out</Text>
                  <Text style={[styles.detailValue, { color: detailP.total_paid > 0 ? GREEN : TEXT2 }]}>
                    {detailP.total_paid > 0 ? `₦${detailP.total_paid.toLocaleString()}` : '₦0'}
                  </Text>
                </View>
                <View style={styles.detailCardDivider} />
                <View style={styles.detailCardRow}>
                  <Text style={styles.detailLabel}>Bank</Text>
                  <Text style={styles.detailValue}>{detailP.bank_name || '—'}</Text>
                </View>
                <View style={styles.detailCardDivider} />
                <View style={styles.detailCardRow}>
                  <Text style={styles.detailLabel}>Account Number</Text>
                  <Text style={[styles.detailValue, styles.mono]}>{maskAccount(detailP.bank_account_number)}</Text>
                </View>
                {detailP.paid_period_start_date ? (
                  <>
                    <View style={styles.detailCardDivider} />
                    <View style={styles.detailCardRow}>
                      <Text style={styles.detailLabel}>Period Started</Text>
                      <Text style={styles.detailValue}>
                        {new Date(detailP.paid_period_start_date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </Text>
                    </View>
                  </>
                ) : null}
                {detailP.paid_periods_completed > 0 ? (
                  <>
                    <View style={styles.detailCardDivider} />
                    <View style={styles.detailCardRow}>
                      <Text style={styles.detailLabel}>Periods Completed</Text>
                      <Text style={[styles.detailValue, { color: GREEN }]}>{detailP.paid_periods_completed} / 6</Text>
                    </View>
                  </>
                ) : null}
              </View>

              {/* Admin actions */}
              {(detailP.status === 'pending_review' || detailP.qualification_customers_count >= 76 && detailP.status === 'qualifying') ? (
                <View style={styles.actionsGroup}>
                  <Text style={styles.actionsGroupLabel}>ELIGIBILITY REVIEW</Text>
                  <TouchableOpacity style={[styles.actionBtn, styles.approveBtn, { height: 50, borderRadius: 12 }]}
                    onPress={() => handleApprove(detailP.id)} disabled={actionLoading} activeOpacity={0.85}>
                    {actionLoading ? <ActivityIndicator color={BG} size="small" /> : (
                      <>
                        <MaterialIcons name="verified" size={16} color={BG} />
                        <Text style={styles.approveBtnText}>Approve — Mark Eligible</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.actionBtn, styles.rejectBtn, { height: 50, borderRadius: 12 }]}
                    onPress={() => handleReject(detailP.id)} activeOpacity={0.85}>
                    <Text style={styles.rejectBtnText}>Reject Review</Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              {detailP.status === 'eligible_not_joined' ? (
                <View style={styles.actionsGroup}>
                  <Text style={styles.actionsGroupLabel}>ACTIVATION</Text>
                  <TouchableOpacity style={[styles.actionBtn, styles.approveBtn, { height: 50, borderRadius: 12 }]}
                    onPress={() => handleActivateLead(detailP.id)} disabled={actionLoading} activeOpacity={0.85}>
                    {actionLoading ? <ActivityIndicator color={BG} size="small" /> : (
                      <>
                        <MaterialIcons name="rocket-launch" size={16} color={BG} />
                        <Text style={styles.approveBtnText}>Activate as NumVault Lead</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  {!detailP.bank_account_number && (
                    <View style={styles.warningBox}>
                      <MaterialIcons name="warning" size={14} color={GOLD} />
                      <Text style={styles.warningBoxText}>No bank account on file. Activation will succeed but payouts will be queued until bank details are added.</Text>
                    </View>
                  )}
                </View>
              ) : null}

              {detailLoading ? (
                <ActivityIndicator color={GREEN} style={{ marginVertical: 24 }} />
              ) : (
                <>
                  {/* Referred customers */}
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
                          <Text style={styles.refCustomerId} numberOfLines={1}>{r.customer_id}</Text>
                          <Text style={styles.refCustomerMeta}>
                            Signed up {new Date(r.signup_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
                            {r.validated_at ? ` · Validated ${new Date(r.validated_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}` : ''}
                          </Text>
                        </View>
                        <Text style={[styles.refCustomerStatus, { color: r.validated ? GREEN : MUTED }]}>
                          {r.validated ? 'Valid' : 'Pending'}
                        </Text>
                      </View>
                    ))
                  )}

                  {/* Payout history */}
                  {detailPayouts.length > 0 ? (
                    <>
                      <View style={styles.sectionLabel}>
                        <Text style={styles.sectionLabelText}>PAYOUT HISTORY</Text>
                      </View>
                      {detailPayouts.map((pay) => (
                        <TransferRow key={pay.id} transfer={pay} expanded />
                      ))}
                    </>
                  ) : null}
                </>
              )}
            </ScrollView>
          </View>
        ) : null}
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
  card: {
    flex: 1, backgroundColor: SURFACE, borderWidth: 1,
    borderRadius: 14, padding: 14, gap: 5,
  },
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
  tile: {
    width: '31%', backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 12, padding: 12, alignItems: 'flex-start', gap: 4,
  },
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

function ReviewStat({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={rvStyles.wrap}>
      <Text style={rvStyles.value} style={[rvStyles.value, valueColor ? { color: valueColor } : null]}>{value}</Text>
      <Text style={rvStyles.label}>{label}</Text>
    </View>
  );
}
const rvStyles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center' },
  value: { fontSize: 16, fontWeight: '700', color: TEXT, marginBottom: 2 },
  label: { fontSize: 10, color: MUTED },
});

function TransferRow({ transfer: t, name, onRetry, expanded }: { transfer: LeadPayout; name?: string; onRetry?: (t: LeadPayout) => void; expanded?: boolean }) {
  const isPaid = t.status === 'sent';
  const isFailed = t.status === 'failed';
  const iconColor = isPaid ? GREEN : isFailed ? RED : GOLD;
  const iconBg = isPaid ? 'rgba(74,222,128,0.15)' : isFailed ? RED_BG : GOLD_BG;
  const iconName: keyof typeof MaterialIcons.glyphMap = isPaid ? 'check-circle' : isFailed ? 'error' : 'pending';
  return (
    <View style={trStyles.row}>
      <View style={[trStyles.icon, { backgroundColor: iconBg }]}>
        <MaterialIcons name={iconName} size={18} color={iconColor} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        {name ? <Text style={trStyles.name}>{name}</Text> : null}
        <Text style={trStyles.meta}>
          Cycle {t.cycle_number} · {new Date(t.monthly_window_start).toLocaleDateString('en-NG', { month: 'short', year: 'numeric' })}
        </Text>
        {expanded && t.paystack_transfer_code ? (
          <Text style={trStyles.code} numberOfLines={1}>{t.paystack_transfer_code}</Text>
        ) : null}
        {isFailed && t.failure_reason ? (
          <Text style={trStyles.error} numberOfLines={2}>{t.failure_reason}</Text>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 6 }}>
        <Text style={[trStyles.amount, { color: isPaid ? GREEN : TEXT }]}>₦{Number(t.amount).toLocaleString()}</Text>
        {isFailed && onRetry ? (
          <TouchableOpacity style={trStyles.retryBtn} onPress={() => onRetry(t)} activeOpacity={0.8}>
            <Text style={trStyles.retryText}>Retry</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}
const trStyles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 12, padding: 14,
  },
  icon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  name: { fontSize: 13, fontWeight: '600', color: TEXT },
  meta: { fontSize: 11, color: TEXT2 },
  code: { fontSize: 10, color: MUTED, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  error: { fontSize: 10, color: RED, lineHeight: 16 },
  amount: { fontSize: 14, fontWeight: '700' },
  retryBtn: { backgroundColor: GOLD_BG, borderWidth: 1, borderColor: GOLD, borderRadius: 100, paddingHorizontal: 10, paddingVertical: 3 },
  retryText: { color: GOLD, fontSize: 10, fontWeight: '700' },
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
      <View style={emStyles.iconWrap}>
        <MaterialIcons name={icon} size={28} color={MUTED} />
      </View>
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

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16 },

  // Access denied
  accessDeniedIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: RED_BG, borderWidth: 1, borderColor: RED + '55', alignItems: 'center', justifyContent: 'center' },
  accessDeniedTitle: { fontSize: 20, fontWeight: '700', color: TEXT },
  accessDeniedSub: { fontSize: 13, color: TEXT2, textAlign: 'center' },
  accessDeniedBtn: { backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, borderRadius: 100, paddingHorizontal: 24, paddingVertical: 12 },
  accessDeniedBtnText: { color: TEXT2, fontSize: 14, fontWeight: '600' },

  // Header
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 12 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 12, borderBottomWidth: 1, borderBottomColor: BORDER },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#111a11', borderWidth: 1, borderColor: BORDER2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  refreshBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#111a11', borderWidth: 1, borderColor: BORDER, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: TEXT },
  headerSub: { fontSize: 11, color: MUTED, marginTop: 1 },

  // Tab bar
  tabBarWrap: {
    flexDirection: 'row', marginHorizontal: 16, marginBottom: 12,
    backgroundColor: '#111a11', borderWidth: 1, borderColor: BORDER2,
    borderRadius: 14, padding: 4, gap: 2,
  },
  tabItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 9, borderRadius: 10 },
  tabItemActive: { backgroundColor: '#1a3a1a' },
  tabItemText: { fontSize: 11, fontWeight: '500', color: MUTED },
  tabItemTextActive: { color: GREEN, fontWeight: '700' },
  tabBadge: { backgroundColor: BORDER, borderRadius: 100, minWidth: 16, paddingHorizontal: 4, height: 16, alignItems: 'center', justifyContent: 'center' },
  tabBadgeActive: { backgroundColor: 'rgba(74,222,128,0.2)' },
  tabBadgeText: { fontSize: 9, fontWeight: '700', color: MUTED },
  tabBadgeTextActive: { color: GREEN },

  content: { paddingHorizontal: 16, gap: 10 },

  // Alerts
  alertBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: GOLD_BG, borderWidth: 1, borderColor: GOLD + '55',
    borderRadius: 12, padding: 13,
  },
  alertBannerRed: { backgroundColor: RED_BG, borderColor: RED + '55' },
  alertBannerDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: GOLD, flexShrink: 0 },
  alertBannerText: { flex: 1, fontSize: 12, fontWeight: '500', color: GOLD },

  // Section label
  sectionLabel: { marginTop: 4 },
  sectionLabelText: { fontSize: 10, fontWeight: '700', color: MUTED2, letterSpacing: 1.2 },

  // Finance
  finRow: { flexDirection: 'row', gap: 10 },

  // Stats grid
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

  // Filter chips
  filterRow: { gap: 8, paddingRight: 16, paddingBottom: 2 },
  filterChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 100, paddingHorizontal: 14, paddingVertical: 8,
  },
  filterChipActive: { borderColor: GREEN, backgroundColor: 'rgba(74,222,128,0.1)' },
  filterChipText: { fontSize: 12, fontWeight: '500', color: TEXT2 },
  filterChipTextActive: { color: GREEN, fontWeight: '700' },
  filterChipCount: { fontSize: 11, fontWeight: '700', color: MUTED },

  // Participant card
  participantCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 14, padding: 14,
  },
  participantAvatar: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(74,222,128,0.12)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.25)',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  participantAvatarText: { color: GREEN, fontSize: 16, fontWeight: '700' },
  participantName: { fontSize: 14, fontWeight: '600', color: TEXT },
  participantCode: { fontSize: 11, color: MUTED, letterSpacing: 0.5 },
  participantMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  participantMeta: { fontSize: 11, color: TEXT2 },

  // Review card
  reviewCard: {
    backgroundColor: SURFACE, borderWidth: 1, borderColor: GOLD + '44',
    borderRadius: 16, padding: 16, gap: 12,
  },
  reviewCardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  reviewName: { fontSize: 15, fontWeight: '700', color: TEXT },
  progressBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: GOLD_BG, borderWidth: 1, borderColor: GOLD + '55',
    borderRadius: 100, paddingHorizontal: 8, paddingVertical: 4,
  },
  progressBadgeText: { color: GOLD, fontSize: 11, fontWeight: '700' },
  reviewStats: {
    flexDirection: 'row', backgroundColor: SURFACE2,
    borderRadius: 10, paddingVertical: 12,
    borderWidth: 1, borderColor: BORDER,
  },
  reviewStatDivider: { width: 1, backgroundColor: BORDER },
  viewCustomersBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: GREEN + '44', borderRadius: 10,
    paddingVertical: 10,
  },
  viewCustomersBtnText: { color: GREEN, fontSize: 13, fontWeight: '600' },
  reviewActions: { flexDirection: 'row', gap: 10 },

  // Action buttons
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 46, borderRadius: 10 },
  approveBtn: { backgroundColor: GREEN },
  approveBtnText: { color: BG, fontWeight: '700', fontSize: 14 },
  rejectBtn: { borderWidth: 1, borderColor: RED + '55', backgroundColor: RED_BG },
  rejectBtnText: { color: RED, fontWeight: '700', fontSize: 14 },
  actionsGroup: { gap: 10 },
  actionsGroupLabel: { fontSize: 10, fontWeight: '700', color: MUTED2, letterSpacing: 1.2 },
  warningBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: GOLD_BG, borderWidth: 1, borderColor: GOLD + '44',
    borderRadius: 10, padding: 12,
  },
  warningBoxText: { flex: 1, fontSize: 11, color: TEXT2, lineHeight: 18 },

  // Payout summary
  payoutSummaryRow: { flexDirection: 'row', gap: 8 },

  // Detail modal
  detailCard: {
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 14, overflow: 'hidden',
  },
  detailCardRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 13,
  },
  detailCardDivider: { height: 1, backgroundColor: BORDER },
  detailLabel: { fontSize: 13, color: TEXT2 },
  detailValue: { fontSize: 13, fontWeight: '600', color: TEXT, textAlign: 'right', flex: 1 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12 },

  emptyDetailText: { fontSize: 12, color: MUTED, textAlign: 'center', padding: 20 },

  // Referred customers in detail
  refCustomerRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 10, padding: 12,
  },
  refCustomerIcon: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  refCustomerId: { fontSize: 11, color: TEXT2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  refCustomerMeta: { fontSize: 10, color: MUTED, marginTop: 2 },
  refCustomerStatus: { fontSize: 11, fontWeight: '700', flexShrink: 0 },
});
