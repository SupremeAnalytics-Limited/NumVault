import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, Share, TextInput,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { useAlert } from '@/template';
import {
  AcquisitionParticipant, ReferredCustomer, PitchItem,
  getMyParticipant, enrollInProgram, reEnrollInProgram,
  getMyReferredCustomers, getPitchLibrary,
  daysRemainingInQualification, getMyPayouts, LeadPayout,
  computeCycleProgress, getCurrentMonthStart,
} from '@/services/acquisitionService';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

type Screen = 'landing' | 'enroll' | 'qualifying' | 'pending_review' | 'eligible' | 'active_lead';

export default function AcquisitionProgramScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { showAlert } = useAlert();

  const [loading, setLoading] = useState(true);
  const [participant, setParticipant] = useState<AcquisitionParticipant | null>(null);
  const [referred, setReferred] = useState<ReferredCustomer[]>([]);
  const [payouts, setPayouts] = useState<LeadPayout[]>([]);
  const [pitches, setPitches] = useState<PitchItem[]>([]);
  const [screen, setScreen] = useState<Screen>('landing');

  // Enroll form
  const [enrollName, setEnrollName] = useState('');
  const [enrolling, setEnrolling] = useState(false);

  // UI state
  const [pitchExpanded, setPitchExpanded] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    try {
      setLoading(true);
      const [p, lib] = await Promise.all([getMyParticipant(), getPitchLibrary()]);
      setPitches(lib);
      if (p) {
        setParticipant(p);
        const [refs, pays] = await Promise.all([
          getMyReferredCustomers(p.id),
          getMyPayouts(p.id),
        ]);
        setReferred(refs);
        setPayouts(pays);
        setScreen(mapStatusToScreen(p));
      } else {
        setScreen('landing');
      }
    } catch (e) {
      console.error('AcquisitionProgram load error', e);
    } finally {
      setLoading(false);
    }
  };

  const mapStatusToScreen = (p: AcquisitionParticipant): Screen => {
    switch (p.status) {
      case 'qualifying': {
        const days = daysRemainingInQualification(p.qualification_start_date);
        if (days <= 0 && p.qualification_customers_count < 76) return 'qualifying'; // expired window — still show, allow re-enroll
        if (p.qualification_customers_count >= 76) return 'pending_review';
        return 'qualifying';
      }
      case 'eligible_not_joined': return 'eligible';
      case 'active_lead': return 'active_lead';
      case 'inactive': return 'qualifying'; // show progress even if inactive
      default: return 'landing';
    }
  };

  const handleEnroll = async () => {
    if (!enrollName.trim()) {
      showAlert('Name required', 'Please enter your full name to enroll.');
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setEnrolling(true);
    try {
      const p = await enrollInProgram(enrollName);
      setParticipant(p);
      setReferred([]);
      setPayouts([]);
      setScreen('qualifying');
    } catch (e: any) {
      showAlert('Enrollment failed', e.message || 'Please try again.');
    } finally {
      setEnrolling(false);
    }
  };

  const handleReEnroll = async () => {
    if (!participant) return;
    showAlert(
      'Start a new 30-day attempt?',
      'Your progress will reset to 0 / 76. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Re-enroll',
          style: 'default',
          onPress: async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              await reEnrollInProgram(participant.id);
              await loadAll();
            } catch (e: any) {
              showAlert('Error', e.message);
            }
          },
        },
      ]
    );
  };

  const copyCode = async () => {
    if (!participant?.referral_code) return;
    await Clipboard.setStringAsync(participant.referral_code);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const shareCode = async () => {
    if (!participant?.referral_code) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Share.share({
      message: `Sign up on NumVault and use my referral code: ${participant.referral_code}\n\nNumVault gives you private phone numbers for any app or service — pay as you go, no subscription. Download the app and get your first number.`,
      title: 'Join NumVault',
    });
  };

  const daysLeft = daysRemainingInQualification(participant?.qualification_start_date ?? null);
  const qualCount = participant?.qualification_customers_count ?? 0;
  const qualProgress = Math.min(qualCount / 76, 1);
  const windowExpired = daysLeft <= 0 && qualCount < 76 && participant?.status === 'qualifying';

  // Current month cycle progress for active leads
  const cycleProgress = (() => {
    if (participant?.status !== 'active_lead' || !participant.active_lead_start_month) return null;
    const windowStart = getCurrentMonthStart().toISOString().split('T')[0];
    return computeCycleProgress(referred, windowStart);
  })();

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={Colors.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <MaterialIcons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Acquisition Program</Text>
        <View style={{ width: 36 }} />
      </View>

      {/* ── LANDING ── */}
      {screen === 'landing' && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <View style={styles.heroCard}>
            <View style={styles.heroIcon}>
              <MaterialIcons name="groups" size={36} color={Colors.primary} />
            </View>
            <Text style={styles.heroTitle}>NumVault Acquisition Program for Students</Text>
            <Text style={styles.heroSub}>
              Help NumVault reach people who genuinely need private phone numbers. Gain real customer-acquisition experience — and qualify for a paid NumVault Lead opportunity.
            </Text>
          </View>

          <SectionCard title="What NumVault Does" icon="phone-android">
            <Text style={styles.bodyText}>
              NumVault gives customers separate phone numbers for different digital purposes — personal, business, platforms, services, and more. Pay as you go. No subscription. 2,300+ apps and services.{'\n\n'}
              The core idea is separation of concern: one number for work, another for online platforms, another for sign-ups — without mixing everything into one personal number.
            </Text>
          </SectionCard>

          <SectionCard title="Why Students Can Help" icon="lightbulb-outline">
            <Text style={styles.bodyText}>
              The demand NumVault addresses exists in every student network — freelancers, entrepreneurs, online workers, creators, small-business owners. These are people who genuinely need a private number.{'\n\n'}
              Through this program you develop practical experience in customer acquisition, digital marketing, referral marketing, and SaaS business growth.
            </Text>
          </SectionCard>

          <SectionCard title="The Opportunity" icon="emoji-events">
            <HighlightRow icon="groups" label="76 customers in 30 days" sub="Qualification stage — unpaid" />
            <HighlightRow icon="verified" label="Eligibility review" sub="Admin reviews your 76 customers" />
            <HighlightRow icon="payments" label="Become a NumVault Lead" sub="₦50,000 per 38-customer cycle" />
            <HighlightRow icon="calendar-today" label="Up to ₦100,000/month" sub="Maximum across 6 monthly windows" />
          </SectionCard>

          <SectionCard title="What Counts as a Customer" icon="check-circle-outline">
            <Text style={styles.bodyText}>A referred customer counts when they:</Text>
            <BulletRow text="Sign up through your referral code" check />
            <BulletRow text="Purchase at least one phone number" check />
            <BulletRow text="The number is successfully delivered" check />
            <View style={styles.dividerLine} />
            <Text style={[styles.bodyText, { marginTop: Spacing.sm }]}>Does NOT count:</Text>
            <BulletRow text="Referral code entry without purchase" />
            <BulletRow text="Signup alone" />
            <BulletRow text="Wallet funding without a number purchase" />
          </SectionCard>

          <TouchableOpacity
            style={styles.ctaBtn}
            onPress={() => setScreen('enroll')}
            activeOpacity={0.85}
          >
            <MaterialIcons name="rocket-launch" size={18} color={Colors.black} />
            <Text style={styles.ctaBtnText}>Enroll in the Program</Text>
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ── ENROLL FORM ── */}
      {screen === 'enroll' && (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
            <View style={styles.heroCard}>
              <View style={styles.heroIcon}>
                <MaterialIcons name="person-add" size={32} color={Colors.primary} />
              </View>
              <Text style={styles.heroTitle}>Enroll in the Program</Text>
              <Text style={styles.heroSub}>
                Your enrollment starts a 30-day qualification window. Acquire 76 validated customers to qualify for the paid NumVault Lead opportunity.
              </Text>
            </View>

            <View style={styles.formCard}>
              <Text style={styles.formLabel}>Your Full Name</Text>
              <TextInput
                style={styles.formInput}
                value={enrollName}
                onChangeText={setEnrollName}
                placeholder="Enter your full name"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="words"
                returnKeyType="done"
              />
              <Text style={styles.formHint}>
                This name will appear on your participant record and payout documents.
              </Text>
            </View>

            <View style={styles.ruleCard}>
              <Text style={styles.ruleTitle}>Before you enroll</Text>
              {[
                'The first 76 customers are an unpaid qualification stage.',
                'You have 30 days to reach 76 validated customers.',
                'Referral clicks and signups alone do not count.',
                'Each customer must successfully purchase at least one number.',
                'Your referral code will be generated automatically.',
              ].map((r, i) => (
                <View key={i} style={styles.ruleRow}>
                  <MaterialIcons name="info-outline" size={14} color={Colors.primary} />
                  <Text style={styles.ruleText}>{r}</Text>
                </View>
              ))}
            </View>

            <TouchableOpacity
              style={[styles.ctaBtn, (!enrollName.trim() || enrolling) && styles.ctaBtnDisabled]}
              onPress={handleEnroll}
              disabled={!enrollName.trim() || enrolling}
              activeOpacity={0.85}
            >
              {enrolling ? (
                <ActivityIndicator color={Colors.black} />
              ) : (
                <>
                  <MaterialIcons name="check-circle" size={18} color={Colors.black} />
                  <Text style={styles.ctaBtnText}>Start My 30-Day Qualification</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.backLink} onPress={() => setScreen('landing')}>
              <Text style={styles.backLinkText}>Back</Text>
            </TouchableOpacity>

            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* ── QUALIFYING ── */}
      {screen === 'qualifying' && participant && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          {/* Status banner */}
          <View style={[styles.statusBanner, windowExpired && styles.statusBannerWarning]}>
            <MaterialIcons
              name={windowExpired ? 'timer-off' : 'schedule'}
              size={16}
              color={windowExpired ? Colors.warning : Colors.primary}
            />
            <Text style={[styles.statusBannerText, windowExpired && { color: Colors.warning }]}>
              {windowExpired
                ? 'Your 30-day window has expired — enroll again to start a new attempt.'
                : `Qualifying · ${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining`}
            </Text>
          </View>

          {/* Progress card */}
          <View style={styles.progressCard}>
            <Text style={styles.progressLabel}>Customer Acquisition Progress</Text>
            <View style={styles.progressNumbers}>
              <Text style={styles.progressCurrent}>{qualCount}</Text>
              <Text style={styles.progressSep}>/</Text>
              <Text style={styles.progressTarget}>76 Customers</Text>
            </View>
            <View style={styles.progressBarTrack}>
              <View style={[styles.progressBarFill, { width: `${qualProgress * 100}%` }]} />
            </View>
            <View style={styles.progressMeta}>
              <Text style={styles.progressMetaText}>{76 - qualCount} customers remaining</Text>
              <Text style={styles.progressMetaText}>
                {windowExpired ? 'Window expired' : `${daysLeft}d left`}
              </Text>
            </View>
          </View>

          {/* Referral */}
          <ReferralCard
            code={participant.referral_code}
            copied={copiedCode}
            onCopy={copyCode}
            onShare={shareCode}
          />

          {/* Re-enroll if window expired */}
          {windowExpired && (
            <TouchableOpacity style={styles.reEnrollBtn} onPress={handleReEnroll} activeOpacity={0.85}>
              <MaterialIcons name="refresh" size={18} color={Colors.black} />
              <Text style={styles.reEnrollText}>Enroll Again (Reset 0/76)</Text>
            </TouchableOpacity>
          )}

          {/* Pitch library */}
          <PitchLibrarySection pitches={pitches} expanded={pitchExpanded} onToggle={setPitchExpanded} />

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ── PENDING REVIEW ── */}
      {screen === 'pending_review' && participant && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <View style={styles.heroCard}>
            <View style={[styles.heroIcon, { backgroundColor: Colors.warningMuted }]}>
              <MaterialIcons name="pending" size={36} color={Colors.warning} />
            </View>
            <Text style={styles.heroTitle}>Pending Eligibility Review</Text>
            <Text style={styles.heroSub}>
              You have reached 76 / 76. The NumVault team is reviewing your acquisition history before unlocking the paid Lead invitation. This typically takes 1–3 business days.
            </Text>
          </View>

          <View style={styles.progressCard}>
            <Text style={styles.progressLabel}>Customer Acquisition Progress</Text>
            <View style={styles.progressNumbers}>
              <Text style={styles.progressCurrent}>76</Text>
              <Text style={styles.progressSep}>/</Text>
              <Text style={[styles.progressTarget, { color: Colors.warning }]}>76 Customers ✓</Text>
            </View>
            <View style={styles.progressBarTrack}>
              <View style={[styles.progressBarFill, { width: '100%', backgroundColor: Colors.warning }]} />
            </View>
          </View>

          <ReferralCard
            code={participant.referral_code}
            copied={copiedCode}
            onCopy={copyCode}
            onShare={shareCode}
          />

          <SectionCard title="What Happens Next" icon="schedule">
            <HighlightRow icon="manage-search" label="Admin reviews your 76 customers" sub="Checking for distinct accounts and genuine purchases" />
            <HighlightRow icon="check-circle" label="Approval → Paid Lead invitation" sub="You will be notified and asked to complete onboarding" />
            <HighlightRow icon="block" label="Rejection → Frozen at 76/76" sub="You can remain in review/appeal until resolved" />
          </SectionCard>

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ── ELIGIBLE (not yet activated) ── */}
      {screen === 'eligible' && participant && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <View style={styles.heroCard}>
            <View style={[styles.heroIcon, { backgroundColor: Colors.successMuted }]}>
              <MaterialIcons name="verified" size={36} color={Colors.success} />
            </View>
            <Text style={styles.heroTitle}>Eligibility Approved!</Text>
            <Text style={styles.heroSub}>
              Congratulations — you have qualified for the paid NumVault Lead opportunity. Complete the onboarding below to become an active NumVault Lead.
            </Text>
          </View>

          <SectionCard title="Your Paid Lead Opportunity" icon="emoji-events">
            <HighlightRow icon="payments" label="₦50,000 per completed cycle" sub="Each cycle = 38 validated customers" />
            <HighlightRow icon="calendar-today" label="Up to ₦100,000/month" sub="Maximum 2 cycles per calendar month" />
            <HighlightRow icon="event-available" label="6 monthly windows" sub="₦600,000 maximum total over the program" />
          </SectionCard>

          <View style={styles.onboardingCard}>
            <Text style={styles.onboardingTitle}>Next Step: Bank Onboarding</Text>
            <Text style={styles.onboardingText}>
              Contact the NumVault team to provide your bank account details and complete the Lead onboarding process. Your payout account is required before your first paid cycle can begin.
            </Text>
            <TouchableOpacity
              style={styles.ctaBtn}
              onPress={() => {
                const { Linking } = require('react-native');
                Linking.openURL('https://ig.me/m/num.vault');
              }}
              activeOpacity={0.85}
            >
              <MaterialIcons name="support-agent" size={18} color={Colors.black} />
              <Text style={styles.ctaBtnText}>Contact NumVault Team</Text>
            </TouchableOpacity>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ── ACTIVE LEAD ── */}
      {screen === 'active_lead' && participant && cycleProgress && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          {/* Status banner */}
          <View style={[styles.statusBanner, { borderColor: Colors.success }]}>
            <MaterialIcons name="star" size={16} color={Colors.success} />
            <Text style={[styles.statusBannerText, { color: Colors.success }]}>
              Active NumVault Lead · {cycleProgress.monthLabel}
            </Text>
          </View>

          {/* Cycle 1 card */}
          <CycleCard
            cycleNum={1}
            count={cycleProgress.cycle1Count}
            complete={cycleProgress.cycle1Complete}
            payout={payouts.find(
              (p) =>
                p.cycle_number === 1 &&
                p.monthly_window_start === cycleProgress.windowStart
            )}
          />

          {/* Cycle 2 card — shown once cycle 1 is complete */}
          {cycleProgress.cycle1Complete && (
            <CycleCard
              cycleNum={2}
              count={cycleProgress.cycle2Count}
              complete={cycleProgress.cycle2Complete}
              payout={payouts.find(
                (p) =>
                  p.cycle_number === 2 &&
                  p.monthly_window_start === cycleProgress.windowStart
              )}
            />
          )}

          {/* Referral */}
          <ReferralCard
            code={participant.referral_code}
            copied={copiedCode}
            onCopy={copyCode}
            onShare={shareCode}
          />

          {/* Payout history */}
          {payouts.length > 0 && (
            <View style={styles.payoutSection}>
              <Text style={styles.sectionHeader2}>Payout History</Text>
              {payouts.map((pout) => (
                <View key={pout.id} style={styles.payoutRow}>
                  <View style={[styles.payoutIcon, { backgroundColor: pout.status === 'sent' ? Colors.successMuted : pout.status === 'failed' ? Colors.errorMuted : Colors.primaryMuted }]}>
                    <MaterialIcons
                      name={pout.status === 'sent' ? 'check-circle' : pout.status === 'failed' ? 'error' : 'pending'}
                      size={16}
                      color={pout.status === 'sent' ? Colors.success : pout.status === 'failed' ? Colors.error : Colors.primary}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.payoutLabel}>
                      Cycle {pout.cycle_number} · {getMonthWindowLabel(pout.monthly_window_start)}
                    </Text>
                    <Text style={styles.payoutMeta}>
                      {pout.status === 'sent'
                        ? `Sent ${new Date(pout.sent_at!).toLocaleDateString()}`
                        : pout.status === 'failed'
                        ? pout.failure_reason || 'Transfer failed'
                        : 'Pending transfer'}
                    </Text>
                  </View>
                  <Text style={[styles.payoutAmount, { color: pout.status === 'sent' ? Colors.success : Colors.text }]}>
                    ₦{Number(pout.amount).toLocaleString()}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {/* Pitch library */}
          <PitchLibrarySection pitches={pitches} expanded={pitchExpanded} onToggle={setPitchExpanded} />

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </View>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionCard({
  title, icon, children,
}: {
  title: string; icon: string; children: React.ReactNode;
}) {
  return (
    <View style={styles.sectionCard}>
      <View style={styles.sectionCardHeader}>
        <MaterialIcons name={icon as any} size={16} color={Colors.primary} />
        <Text style={styles.sectionCardTitle}>{title}</Text>
      </View>
      <View style={styles.sectionCardBody}>{children}</View>
    </View>
  );
}

function HighlightRow({ icon, label, sub }: { icon: string; label: string; sub: string }) {
  return (
    <View style={styles.highlightRow}>
      <View style={styles.highlightIcon}>
        <MaterialIcons name={icon as any} size={18} color={Colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.highlightLabel}>{label}</Text>
        <Text style={styles.highlightSub}>{sub}</Text>
      </View>
    </View>
  );
}

function BulletRow({ text, check }: { text: string; check?: boolean }) {
  return (
    <View style={styles.bulletRow}>
      <MaterialIcons
        name={check ? 'check' : 'close'}
        size={14}
        color={check ? Colors.success : Colors.error}
      />
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

function ReferralCard({
  code, copied, onCopy, onShare,
}: {
  code: string;
  copied: boolean;
  onCopy: () => void;
  onShare: () => void;
}) {
  return (
    <View style={styles.referralCard}>
      <Text style={styles.referralTitle}>Your Referral Code</Text>
      <View style={styles.referralCodeRow}>
        <Text style={styles.referralCode}>{code}</Text>
        <TouchableOpacity onPress={onCopy} style={styles.copyBtn} activeOpacity={0.7}>
          <MaterialIcons
            name={copied ? 'check' : 'content-copy'}
            size={18}
            color={copied ? Colors.success : Colors.primary}
          />
        </TouchableOpacity>
      </View>
      <Text style={styles.referralHint}>
        Ask customers to enter this code when they sign up on NumVault.
      </Text>
      <TouchableOpacity style={styles.shareBtn} onPress={onShare} activeOpacity={0.85}>
        <MaterialIcons name="share" size={16} color={Colors.black} />
        <Text style={styles.shareBtnText}>Share Referral Code</Text>
      </TouchableOpacity>
    </View>
  );
}

function CycleCard({
  cycleNum, count, complete, payout,
}: {
  cycleNum: 1 | 2;
  count: number;
  complete: boolean;
  payout?: LeadPayout;
}) {
  const progress = Math.min(count / 38, 1);
  return (
    <View style={[styles.cycleCard, complete && styles.cycleCardComplete]}>
      <View style={styles.cycleCardHeader}>
        <Text style={styles.cycleCardTitle}>Cycle {cycleNum} of 2</Text>
        {complete ? (
          <View style={styles.cycleCompleteBadge}>
            <MaterialIcons name="check-circle" size={12} color={Colors.success} />
            <Text style={styles.cycleCompleteBadgeText}>Complete</Text>
          </View>
        ) : (
          <Text style={styles.cycleActiveText}>In Progress</Text>
        )}
      </View>
      <View style={styles.cycleNumbers}>
        <Text style={styles.cycleCurrent}>{count}</Text>
        <Text style={styles.cycleSep}>/</Text>
        <Text style={styles.cycleTarget}>38 Customers</Text>
      </View>
      <View style={styles.progressBarTrack}>
        <View
          style={[
            styles.progressBarFill,
            { width: `${progress * 100}%`, backgroundColor: complete ? Colors.success : Colors.primary },
          ]}
        />
      </View>
      <View style={styles.cycleReward}>
        <MaterialIcons name="payments" size={14} color={Colors.primary} />
        <Text style={styles.cycleRewardText}>₦50,000 reward</Text>
        {payout && (
          <View style={[styles.payoutStatusBadge, { backgroundColor: payout.status === 'sent' ? Colors.successMuted : Colors.primaryMuted }]}>
            <Text style={[styles.payoutStatusText, { color: payout.status === 'sent' ? Colors.success : Colors.primary }]}>
              {payout.status === 'sent' ? 'Paid' : payout.status === 'failed' ? 'Failed' : 'Pending'}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

function PitchLibrarySection({
  pitches, expanded, onToggle,
}: {
  pitches: PitchItem[];
  expanded: string | null;
  onToggle: (id: string | null) => void;
}) {
  if (pitches.length === 0) return null;
  return (
    <View style={styles.pitchSection}>
      <Text style={styles.sectionHeader2}>Pitch Library</Text>
      <Text style={styles.pitchSub}>Ready-to-use talking points for different customer situations.</Text>
      {pitches.map((p) => {
        const open = expanded === p.id;
        return (
          <TouchableOpacity
            key={p.id}
            style={[styles.pitchCard, open && styles.pitchCardOpen]}
            onPress={() => onToggle(open ? null : p.id)}
            activeOpacity={0.8}
          >
            <View style={styles.pitchCardHeader}>
              <View style={styles.pitchAudienceBadge}>
                <Text style={styles.pitchAudience}>{p.audience}</Text>
              </View>
              <MaterialIcons
                name={open ? 'expand-less' : 'expand-more'}
                size={20}
                color={Colors.textSecondary}
              />
            </View>
            <Text style={styles.pitchHeadline}>{p.headline}</Text>
            {open && <Text style={styles.pitchBody}>{p.body}</Text>}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function getMonthWindowLabel(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  content: { padding: Spacing.lg, gap: Spacing.lg },

  heroCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    alignItems: 'center',
    gap: Spacing.md,
  },
  heroIcon: {
    width: 72, height: 72,
    borderRadius: 36,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1, borderColor: 'rgba(0,200,83,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  heroTitle: {
    color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold,
    textAlign: 'center', lineHeight: 28,
  },
  heroSub: {
    color: Colors.textSecondary, fontSize: FontSize.sm,
    textAlign: 'center', lineHeight: 22,
  },

  sectionCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg, overflow: 'hidden',
  },
  sectionCardHeader: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
    backgroundColor: Colors.surfaceElevated,
  },
  sectionCardTitle: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  sectionCardBody: { padding: Spacing.lg, gap: Spacing.sm },

  bodyText: { color: Colors.textSecondary, fontSize: FontSize.sm, lineHeight: 22 },

  highlightRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
  },
  highlightIcon: {
    width: 36, height: 36, borderRadius: Radius.sm,
    backgroundColor: Colors.primaryMuted,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  highlightLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  highlightSub: { color: Colors.textSecondary, fontSize: FontSize.xs, marginTop: 2 },

  bulletRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
    paddingVertical: 4,
  },
  bulletText: { flex: 1, color: Colors.textSecondary, fontSize: FontSize.sm, lineHeight: 20 },
  dividerLine: { height: 1, backgroundColor: Colors.surfaceBorder, marginVertical: Spacing.sm },

  ctaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.primary, borderRadius: Radius.md, height: 54,
  },
  ctaBtnDisabled: { opacity: 0.4 },
  ctaBtnText: { color: Colors.black, fontSize: FontSize.md, fontWeight: FontWeight.bold },

  formCard: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg, padding: Spacing.lg, gap: Spacing.sm,
  },
  formLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  formInput: {
    backgroundColor: Colors.surfaceElevated, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md, paddingHorizontal: Spacing.md, height: 50,
    color: Colors.text, fontSize: FontSize.md,
  },
  formHint: { color: Colors.textMuted, fontSize: FontSize.xs, lineHeight: 18 },

  ruleCard: {
    backgroundColor: Colors.surfaceElevated, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg, padding: Spacing.lg, gap: Spacing.sm,
  },
  ruleTitle: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.bold, marginBottom: 4 },
  ruleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  ruleText: { flex: 1, color: Colors.textSecondary, fontSize: FontSize.sm, lineHeight: 20 },

  backLink: { alignItems: 'center', paddingVertical: Spacing.sm },
  backLinkText: { color: Colors.textSecondary, fontSize: FontSize.sm },

  statusBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.primaryMuted, borderWidth: 1, borderColor: 'rgba(0,200,83,0.3)',
    borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 10,
  },
  statusBannerWarning: { backgroundColor: Colors.warningMuted, borderColor: Colors.warning },
  statusBannerText: { flex: 1, color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },

  progressCard: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.xl, padding: Spacing.xl, gap: Spacing.md,
  },
  progressLabel: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  progressNumbers: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  progressCurrent: { color: Colors.primary, fontSize: 42, fontWeight: FontWeight.bold },
  progressSep: { color: Colors.textMuted, fontSize: 28 },
  progressTarget: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  progressBarTrack: {
    height: 8, backgroundColor: Colors.surfaceElevated, borderRadius: 4, overflow: 'hidden',
  },
  progressBarFill: { height: '100%', backgroundColor: Colors.primary, borderRadius: 4 },
  progressMeta: { flexDirection: 'row', justifyContent: 'space-between' },
  progressMetaText: { color: Colors.textMuted, fontSize: FontSize.xs },

  referralCard: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.primary,
    borderRadius: Radius.lg, padding: Spacing.lg, gap: Spacing.md,
  },
  referralTitle: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  referralCodeRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.primaryMuted, borderRadius: Radius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
  },
  referralCode: {
    flex: 1, color: Colors.primary, fontSize: FontSize.xxl,
    fontWeight: FontWeight.bold, letterSpacing: 2,
  },
  copyBtn: { padding: 4 },
  referralHint: { color: Colors.textMuted, fontSize: FontSize.xs, lineHeight: 18 },
  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.primary, borderRadius: Radius.md, height: 46,
  },
  shareBtnText: { color: Colors.black, fontWeight: FontWeight.bold, fontSize: FontSize.sm },

  reEnrollBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.warning, borderRadius: Radius.md, height: 50,
  },
  reEnrollText: { color: Colors.black, fontWeight: FontWeight.bold, fontSize: FontSize.sm },

  pitchSection: { gap: Spacing.sm },
  sectionHeader2: {
    color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold, marginBottom: 4,
  },
  pitchSub: { color: Colors.textSecondary, fontSize: FontSize.sm, marginBottom: Spacing.sm },
  pitchCard: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg, padding: Spacing.md, gap: Spacing.sm,
  },
  pitchCardOpen: { borderColor: Colors.primary },
  pitchCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pitchAudienceBadge: {
    backgroundColor: Colors.primaryMuted, borderRadius: Radius.full,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  pitchAudience: { color: Colors.primary, fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  pitchHeadline: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, lineHeight: 20 },
  pitchBody: {
    color: Colors.textSecondary, fontSize: FontSize.sm, lineHeight: 22,
    borderTopWidth: 1, borderTopColor: Colors.surfaceBorder, paddingTop: Spacing.sm,
    marginTop: Spacing.xs,
  },

  onboardingCard: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.success,
    borderRadius: Radius.lg, padding: Spacing.lg, gap: Spacing.md,
  },
  onboardingTitle: { color: Colors.text, fontSize: FontSize.md, fontWeight: FontWeight.bold },
  onboardingText: { color: Colors.textSecondary, fontSize: FontSize.sm, lineHeight: 22 },

  cycleCard: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.xl, padding: Spacing.xl, gap: Spacing.md,
  },
  cycleCardComplete: { borderColor: Colors.success },
  cycleCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cycleCardTitle: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  cycleCompleteBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.successMuted, borderRadius: Radius.full,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  cycleCompleteBadgeText: { color: Colors.success, fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  cycleActiveText: { color: Colors.primary, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  cycleNumbers: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  cycleCurrent: { color: Colors.primary, fontSize: 36, fontWeight: FontWeight.bold },
  cycleSep: { color: Colors.textMuted, fontSize: 24 },
  cycleTarget: { color: Colors.text, fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  cycleReward: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  cycleRewardText: { color: Colors.textSecondary, fontSize: FontSize.sm, flex: 1 },
  payoutStatusBadge: { borderRadius: Radius.full, paddingHorizontal: 8, paddingVertical: 3 },
  payoutStatusText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },

  payoutSection: { gap: Spacing.sm },
  payoutRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md, padding: Spacing.md,
  },
  payoutIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  payoutLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  payoutMeta: { color: Colors.textSecondary, fontSize: FontSize.xs, marginTop: 2 },
  payoutAmount: { fontSize: FontSize.md, fontWeight: FontWeight.bold },
});
