import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, RefreshControl, Modal,
  TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAlert, getSupabaseClient } from '@/template';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import {
  AcquisitionParticipant, ReferredCustomer, LeadPayout, AcquisitionLedgerEntry,
  daysRemainingInQualification, getMonthWindowLabel,
} from '@/services/acquisitionService';

const supabase = getSupabaseClient();
const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';

// ── Types specific to admin views ─────────────────────────────────────────────
interface AdminParticipant extends AcquisitionParticipant {
  referred_count: number;
  validated_count: number;
  total_paid: number;
}

interface PaystackBalance {
  balance: number;
  currency: string;
}

type AdminTab = 'summary' | 'participants' | 'reviews' | 'transfers' | 'unattributed';

// ── Helpers ───────────────────────────────────────────────────────────────────
function getMonthWindowLabelLocal(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
}

function maskAccount(num: string | null): string {
  if (!num) return '—';
  if (num.length <= 4) return num;
  return '*'.repeat(num.length - 4) + num.slice(-4);
}

function statusColor(s: string): string {
  switch (s) {
    case 'qualifying': return Colors.primary;
    case 'eligible_not_joined': return Colors.success;
    case 'active_lead': return Colors.warning;
    case 'inactive': return Colors.textMuted;
    default: return Colors.textMuted;
  }
}

function statusLabel(s: string): string {
  switch (s) {
    case 'qualifying': return 'Qualifying';
    case 'eligible_not_joined': return 'Eligible';
    case 'active_lead': return 'Active Lead';
    case 'inactive': return 'Inactive';
    default: return s;
  }
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function AdminDashboardScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { showAlert } = useAlert();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>('summary');

  // Data
  const [participants, setParticipants] = useState<AdminParticipant[]>([]);
  const [pendingReviews, setPendingReviews] = useState<AcquisitionParticipant[]>([]);
  const [transfers, setTransfers] = useState<LeadPayout[]>([]);
  const [unattributed, setUnattributed] = useState<AcquisitionLedgerEntry[]>([]);
  const [paystackBalance, setPaystackBalance] = useState<PaystackBalance | null>(null);
  const [obligationTotal, setObligationTotal] = useState(0);
  const [unattributedTotal, setUnattributedTotal] = useState(0);

  // Detail modal
  const [detailParticipant, setDetailParticipant] = useState<AdminParticipant | null>(null);
  const [detailRefs, setDetailRefs] = useState<ReferredCustomer[]>([]);
  const [detailPayouts, setDetailPayouts] = useState<LeadPayout[]>([]);
  const [detailLedger, setDetailLedger] = useState<AcquisitionLedgerEntry[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reviewLoading, setReviewLoading] = useState<string | null>(null);

  // Auth guard
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    checkAdminAndLoad();
  }, []);

  const checkAdminAndLoad = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.email !== ADMIN_EMAIL) {
      setIsAdmin(false);
      setLoading(false);
      return;
    }
    setIsAdmin(true);
    await loadAll();
  };

  const loadAll = useCallback(async () => {
    try {
      // Participants with aggregated counts
      const { data: parts } = await supabase
        .from('acquisition_participants')
        .select('*')
        .order('created_at', { ascending: false });

      if (parts) {
        const enriched: AdminParticipant[] = await Promise.all(
          parts.map(async (p) => {
            const { count: refCount } = await supabase
              .from('referred_customers')
              .select('*', { count: 'exact', head: true })
              .eq('participant_id', p.id);
            const { count: valCount } = await supabase
              .from('referred_customers')
              .select('*', { count: 'exact', head: true })
              .eq('participant_id', p.id)
              .eq('validated', true);
            const { data: paidOuts } = await supabase
              .from('lead_payouts')
              .select('amount')
              .eq('participant_id', p.id)
              .eq('status', 'sent');
            const totalPaid = (paidOuts || []).reduce((s, x) => s + Number(x.amount), 0);
            return {
              ...p,
              referred_count: refCount ?? 0,
              validated_count: valCount ?? 0,
              total_paid: totalPaid,
            } as AdminParticipant;
          })
        );
        setParticipants(enriched);
        setPendingReviews(
          enriched.filter(
            (p) => p.qualification_customers_count >= 76 && p.status === 'qualifying'
          )
        );
      }

      // Transfers
      const { data: pays } = await supabase
        .from('lead_payouts')
        .select('*')
        .order('triggered_at', { ascending: false });
      setTransfers((pays || []) as LeadPayout[]);

      // Ledger totals
      const { data: ledger } = await supabase
        .from('acquisition_ledger_entries')
        .select('*')
        .order('created_at', { ascending: false });

      const allLedger = ledger || [];
      const unatt = allLedger.filter((l) => l.entry_type === 'unattributed_profit');
      const oblig = allLedger.filter((l) => l.entry_type === 'lead_obligation');
      setUnattributed(unatt as AcquisitionLedgerEntry[]);
      setUnattributedTotal(unatt.reduce((s, l) => s + Number(l.amount), 0));
      setObligationTotal(oblig.reduce((s, l) => s + Number(l.amount), 0));

    } catch (e) {
      console.error('Admin dashboard load error', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const onRefresh = () => {
    setRefreshing(true);
    loadAll();
  };

  // ── Participant detail modal ───────────────────────────────────────────────

  const openDetail = async (p: AdminParticipant) => {
    setDetailParticipant(p);
    setDetailLoading(true);
    try {
      const [{ data: refs }, { data: pays }, { data: ledger }] = await Promise.all([
        supabase
          .from('referred_customers')
          .select('*')
          .eq('participant_id', p.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('lead_payouts')
          .select('*')
          .eq('participant_id', p.id)
          .order('triggered_at', { ascending: false }),
        supabase
          .from('acquisition_ledger_entries')
          .select('*')
          .eq('participant_id', p.id)
          .order('created_at', { ascending: false }),
      ]);
      setDetailRefs((refs || []) as ReferredCustomer[]);
      setDetailPayouts((pays || []) as LeadPayout[]);
      setDetailLedger((ledger || []) as AcquisitionLedgerEntry[]);
    } catch (e) {
      console.error('Detail load error', e);
    } finally {
      setDetailLoading(false);
    }
  };

  // ── Eligibility actions ───────────────────────────────────────────────────

  const handleApprove = async (participantId: string) => {
    showAlert(
      'Approve Eligibility?',
      'This will unlock the paid Lead invitation for this participant.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          style: 'default',
          onPress: async () => {
            setReviewLoading(participantId);
            const { error } = await supabase
              .from('acquisition_participants')
              .update({ status: 'eligible_not_joined' })
              .eq('id', participantId);
            setReviewLoading(null);
            if (error) {
              showAlert('Error', error.message);
            } else {
              showAlert('Approved', 'Participant has been marked as eligible.');
              await loadAll();
              setDetailParticipant(null);
            }
          },
        },
      ]
    );
  };

  const handleReject = async (participantId: string) => {
    showAlert(
      'Reject Review?',
      'The participant will remain frozen at 76/76 pending appeal.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: async () => {
            setReviewLoading(participantId);
            // Keep status as 'qualifying' but note it's frozen
            // We just reload — the UI reflects frozen state by 76/76 with qualifying status
            setReviewLoading(null);
            showAlert('Rejected', 'Participant remains at 76/76 pending appeal. Contact them directly.');
            await loadAll();
          },
        },
      ]
    );
  };

  // ── Manual payout ─────────────────────────────────────────────────────────

  const handleManualPayout = async (p: AdminParticipant) => {
    if (p.validated_count < 38) {
      showAlert('Not eligible', 'This participant has fewer than 38 validated customers. Manual payout is disabled.');
      return;
    }
    showAlert(
      'Trigger Manual Payout?',
      `Send ₦50,000 to ${p.name}? This is irreversible.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm Payout',
          style: 'default',
          onPress: async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            // In a full implementation this would call a trigger-payout edge function.
            // For now, create the payout record as 'pending' for manual Paystack transfer.
            const now = new Date();
            const windowStart = new Date(now.getFullYear(), now.getMonth(), 1)
              .toISOString()
              .split('T')[0];
            const { error } = await supabase.from('lead_payouts').insert({
              participant_id: p.id,
              cycle_number: 1,
              monthly_window_start: windowStart,
              amount: 50000,
              customers_in_cycle: 38,
              status: 'pending',
            });
            if (error && !error.message.includes('unique')) {
              showAlert('Error', error.message);
            } else {
              showAlert('Payout queued', 'A pending payout record has been created. Complete the Paystack transfer manually and update the record.');
              await loadAll();
            }
          },
        },
      ]
    );
  };

  // ── Retry failed transfer ─────────────────────────────────────────────────

  const handleRetryTransfer = async (payout: LeadPayout) => {
    showAlert(
      'Retry Transfer?',
      `Attempt to re-send ₦${Number(payout.amount).toLocaleString()} for this payout?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Retry',
          style: 'default',
          onPress: async () => {
            const { error } = await supabase
              .from('lead_payouts')
              .update({ status: 'pending', failure_reason: null })
              .eq('id', payout.id);
            if (error) showAlert('Error', error.message);
            else { showAlert('Queued for retry', 'Transfer status reset to pending.'); await loadAll(); }
          },
        },
      ]
    );
  };

  // ── Activate lead ────────────────────────────────────────────────────────

  const handleActivateLead = async (participantId: string) => {
    const now = new Date();
    const windowStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    showAlert(
      'Activate as NumVault Lead?',
      `This sets the participant to active_lead and begins their first monthly window starting ${windowStart}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Activate',
          style: 'default',
          onPress: async () => {
            const { error } = await supabase
              .from('acquisition_participants')
              .update({ status: 'active_lead', active_lead_start_month: windowStart })
              .eq('id', participantId);
            if (error) showAlert('Error', error.message);
            else { showAlert('Lead activated', 'Participant is now an active NumVault Lead.'); await loadAll(); setDetailParticipant(null); }
          },
        },
      ]
    );
  };

  // ── Render guards ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={Colors.primary} size="large" />
      </View>
    );
  }

  if (isAdmin === false) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <MaterialIcons name="block" size={48} color={Colors.error} />
        <Text style={styles.accessDeniedText}>Admin access only</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backLinkBtn}>
          <Text style={styles.backLinkText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const TABS: { key: AdminTab; label: string; icon: string; badge?: number }[] = [
    { key: 'summary', label: 'Summary', icon: 'dashboard' },
    { key: 'participants', label: 'Participants', icon: 'groups', badge: participants.length },
    { key: 'reviews', label: 'Reviews', icon: 'rate-review', badge: pendingReviews.length },
    { key: 'transfers', label: 'Transfers', icon: 'send', badge: transfers.filter((t) => t.status === 'failed').length || undefined },
    { key: 'unattributed', label: 'Unattributed', icon: 'receipt-long' },
  ];

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
          <MaterialIcons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <View>
          <Text style={styles.headerTitle}>Admin Dashboard</Text>
          <Text style={styles.headerSub}>NumVault Acquisition Program</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={() => { setRefreshing(true); loadAll(); }} activeOpacity={0.7}>
          {refreshing ? <ActivityIndicator size="small" color={Colors.primary} /> : <MaterialIcons name="refresh" size={20} color={Colors.textSecondary} />}
        </TouchableOpacity>
      </View>

      {/* Tab bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabBar}
      >
        {TABS.map((t) => {
          const active = activeTab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={[styles.tab, active && styles.tabActive]}
              onPress={() => setActiveTab(t.key)}
              activeOpacity={0.8}
            >
              <MaterialIcons name={t.icon as any} size={14} color={active ? Colors.primary : Colors.textMuted} />
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{t.label}</Text>
              {t.badge ? (
                <View style={[styles.tabBadge, active && styles.tabBadgeActive]}>
                  <Text style={[styles.tabBadgeText, active && styles.tabBadgeTextActive]}>{t.badge}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Content */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} colors={[Colors.primary]} />}
      >

        {/* ── SUMMARY ── */}
        {activeTab === 'summary' && (
          <>
            <View style={styles.summaryGrid}>
              <SummaryTile icon="groups" label="Total Participants" value={String(participants.length)} />
              <SummaryTile icon="star" label="Active Leads" value={String(participants.filter((p) => p.status === 'active_lead').length)} color={Colors.warning} />
              <SummaryTile icon="rate-review" label="Pending Reviews" value={String(pendingReviews.length)} color={pendingReviews.length > 0 ? Colors.error : Colors.textMuted} />
              <SummaryTile icon="payments" label="Lead Obligations" value={`₦${obligationTotal.toLocaleString()}`} color={Colors.primary} />
              <SummaryTile icon="trending-up" label="Unattributed Profit" value={`₦${unattributedTotal.toLocaleString()}`} color={Colors.success} />
              <SummaryTile icon="send" label="Transfers Sent" value={String(transfers.filter((t) => t.status === 'sent').length)} />
            </View>

            {pendingReviews.length > 0 && (
              <View style={styles.alertCard}>
                <MaterialIcons name="notification-important" size={18} color={Colors.warning} />
                <Text style={styles.alertText}>
                  {pendingReviews.length} participant{pendingReviews.length > 1 ? 's' : ''} waiting for eligibility review.
                </Text>
                <TouchableOpacity onPress={() => setActiveTab('reviews')}>
                  <Text style={styles.alertLink}>Review now</Text>
                </TouchableOpacity>
              </View>
            )}

            {transfers.filter((t) => t.status === 'failed').length > 0 && (
              <View style={[styles.alertCard, { borderColor: Colors.error }]}>
                <MaterialIcons name="error" size={18} color={Colors.error} />
                <Text style={[styles.alertText, { color: Colors.error }]}>
                  {transfers.filter((t) => t.status === 'failed').length} failed transfer(s).
                </Text>
                <TouchableOpacity onPress={() => setActiveTab('transfers')}>
                  <Text style={[styles.alertLink, { color: Colors.error }]}>View</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}

        {/* ── PARTICIPANTS ── */}
        {activeTab === 'participants' && (
          <>
            {participants.length === 0 ? (
              <EmptyState icon="groups" title="No participants yet" sub="Students who enroll will appear here." />
            ) : (
              participants.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={styles.participantRow}
                  onPress={() => openDetail(p)}
                  activeOpacity={0.8}
                >
                  <View style={styles.participantLeft}>
                    <View style={styles.participantAvatar}>
                      <Text style={styles.participantAvatarText}>{p.name.charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.participantName} numberOfLines={1}>{p.name}</Text>
                      <Text style={styles.participantCode}>{p.referral_code}</Text>
                    </View>
                  </View>
                  <View style={styles.participantRight}>
                    <View style={[styles.statusBadge, { backgroundColor: statusColor(p.status) + '22', borderColor: statusColor(p.status) }]}>
                      <Text style={[styles.statusBadgeText, { color: statusColor(p.status) }]}>{statusLabel(p.status)}</Text>
                    </View>
                    <Text style={styles.participantStats}>
                      {p.validated_count} validated
                    </Text>
                    <MaterialIcons name="chevron-right" size={16} color={Colors.textMuted} />
                  </View>
                </TouchableOpacity>
              ))
            )}
          </>
        )}

        {/* ── REVIEWS ── */}
        {activeTab === 'reviews' && (
          <>
            {pendingReviews.length === 0 ? (
              <EmptyState icon="rate-review" title="No pending reviews" sub="Participants who reach 76 customers will appear here." />
            ) : (
              pendingReviews.map((p) => (
                <View key={p.id} style={styles.reviewCard}>
                  <View style={styles.reviewCardHeader}>
                    <Text style={styles.reviewName}>{p.name}</Text>
                    <View style={styles.qualifiedBadge}>
                      <MaterialIcons name="check-circle" size={12} color={Colors.warning} />
                      <Text style={styles.qualifiedBadgeText}>76/76</Text>
                    </View>
                  </View>
                  <Text style={styles.reviewCode}>Code: {p.referral_code}</Text>
                  <Text style={styles.reviewMeta}>
                    Enrolled: {new Date(p.qualification_start_date || p.created_at).toLocaleDateString()}
                  </Text>

                  <TouchableOpacity
                    style={styles.viewDetailBtn}
                    onPress={() => openDetail(p as AdminParticipant)}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.viewDetailText}>View 76 Customers</Text>
                    <MaterialIcons name="chevron-right" size={16} color={Colors.primary} />
                  </TouchableOpacity>

                  <View style={styles.reviewActions}>
                    <TouchableOpacity
                      style={[styles.reviewBtn, styles.rejectBtn, reviewLoading === p.id && styles.btnDisabled]}
                      onPress={() => handleReject(p.id)}
                      disabled={reviewLoading === p.id}
                      activeOpacity={0.85}
                    >
                      {reviewLoading === p.id ? <ActivityIndicator size="small" color={Colors.error} /> : <Text style={styles.rejectBtnText}>Reject</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.reviewBtn, styles.approveBtn, reviewLoading === p.id && styles.btnDisabled]}
                      onPress={() => handleApprove(p.id)}
                      disabled={reviewLoading === p.id}
                      activeOpacity={0.85}
                    >
                      {reviewLoading === p.id ? <ActivityIndicator size="small" color={Colors.black} /> : <Text style={styles.approveBtnText}>Approve</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </>
        )}

        {/* ── TRANSFERS ── */}
        {activeTab === 'transfers' && (
          <>
            {transfers.length === 0 ? (
              <EmptyState icon="send" title="No transfers yet" sub="Payout transfers will appear here." />
            ) : (
              transfers.map((t) => {
                const part = participants.find((p) => p.id === t.participant_id);
                return (
                  <View key={t.id} style={styles.transferRow}>
                    <View style={[styles.transferIcon, {
                      backgroundColor: t.status === 'sent' ? Colors.successMuted : t.status === 'failed' ? Colors.errorMuted : Colors.primaryMuted
                    }]}>
                      <MaterialIcons
                        name={t.status === 'sent' ? 'check-circle' : t.status === 'failed' ? 'error' : 'pending'}
                        size={18}
                        color={t.status === 'sent' ? Colors.success : t.status === 'failed' ? Colors.error : Colors.primary}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.transferName}>{part?.name || 'Unknown'}</Text>
                      <Text style={styles.transferMeta}>
                        Cycle {t.cycle_number} · {getMonthWindowLabelLocal(t.monthly_window_start)}
                      </Text>
                      {t.paystack_transfer_code && (
                        <Text style={styles.transferRef} numberOfLines={1}>{t.paystack_transfer_code}</Text>
                      )}
                      {t.failure_reason && (
                        <Text style={styles.transferError} numberOfLines={2}>{t.failure_reason}</Text>
                      )}
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 6 }}>
                      <Text style={styles.transferAmount}>₦{Number(t.amount).toLocaleString()}</Text>
                      {t.status === 'failed' && (
                        <TouchableOpacity
                          style={styles.retryBtn}
                          onPress={() => handleRetryTransfer(t)}
                          activeOpacity={0.8}
                        >
                          <Text style={styles.retryBtnText}>Retry</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })
            )}
          </>
        )}

        {/* ── UNATTRIBUTED ── */}
        {activeTab === 'unattributed' && (
          <>
            <View style={styles.unattributedTotal}>
              <MaterialIcons name="trending-up" size={20} color={Colors.success} />
              <Text style={styles.unattributedTotalLabel}>Total Unattributed Profit</Text>
              <Text style={styles.unattributedTotalValue}>₦{unattributedTotal.toLocaleString()}</Text>
            </View>
            {unattributed.length === 0 ? (
              <EmptyState icon="receipt-long" title="No unattributed entries" sub="Non-referred purchases will appear here." />
            ) : (
              unattributed.map((e) => (
                <View key={e.id} style={styles.ledgerRow}>
                  <View style={styles.ledgerIcon}>
                    <MaterialIcons name="receipt" size={16} color={Colors.success} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.ledgerOrderId} numberOfLines={1}>{e.order_id}</Text>
                    <Text style={styles.ledgerDate}>{new Date(e.created_at).toLocaleDateString()}</Text>
                  </View>
                  <Text style={styles.ledgerAmount}>₦{Number(e.amount).toLocaleString()}</Text>
                </View>
              ))
            )}
          </>
        )}

      </ScrollView>

      {/* ── DETAIL MODAL ── */}
      <Modal
        visible={!!detailParticipant}
        animationType="slide"
        onRequestClose={() => setDetailParticipant(null)}
      >
        {detailParticipant && (
          <View style={[styles.container, { paddingTop: insets.top }]}>
            <View style={styles.header}>
              <TouchableOpacity style={styles.backBtn} onPress={() => setDetailParticipant(null)} activeOpacity={0.7}>
                <MaterialIcons name="close" size={22} color={Colors.text} />
              </TouchableOpacity>
              <Text style={styles.headerTitle} numberOfLines={1}>{detailParticipant.name}</Text>
              <View style={{ width: 36 }} />
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
            >
              {/* Participant summary */}
              <View style={styles.detailSummary}>
                <DetailRow label="Referral Code" value={detailParticipant.referral_code} mono />
                <DetailRow label="Status" value={statusLabel(detailParticipant.status)} />
                <DetailRow label="Validated Customers" value={String(detailParticipant.validated_count)} />
                <DetailRow label="Bank Account" value={maskAccount(detailParticipant.bank_account_number)} />
                <DetailRow label="Bank" value={detailParticipant.bank_name || '—'} />
                <DetailRow label="Total Paid Out" value={`₦${detailParticipant.total_paid.toLocaleString()}`} />
              </View>

              {/* Admin actions */}
              <View style={styles.detailActions}>
                {detailParticipant.qualification_customers_count >= 76 && detailParticipant.status === 'qualifying' && (
                  <>
                    <TouchableOpacity
                      style={[styles.reviewBtn, styles.approveBtn]}
                      onPress={() => handleApprove(detailParticipant.id)}
                      activeOpacity={0.85}
                    >
                      <MaterialIcons name="verified" size={16} color={Colors.black} />
                      <Text style={styles.approveBtnText}>Approve Eligibility</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.reviewBtn, styles.rejectBtn]}
                      onPress={() => handleReject(detailParticipant.id)}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.rejectBtnText}>Reject</Text>
                    </TouchableOpacity>
                  </>
                )}
                {detailParticipant.status === 'eligible_not_joined' && (
                  <TouchableOpacity
                    style={[styles.reviewBtn, styles.approveBtn]}
                    onPress={() => handleActivateLead(detailParticipant.id)}
                    activeOpacity={0.85}
                  >
                    <MaterialIcons name="rocket-launch" size={16} color={Colors.black} />
                    <Text style={styles.approveBtnText}>Activate as Lead</Text>
                  </TouchableOpacity>
                )}
                {detailParticipant.status === 'active_lead' && (
                  <TouchableOpacity
                    style={[styles.reviewBtn, styles.approveBtn, detailParticipant.validated_count < 38 && styles.btnDisabled]}
                    onPress={() => handleManualPayout(detailParticipant)}
                    disabled={detailParticipant.validated_count < 38}
                    activeOpacity={0.85}
                  >
                    <MaterialIcons name="payments" size={16} color={Colors.black} />
                    <Text style={styles.approveBtnText}>
                      {detailParticipant.validated_count >= 38 ? 'Manual Payout (₦50,000)' : 'Payout locked — need 38 customers'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>

              {detailLoading ? (
                <ActivityIndicator color={Colors.primary} style={{ marginTop: 24 }} />
              ) : (
                <>
                  {/* Referred customers */}
                  <Text style={styles.detailSectionTitle}>
                    Referred Customers ({detailRefs.length})
                  </Text>
                  {detailRefs.length === 0 ? (
                    <Text style={styles.emptyDetailText}>No referred customers yet.</Text>
                  ) : (
                    detailRefs.map((r) => (
                      <View key={r.id} style={styles.refRow}>
                        <View style={[styles.refValidIcon, { backgroundColor: r.validated ? Colors.successMuted : Colors.surfaceElevated }]}>
                          <MaterialIcons
                            name={r.validated ? 'check' : 'schedule'}
                            size={12}
                            color={r.validated ? Colors.success : Colors.textMuted}
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.refId} numberOfLines={1}>{r.customer_id}</Text>
                          <Text style={styles.refMeta}>
                            Signup: {new Date(r.signup_at).toLocaleDateString()}
                            {r.first_purchase_at ? ` · Purchase: ${new Date(r.first_purchase_at).toLocaleDateString()}` : ''}
                          </Text>
                        </View>
                        <Text style={[styles.refStatus, { color: r.validated ? Colors.success : Colors.textMuted }]}>
                          {r.validated ? 'Validated' : 'Pending'}
                        </Text>
                      </View>
                    ))
                  )}

                  {/* Payout history */}
                  {detailPayouts.length > 0 && (
                    <>
                      <Text style={styles.detailSectionTitle}>Payout History</Text>
                      {detailPayouts.map((pay) => (
                        <View key={pay.id} style={styles.refRow}>
                          <View style={[styles.refValidIcon, { backgroundColor: pay.status === 'sent' ? Colors.successMuted : Colors.primaryMuted }]}>
                            <MaterialIcons
                              name={pay.status === 'sent' ? 'check' : 'pending'}
                              size={12}
                              color={pay.status === 'sent' ? Colors.success : Colors.primary}
                            />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.refId}>Cycle {pay.cycle_number} · {getMonthWindowLabelLocal(pay.monthly_window_start)}</Text>
                            <Text style={styles.refMeta}>{new Date(pay.triggered_at).toLocaleDateString()}</Text>
                          </View>
                          <Text style={styles.transferAmount}>₦{Number(pay.amount).toLocaleString()}</Text>
                        </View>
                      ))}
                    </>
                  )}

                  {/* Ledger */}
                  {detailLedger.length > 0 && (
                    <>
                      <Text style={styles.detailSectionTitle}>Acquisition Ledger</Text>
                      <View style={styles.ledgerTotal}>
                        <Text style={styles.ledgerTotalLabel}>Total obligation from this participant</Text>
                        <Text style={styles.ledgerTotalValue}>
                          ₦{detailLedger.reduce((s, e) => s + Number(e.amount), 0).toLocaleString()}
                        </Text>
                      </View>
                      {detailLedger.slice(0, 10).map((e) => (
                        <View key={e.id} style={styles.ledgerRow}>
                          <View style={styles.ledgerIcon}>
                            <MaterialIcons name="receipt" size={14} color={Colors.primary} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.ledgerOrderId} numberOfLines={1}>{e.order_id}</Text>
                            <Text style={styles.ledgerDate}>{new Date(e.created_at).toLocaleDateString()}</Text>
                          </View>
                          <Text style={styles.ledgerAmount}>₦{Number(e.amount).toLocaleString()}</Text>
                        </View>
                      ))}
                    </>
                  )}
                </>
              )}
            </ScrollView>
          </View>
        )}
      </Modal>
    </View>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryTile({ icon, label, value, color }: { icon: string; label: string; value: string; color?: string }) {
  return (
    <View style={styles.summaryTile}>
      <MaterialIcons name={icon as any} size={20} color={color || Colors.textSecondary} />
      <Text style={[styles.summaryTileValue, color ? { color } : null]}>{value}</Text>
      <Text style={styles.summaryTileLabel}>{label}</Text>
    </View>
  );
}

function EmptyState({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <View style={styles.emptyState}>
      <MaterialIcons name={icon as any} size={40} color={Colors.textMuted} />
      <Text style={styles.emptyStateTitle}>{title}</Text>
      <Text style={styles.emptyStateSub}>{sub}</Text>
    </View>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, mono && { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>{value}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { alignItems: 'center', justifyContent: 'center', gap: Spacing.lg },
  accessDeniedText: { color: Colors.error, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  backLinkBtn: { padding: Spacing.md },
  backLinkText: { color: Colors.primary, fontSize: FontSize.md },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, gap: Spacing.sm,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: Radius.md,
    backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { flex: 1, color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  headerSub: { color: Colors.textSecondary, fontSize: FontSize.xs },
  refreshBtn: { padding: 8, borderRadius: Radius.md, backgroundColor: Colors.surface },

  tabBar: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md, gap: Spacing.sm },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.full, paddingHorizontal: 14, paddingVertical: 8,
  },
  tabActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },
  tabText: { color: Colors.textSecondary, fontSize: 12, fontWeight: FontWeight.medium },
  tabTextActive: { color: Colors.primary, fontWeight: FontWeight.bold },
  tabBadge: {
    backgroundColor: Colors.surfaceBorder, borderRadius: Radius.full,
    paddingHorizontal: 6, paddingVertical: 1, minWidth: 18, alignItems: 'center',
  },
  tabBadgeActive: { backgroundColor: 'rgba(0,200,83,0.2)' },
  tabBadgeText: { color: Colors.textMuted, fontSize: 10, fontWeight: FontWeight.bold },
  tabBadgeTextActive: { color: Colors.primary },

  content: { padding: Spacing.lg, gap: Spacing.md },

  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  summaryTile: {
    flex: 1, minWidth: '45%',
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg, padding: Spacing.md, gap: 4,
    alignItems: 'flex-start',
  },
  summaryTileValue: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  summaryTileLabel: { color: Colors.textSecondary, fontSize: FontSize.xs },

  alertCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.warningMuted, borderWidth: 1, borderColor: Colors.warning,
    borderRadius: Radius.md, padding: Spacing.md,
  },
  alertText: { flex: 1, color: Colors.warning, fontSize: FontSize.sm },
  alertLink: { color: Colors.warning, fontWeight: FontWeight.bold, fontSize: FontSize.sm, textDecorationLine: 'underline' },

  participantRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg, padding: Spacing.md, gap: Spacing.md,
  },
  participantLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flex: 1 },
  participantAvatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.primaryMuted, borderWidth: 1, borderColor: 'rgba(0,200,83,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  participantAvatarText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: FontWeight.bold },
  participantName: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  participantCode: { color: Colors.textMuted, fontSize: FontSize.xs },
  participantRight: { alignItems: 'flex-end', gap: 4 },
  participantStats: { color: Colors.textMuted, fontSize: FontSize.xs },
  statusBadge: {
    borderWidth: 1, borderRadius: Radius.full,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  statusBadgeText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },

  reviewCard: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.warning,
    borderRadius: Radius.lg, padding: Spacing.lg, gap: Spacing.sm,
  },
  reviewCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  reviewName: { color: Colors.text, fontSize: FontSize.md, fontWeight: FontWeight.bold },
  qualifiedBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.warningMuted, borderRadius: Radius.full,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  qualifiedBadgeText: { color: Colors.warning, fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  reviewCode: { color: Colors.textSecondary, fontSize: FontSize.sm },
  reviewMeta: { color: Colors.textMuted, fontSize: FontSize.xs },
  viewDetailBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: Spacing.sm,
  },
  viewDetailText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  reviewActions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.xs },
  reviewBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: Radius.md, height: 44,
  },
  approveBtn: { backgroundColor: Colors.primary },
  approveBtnText: { color: Colors.black, fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  rejectBtn: { borderWidth: 1, borderColor: Colors.error },
  rejectBtnText: { color: Colors.error, fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  btnDisabled: { opacity: 0.4 },

  transferRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg, padding: Spacing.md,
  },
  transferIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  transferName: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  transferMeta: { color: Colors.textSecondary, fontSize: FontSize.xs },
  transferRef: { color: Colors.textMuted, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  transferError: { color: Colors.error, fontSize: FontSize.xs, lineHeight: 16 },
  transferAmount: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  retryBtn: {
    backgroundColor: Colors.warningMuted, borderWidth: 1, borderColor: Colors.warning,
    borderRadius: Radius.sm, paddingHorizontal: 10, paddingVertical: 4,
  },
  retryBtnText: { color: Colors.warning, fontSize: FontSize.xs, fontWeight: FontWeight.bold },

  unattributedTotal: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.successMuted, borderWidth: 1, borderColor: Colors.success,
    borderRadius: Radius.md, padding: Spacing.md,
  },
  unattributedTotalLabel: { flex: 1, color: Colors.textSecondary, fontSize: FontSize.sm },
  unattributedTotalValue: { color: Colors.success, fontSize: FontSize.lg, fontWeight: FontWeight.bold },

  ledgerRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md, padding: Spacing.md,
  },
  ledgerIcon: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: Colors.successMuted, alignItems: 'center', justifyContent: 'center',
  },
  ledgerOrderId: { color: Colors.text, fontSize: FontSize.xs, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  ledgerDate: { color: Colors.textMuted, fontSize: FontSize.xs, marginTop: 2 },
  ledgerAmount: { color: Colors.success, fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  ledgerTotal: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md, padding: Spacing.md,
  },
  ledgerTotalLabel: { color: Colors.textSecondary, fontSize: FontSize.xs },
  ledgerTotalValue: { color: Colors.primary, fontWeight: FontWeight.bold, fontSize: FontSize.md },

  detailSummary: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg, overflow: 'hidden',
  },
  detailRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
  },
  detailLabel: { color: Colors.textSecondary, fontSize: FontSize.sm },
  detailValue: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right', flex: 1 },
  detailActions: { gap: Spacing.sm },
  detailSectionTitle: {
    color: Colors.text, fontSize: FontSize.md, fontWeight: FontWeight.bold,
    marginTop: Spacing.md, marginBottom: Spacing.xs,
  },
  emptyDetailText: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'center', padding: Spacing.lg },
  refRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md, padding: Spacing.md,
  },
  refValidIcon: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  refId: { color: Colors.text, fontSize: FontSize.xs, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  refMeta: { color: Colors.textMuted, fontSize: FontSize.xs, marginTop: 2 },
  refStatus: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },

  emptyState: { alignItems: 'center', paddingVertical: Spacing.xxl, gap: Spacing.md },
  emptyStateTitle: { color: Colors.text, fontSize: FontSize.md, fontWeight: FontWeight.bold },
  emptyStateSub: { color: Colors.textSecondary, fontSize: FontSize.sm, textAlign: 'center' },
});
