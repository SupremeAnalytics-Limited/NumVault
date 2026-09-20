import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, Share, TextInput,
  KeyboardAvoidingView, Platform, Dimensions, Modal,
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

type Screen = 'landing' | 'enroll' | 'qualifying' | 'pending_review' | 'eligible' | 'bank_onboarding' | 'active_lead';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ── Launch state for acquisition landing ─────────────────────────────────────
// first_launch / downgraded → no skip allowed on any screen
// active_staff               → skip allowed on screens 1–3 only
type AcqLaunchState = 'first_launch' | 'downgraded' | 'active_staff';

const LANDING_STEPS = [
  {
    label: 'Screen 1',
    icon: 'business' as const,
    title: 'We build software that opens doors',
    body: 'SupremeAnalytics is a Nigerian software company. We build products that give everyday people — students, freelancers, and working professionals — access to the same digital opportunities as anyone else in the world.',
    highlights: null as null | { icon: string; label: string; sub: string }[],
    bullets: null as null | { text: string; check: boolean }[],
  },
  {
    label: 'Screen 2',
    icon: 'schedule' as const,
    title: 'A side income that fits your life',
    body: "Whether you're in school, at work, or building your own thing — we've created a way for you to earn on the side without changing anything about your routine. No office. No fixed hours. Just results.",
    highlights: null,
    bullets: null,
  },
  {
    label: 'Screen 3',
    icon: 'phone-android' as const,
    title: 'Protect your number. Power your business.',
    body: "NumVault gives you a dedicated number for any platform — one that's yours permanently, with no recurring fees. It keeps your personal number private while giving your business, clients, and online activities their own dedicated lines. 2,300+ services. One place. People need this every day — your job is to show them it exists.",
    highlights: null,
    bullets: null,
  },
  {
    label: 'Screen 4',
    icon: 'emoji-events' as const,
    title: 'Earn your Job Position with our company as a Customer Acquisition Lead',
    body: 'Refer 76 paying customers in 30 days and we officially bring you on as a Customer Acquisition Lead — a paid staff role with your own dashboard and up to ₦100,000 a month. This is how you start.',
    highlights: null,
    bullets: null,
  },
];

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

  const [landingStep, setLandingStep] = useState(0);
  const [acqLaunchState, setAcqLaunchState] = useState<AcqLaunchState>('first_launch');
  const landingScrollRef = useRef<ScrollView>(null);

  const [enrollName, setEnrollName] = useState('');
  const [enrolling, setEnrolling] = useState(false);

  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankList, setBankList] = useState<{ name: string; code: string }[]>([]);
  const [selectedBank, setSelectedBank] = useState<{ name: string; code: string } | null>(null);
  const [showBankPicker, setShowBankPicker] = useState(false);
  const [resolvedAccountName, setResolvedAccountName] = useState<string | null>(null);
  const [resolvingAccount, setResolvingAccount] = useState(false);
  const [savingBank, setSavingBank] = useState(false);

  const [pitchExpanded, setPitchExpanded] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => { loadAll(); }, []);

  // Resolve whether this user has an active qualifying/lead record
  const resolveAcqLaunchState = useCallback(async (p: AcquisitionParticipant | null) => {
    if (!p) { setAcqLaunchState('first_launch'); return; }
    const isActive =
      p.status === 'active_lead' ||
      p.status === 'eligible_not_joined' ||
      (p.status === 'qualifying' && p.qualification_customers_count > 0 && isWithin30Days(p.qualification_start_date));
    const isDowngraded =
      p.status === 'inactive' ||
      (p.status === 'qualifying' && !isWithin30Days(p.qualification_start_date));
    setAcqLaunchState(isActive ? 'active_staff' : isDowngraded ? 'downgraded' : 'first_launch');
  }, []);

  useEffect(() => {
    if (screen === 'bank_onboarding' && bankList.length === 0) loadBankList();
  }, [screen]);

  const loadAll = async () => {
    try {
      setLoading(true);
      const [p, lib] = await Promise.all([getMyParticipant(), getPitchLibrary()]);
      setPitches(lib);
      if (p) {
        setParticipant(p);
        resolveAcqLaunchState(p);
        const [refs, pays] = await Promise.all([getMyReferredCustomers(p.id), getMyPayouts(p.id)]);
        setReferred(refs);
        setPayouts(pays);
        setScreen(mapStatusToScreen(p));
      } else {
        resolveAcqLaunchState(null);
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
      case 'qualifying':
        return p.qualification_customers_count >= 76 ? 'pending_review' : 'qualifying';
      case 'eligible_not_joined': return 'eligible';
      case 'active_lead': return 'active_lead';
      default: return 'landing';
    }
  };

  const loadBankList = async () => {
    try {
      const supabase = (await import('@/template')).getSupabaseClient();
      const res = await supabase.functions.invoke('create-transfer-recipient', {
        body: { action: 'list_banks' },
      });
      if (res.data?.banks && Array.isArray(res.data.banks)) {
        setBankList(res.data.banks.map((b: any) => ({ name: b.name, code: b.code })));
      }
    } catch (e) {
      console.warn('Failed to load bank list:', e);
    }
  };

  const resolveAccount = async () => {
    if (!selectedBank || bankAccountNumber.length < 10) return;
    setResolvingAccount(true);
    setResolvedAccountName(null);
    try {
      const supabase = (await import('@/template')).getSupabaseClient();
      const res = await supabase.functions.invoke('create-transfer-recipient', {
        body: { action: 'resolve', account_number: bankAccountNumber, bank_code: selectedBank.code },
      });
      if (res.data?.account_name) {
        setResolvedAccountName(res.data.account_name);
      } else {
        showAlert('Account not found', 'Could not verify this account number. Please check the details.');
      }
    } catch (e) {
      showAlert('Error', 'Could not connect to bank verification service.');
    } finally {
      setResolvingAccount(false);
    }
  };

  const saveBankDetails = async () => {
    if (!participant || !selectedBank || !resolvedAccountName) return;
    setSavingBank(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const supabase = (await import('@/template')).getSupabaseClient();

      const recipientRes = await supabase.functions.invoke('create-transfer-recipient', {
        body: {
          action: 'create_recipient',
          participant_id: participant.id,
          account_number: bankAccountNumber,
          bank_code: selectedBank.code,
          bank_name: selectedBank.name,
          account_name: resolvedAccountName,
        },
      });

      const { error } = await supabase
        .from('acquisition_participants')
        .update({
          bank_account_number: bankAccountNumber,
          bank_code: selectedBank.code,
          bank_name: selectedBank.name,
          paystack_recipient_code: recipientRes.data?.recipient_code ?? null,
        })
        .eq('id', participant.id);

      if (error) throw new Error(error.message);

      showAlert('Bank Details Saved', 'Your bank account has been saved. The NumVault team will activate your Lead account.');
      await loadAll();
    } catch (e: any) {
      showAlert('Error', e.message || 'Failed to save bank details.');
    } finally {
      setSavingBank(false);
    }
  };

  const handleEnroll = async () => {
    if (!enrollName.trim()) { showAlert('Name required', 'Please enter your full name to enroll.'); return; }
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
    showAlert('Start a new 30-day attempt?', 'Your progress will reset to 0 / 76. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Re-enroll', style: 'default',
        onPress: async () => {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          try { await reEnrollInProgram(participant.id); await loadAll(); }
          catch (e: any) { showAlert('Error', e.message); }
        },
      },
    ]);
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
      message: `Sign up on NumVault and use my referral code: ${participant.referral_code}\n\nNumVault gives you private phone numbers for any app or service — pay as you go, no subscription.`,
      title: 'Join NumVault',
    });
  };

  const daysLeft = daysRemainingInQualification(participant?.qualification_start_date ?? null);
  const qualCount = participant?.qualification_customers_count ?? 0;
  const qualProgress = Math.min(qualCount / 76, 1);
  const windowExpired = daysLeft <= 0 && qualCount < 76 && participant?.status === 'qualifying';

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

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
          <MaterialIcons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Acquisition Program</Text>
        <View style={{ width: 36 }} />
      </View>

      {/* ── LANDING ── */}
      {screen === 'landing' && (
        <View style={{ flex: 1 }}>
          <ScrollView
            ref={landingScrollRef}
            horizontal pagingEnabled scrollEnabled={false}
            showsHorizontalScrollIndicator={false}
            style={{ flex: 1 }}
          >
            {LANDING_STEPS.map((step, i) => (
              <ScrollView key={i} style={{ width: SCREEN_WIDTH }} showsVerticalScrollIndicator={false} contentContainerStyle={styles.landingPage}>
                <View style={styles.landingIconRow}>
                  <View style={styles.landingIconWrap}>
                    <MaterialIcons name={step.icon} size={32} color={Colors.primary} />
                  </View>
                  <Text style={styles.landingStepLabel}>{step.label}</Text>
                </View>
                <Text style={styles.landingTitle}>{step.title}</Text>
                {step.body ? <Text style={styles.landingBody}>{step.body}</Text> : null}
                {step.highlights ? (
                  <View style={styles.landingCard}>
                    {step.highlights.map((h, hi) => (
                      <View key={hi} style={[styles.highlightRow, hi === step.highlights!.length - 1 && { borderBottomWidth: 0 }]}>
                        <View style={styles.highlightIcon}>
                          <MaterialIcons name={h.icon as any} size={18} color={Colors.primary} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.highlightLabel}>{h.label}</Text>
                          <Text style={styles.highlightSub}>{h.sub}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                ) : null}
                {step.bullets ? (
                  <View style={styles.landingCard}>
                    <Text style={[styles.landingBody, { marginBottom: Spacing.sm, fontWeight: FontWeight.semibold, color: Colors.text }]}>
                      A customer counts when they:
                    </Text>
                    {step.bullets.map((b, bi) => (
                      <View key={bi} style={styles.bulletRow}>
                        <MaterialIcons name={b.check ? 'check' : 'close'} size={14} color={b.check ? Colors.success : Colors.error} />
                        <Text style={styles.bulletText}>{b.text}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                <View style={{ height: 24 }} />
              </ScrollView>
            ))}
          </ScrollView>

          <View style={[styles.landingFooter, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.landingDots}>
              {LANDING_STEPS.map((_, i) => (
                <View key={i} style={[styles.landingDot, i === landingStep && styles.landingDotActive]} />
              ))}
            </View>
            <TouchableOpacity
              style={styles.ctaBtn}
              onPress={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                if (landingStep < LANDING_STEPS.length - 1) {
                  const next = landingStep + 1;
                  landingScrollRef.current?.scrollTo({ x: next * SCREEN_WIDTH, animated: true });
                  setLandingStep(next);
                } else {
                  setScreen('enroll');
                }
              }}
              activeOpacity={0.85}
            >
              <MaterialIcons name={landingStep < LANDING_STEPS.length - 1 ? 'arrow-forward' : 'rocket-launch'} size={18} color={Colors.black} />
              <Text style={styles.ctaBtnText}>
                {landingStep < LANDING_STEPS.length - 1 ? 'Continue' : 'Enroll in the Program'}
              </Text>
            </TouchableOpacity>
            {/* Skip — only active_staff, only on screens 1–3 (not screen 4) */}
            {acqLaunchState === 'active_staff' && landingStep < LANDING_STEPS.length - 1 ? (
              <TouchableOpacity
                style={styles.backLink}
                onPress={async () => {
                  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setScreen('enroll');
                }}
              >
                <Text style={styles.backLinkText}>Skip intro</Text>
              </TouchableOpacity>
            ) : landingStep > 0 ? (
              <TouchableOpacity
                style={styles.backLink}
                onPress={async () => {
                  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  const prev = landingStep - 1;
                  landingScrollRef.current?.scrollTo({ x: prev * SCREEN_WIDTH, animated: true });
                  setLandingStep(prev);
                }}
              >
                <Text style={styles.backLinkText}>Back</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      )}

      {/* ── ENROLL ── */}
      {screen === 'enroll' && (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
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
              <Text style={styles.formHint}>This name appears on your participant record and payout documents.</Text>
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
              {enrolling ? <ActivityIndicator color={Colors.black} /> : (
                <>
                  <MaterialIcons name="check-circle" size={18} color={Colors.black} />
                  <Text style={styles.ctaBtnText}>Start My 30-Day Qualification</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.backLink} onPress={() => { setLandingStep(0); setScreen('landing'); }}>
              <Text style={styles.backLinkText}>Back</Text>
            </TouchableOpacity>
            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* ── QUALIFYING ── */}
      {screen === 'qualifying' && participant && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <View style={[styles.statusBanner, windowExpired && styles.statusBannerWarning]}>
            <MaterialIcons name={windowExpired ? 'timer-off' : 'schedule'} size={16} color={windowExpired ? Colors.warning : Colors.primary} />
            <Text style={[styles.statusBannerText, windowExpired && { color: Colors.warning }]}>
              {windowExpired
                ? 'Your 30-day window has expired — enroll again to start a new attempt.'
                : `Qualifying · ${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining`}
            </Text>
          </View>

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
              <Text style={styles.progressMetaText}>{windowExpired ? 'Window expired' : `${daysLeft}d left`}</Text>
            </View>
          </View>

          <ReferralCard code={participant.referral_code} copied={copiedCode} onCopy={copyCode} onShare={shareCode} />

          {windowExpired ? (
            <TouchableOpacity style={styles.reEnrollBtn} onPress={handleReEnroll} activeOpacity={0.85}>
              <MaterialIcons name="refresh" size={18} color={Colors.black} />
              <Text style={styles.reEnrollText}>Enroll Again (Reset 0/76)</Text>
            </TouchableOpacity>
          ) : null}

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

          <ReferralCard code={participant.referral_code} copied={copiedCode} onCopy={copyCode} onShare={shareCode} />

          <SectionCard title="What Happens Next" icon="schedule">
            <HighlightRow icon="manage-search" label="Admin reviews your 76 customers" sub="Checking for distinct accounts and genuine purchases" />
            <HighlightRow icon="check-circle" label="Approval → Paid Lead invitation" sub="You will be notified and asked to complete onboarding" />
            <HighlightRow icon="block" label="Rejection → Frozen at 76/76" sub="You can remain in review/appeal until resolved" />
          </SectionCard>
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ── ELIGIBLE ── */}
      {screen === 'eligible' && participant && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <View style={styles.heroCard}>
            <View style={[styles.heroIcon, { backgroundColor: Colors.successMuted }]}>
              <MaterialIcons name="verified" size={36} color={Colors.success} />
            </View>
            <Text style={styles.heroTitle}>Eligibility Approved!</Text>
            <Text style={styles.heroSub}>
              Congratulations — you qualified for the paid NumVault Lead opportunity. Set up your bank account to receive payouts.
            </Text>
          </View>

          <SectionCard title="Your Paid Lead Opportunity" icon="emoji-events">
            <HighlightRow icon="payments" label="₦50,000 per completed cycle" sub="Each cycle = 38 validated customers" />
            <HighlightRow icon="calendar-today" label="Up to ₦100,000/month" sub="Maximum 2 cycles per calendar month" />
            <HighlightRow icon="event-available" label="6 monthly windows" sub="₦600,000 maximum total over the program" />
          </SectionCard>

          <TouchableOpacity style={styles.ctaBtn} onPress={() => setScreen('bank_onboarding')} activeOpacity={0.85}>
            <MaterialIcons name="account-balance" size={18} color={Colors.black} />
            <Text style={styles.ctaBtnText}>Set Up Bank Account</Text>
          </TouchableOpacity>
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ── BANK ONBOARDING ── */}
      {screen === 'bank_onboarding' && participant && (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
            <View style={styles.heroCard}>
              <View style={[styles.heroIcon, { backgroundColor: Colors.primaryMuted }]}>
                <MaterialIcons name="account-balance" size={36} color={Colors.primary} />
              </View>
              <Text style={styles.heroTitle}>Bank Account Setup</Text>
              <Text style={styles.heroSub}>This account will receive your Lead payouts of ₦50,000 per completed cycle.</Text>
            </View>

            <View style={styles.formCard}>
              <Text style={styles.formLabel}>Account Number</Text>
              <TextInput
                style={styles.formInput}
                value={bankAccountNumber}
                onChangeText={(t) => { setBankAccountNumber(t.replace(/\D/g, '').slice(0, 10)); setResolvedAccountName(null); }}
                placeholder="10-digit account number"
                placeholderTextColor={Colors.textMuted}
                keyboardType="number-pad"
                maxLength={10}
              />

              <Text style={[styles.formLabel, { marginTop: Spacing.md }]}>Bank</Text>
              <TouchableOpacity style={[styles.formInput, { justifyContent: 'center' }]} onPress={() => setShowBankPicker(true)} activeOpacity={0.8}>
                <Text style={{ color: selectedBank ? Colors.text : Colors.textMuted, fontSize: FontSize.md }}>
                  {selectedBank ? selectedBank.name : 'Select your bank'}
                </Text>
              </TouchableOpacity>

              {bankAccountNumber.length === 10 && selectedBank ? (
                <TouchableOpacity
                  style={[styles.ctaBtn, { marginTop: Spacing.md }, resolvingAccount && styles.ctaBtnDisabled]}
                  onPress={resolveAccount}
                  disabled={resolvingAccount}
                  activeOpacity={0.85}
                >
                  {resolvingAccount ? <ActivityIndicator color={Colors.black} /> : (
                    <>
                      <MaterialIcons name="verified-user" size={18} color={Colors.black} />
                      <Text style={styles.ctaBtnText}>Verify Account</Text>
                    </>
                  )}
                </TouchableOpacity>
              ) : null}

              {resolvedAccountName ? (
                <View style={[styles.statusBanner, { marginTop: Spacing.md }]}>
                  <MaterialIcons name="check-circle" size={16} color={Colors.primary} />
                  <Text style={styles.statusBannerText}>{resolvedAccountName}</Text>
                </View>
              ) : null}

              <Text style={styles.formHint}>Must be in your name. Payouts are transferred directly to this account.</Text>
            </View>

            <TouchableOpacity
              style={[styles.ctaBtn, (!resolvedAccountName || savingBank) && styles.ctaBtnDisabled]}
              onPress={saveBankDetails}
              disabled={!resolvedAccountName || savingBank}
              activeOpacity={0.85}
            >
              {savingBank ? <ActivityIndicator color={Colors.black} /> : (
                <>
                  <MaterialIcons name="save" size={18} color={Colors.black} />
                  <Text style={styles.ctaBtnText}>Save Bank Details</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.backLink} onPress={() => setScreen('eligible')}>
              <Text style={styles.backLinkText}>Back</Text>
            </TouchableOpacity>
            <View style={{ height: 40 }} />
          </ScrollView>

          <Modal visible={showBankPicker} animationType="slide" onRequestClose={() => setShowBankPicker(false)}>
            <View style={[styles.container, { paddingTop: insets.top }]}>
              <View style={styles.header}>
                <TouchableOpacity style={styles.backBtn} onPress={() => setShowBankPicker(false)} activeOpacity={0.7}>
                  <MaterialIcons name="close" size={22} color={Colors.text} />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>Select Bank</Text>
                <View style={{ width: 36 }} />
              </View>
              <ScrollView showsVerticalScrollIndicator={false}>
                {bankList.length === 0 ? (
                  <View style={[styles.center, { padding: Spacing.xl }]}>
                    <ActivityIndicator color={Colors.primary} />
                    <Text style={[styles.formHint, { marginTop: Spacing.sm }]}>Loading banks...</Text>
                  </View>
                ) : (
                  bankList.map((bank) => (
                    <TouchableOpacity
                      key={bank.code}
                      style={[styles.bankRow, selectedBank?.code === bank.code && styles.bankRowSelected]}
                      onPress={() => { setSelectedBank(bank); setResolvedAccountName(null); setShowBankPicker(false); }}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.bankName, selectedBank?.code === bank.code && { color: Colors.primary }]}>{bank.name}</Text>
                      {selectedBank?.code === bank.code ? <MaterialIcons name="check" size={16} color={Colors.primary} /> : null}
                    </TouchableOpacity>
                  ))
                )}
              </ScrollView>
            </View>
          </Modal>
        </KeyboardAvoidingView>
      )}

      {/* ── ACTIVE LEAD ── */}
      {screen === 'active_lead' && participant && cycleProgress && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <View style={[styles.statusBanner, { borderColor: Colors.success }]}>
            <MaterialIcons name="star" size={16} color={Colors.success} />
            <Text style={[styles.statusBannerText, { color: Colors.success }]}>
              Active NumVault Lead · {cycleProgress.monthLabel}
            </Text>
          </View>

          <CycleCard
            cycleNum={1} count={cycleProgress.cycle1Count} complete={cycleProgress.cycle1Complete}
            payout={payouts.find((p) => p.cycle_number === 1 && p.monthly_window_start === cycleProgress.windowStart)}
          />
          {cycleProgress.cycle1Complete ? (
            <CycleCard
              cycleNum={2} count={cycleProgress.cycle2Count} complete={cycleProgress.cycle2Complete}
              payout={payouts.find((p) => p.cycle_number === 2 && p.monthly_window_start === cycleProgress.windowStart)}
            />
          ) : null}

          <ReferralCard code={participant.referral_code} copied={copiedCode} onCopy={copyCode} onShare={shareCode} />

          {payouts.length > 0 ? (
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
                    <Text style={styles.payoutLabel}>Cycle {pout.cycle_number} · {getMonthWindowLabel(pout.monthly_window_start)}</Text>
                    <Text style={styles.payoutMeta}>
                      {pout.status === 'sent' ? `Sent ${new Date(pout.sent_at!).toLocaleDateString()}` : pout.status === 'failed' ? (pout.failure_reason || 'Transfer failed') : 'Pending transfer'}
                    </Text>
                  </View>
                  <Text style={[styles.payoutAmount, { color: pout.status === 'sent' ? Colors.success : Colors.text }]}>
                    ₦{Number(pout.amount).toLocaleString()}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <PitchLibrarySection pitches={pitches} expanded={pitchExpanded} onToggle={setPitchExpanded} />
          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </View>
  );
}

function isWithin30Days(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false;
  const start = new Date(dateStr).getTime();
  return Date.now() < start + 30 * 24 * 60 * 60 * 1000;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionCard({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
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

function ReferralCard({ code, copied, onCopy, onShare }: { code: string; copied: boolean; onCopy: () => void; onShare: () => void }) {
  return (
    <View style={styles.referralCard}>
      <Text style={styles.referralTitle}>Your Referral Code</Text>
      <View style={styles.referralCodeRow}>
        <Text style={styles.referralCode}>{code}</Text>
        <TouchableOpacity onPress={onCopy} style={styles.copyBtn} activeOpacity={0.7}>
          <MaterialIcons name={copied ? 'check' : 'content-copy'} size={18} color={copied ? Colors.success : Colors.primary} />
        </TouchableOpacity>
      </View>
      <Text style={styles.referralHint}>Ask customers to enter this code when they sign up on NumVault.</Text>
      <TouchableOpacity style={styles.shareBtn} onPress={onShare} activeOpacity={0.85}>
        <MaterialIcons name="share" size={16} color={Colors.black} />
        <Text style={styles.shareBtnText}>Share Referral Code</Text>
      </TouchableOpacity>
    </View>
  );
}

function CycleCard({ cycleNum, count, complete, payout }: { cycleNum: 1 | 2; count: number; complete: boolean; payout?: LeadPayout }) {
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
        ) : <Text style={styles.cycleActiveText}>In Progress</Text>}
      </View>
      <View style={styles.cycleNumbers}>
        <Text style={styles.cycleCurrent}>{count}</Text>
        <Text style={styles.cycleSep}>/</Text>
        <Text style={styles.cycleTarget}>38 Customers</Text>
      </View>
      <View style={styles.progressBarTrack}>
        <View style={[styles.progressBarFill, { width: `${progress * 100}%`, backgroundColor: complete ? Colors.success : Colors.primary }]} />
      </View>
      <View style={styles.cycleReward}>
        <MaterialIcons name="payments" size={14} color={Colors.primary} />
        <Text style={styles.cycleRewardText}>₦50,000 reward</Text>
        {payout ? (
          <View style={[styles.payoutStatusBadge, { backgroundColor: payout.status === 'sent' ? Colors.successMuted : Colors.primaryMuted }]}>
            <Text style={[styles.payoutStatusText, { color: payout.status === 'sent' ? Colors.success : Colors.primary }]}>
              {payout.status === 'sent' ? 'Paid' : payout.status === 'failed' ? 'Failed' : 'Pending'}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function PitchLibrarySection({ pitches, expanded, onToggle }: { pitches: PitchItem[]; expanded: string | null; onToggle: (id: string | null) => void }) {
  if (pitches.length === 0) return null;
  return (
    <View style={styles.pitchSection}>
      <Text style={styles.sectionHeader2}>Pitch Library</Text>
      <Text style={styles.pitchSub}>Ready-to-use talking points for different customer situations.</Text>
      {pitches.map((p) => {
        const open = expanded === p.id;
        return (
          <TouchableOpacity key={p.id} style={[styles.pitchCard, open && styles.pitchCardOpen]} onPress={() => onToggle(open ? null : p.id)} activeOpacity={0.8}>
            <View style={styles.pitchCardHeader}>
              <View style={styles.pitchAudienceBadge}><Text style={styles.pitchAudience}>{p.audience}</Text></View>
              <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={20} color={Colors.textSecondary} />
            </View>
            <Text style={styles.pitchHeadline}>{p.headline}</Text>
            {open ? <Text style={styles.pitchBody}>{p.body}</Text> : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function getMonthWindowLabel(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  backBtn: { width: 36, height: 36, borderRadius: Radius.md, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  content: { padding: Spacing.lg, gap: Spacing.lg },

  landingPage: { width: SCREEN_WIDTH, padding: Spacing.lg, paddingTop: Spacing.xl, gap: Spacing.lg },
  landingIconRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  landingIconWrap: { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.primaryMuted, borderWidth: 1, borderColor: 'rgba(0,200,83,0.25)', alignItems: 'center', justifyContent: 'center' },
  landingStepLabel: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.bold, letterSpacing: 1.2, textTransform: 'uppercase' },
  landingTitle: { color: Colors.text, fontSize: FontSize.xxl, fontWeight: FontWeight.bold, lineHeight: 32 },
  landingBody: { color: Colors.textSecondary, fontSize: FontSize.md, lineHeight: 26 },
  landingCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: Radius.lg, padding: Spacing.md, gap: Spacing.xs },
  landingFooter: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, gap: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.surfaceBorder, backgroundColor: Colors.background },
  landingDots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginBottom: Spacing.sm },
  landingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.surfaceBorder },
  landingDotActive: { width: 20, backgroundColor: Colors.primary },

  heroCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: Radius.xl, padding: Spacing.xl, alignItems: 'center', gap: Spacing.md },
  heroIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: Colors.primaryMuted, borderWidth: 1, borderColor: 'rgba(0,200,83,0.25)', alignItems: 'center', justifyContent: 'center' },
  heroTitle: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold, textAlign: 'center', lineHeight: 28 },
  heroSub: { color: Colors.textSecondary, fontSize: FontSize.sm, textAlign: 'center', lineHeight: 22 },

  sectionCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: Radius.lg, overflow: 'hidden' },
  sectionCardHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder, backgroundColor: Colors.surfaceElevated },
  sectionCardTitle: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  sectionCardBody: { padding: Spacing.lg, gap: Spacing.sm },

  highlightRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md, paddingVertical: Spacing.sm, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder },
  highlightIcon: { width: 36, height: 36, borderRadius: Radius.sm, backgroundColor: Colors.primaryMuted, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  highlightLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  highlightSub: { color: Colors.textSecondary, fontSize: FontSize.xs, marginTop: 2 },

  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm, paddingVertical: 4 },
  bulletText: { flex: 1, color: Colors.textSecondary, fontSize: FontSize.sm, lineHeight: 20 },

  ctaBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, backgroundColor: Colors.primary, borderRadius: Radius.md, height: 54 },
  ctaBtnDisabled: { opacity: 0.4 },
  ctaBtnText: { color: Colors.black, fontSize: FontSize.md, fontWeight: FontWeight.bold },

  formCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: Radius.lg, padding: Spacing.lg, gap: Spacing.sm },
  formLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  formInput: { backgroundColor: Colors.surfaceElevated, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: Radius.md, paddingHorizontal: Spacing.md, height: 50, color: Colors.text, fontSize: FontSize.md },
  formHint: { color: Colors.textMuted, fontSize: FontSize.xs, lineHeight: 18 },

  ruleCard: { backgroundColor: Colors.surfaceElevated, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: Radius.lg, padding: Spacing.lg, gap: Spacing.sm },
  ruleTitle: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.bold, marginBottom: 4 },
  ruleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  ruleText: { flex: 1, color: Colors.textSecondary, fontSize: FontSize.sm, lineHeight: 20 },

  backLink: { alignItems: 'center', paddingVertical: Spacing.sm },
  backLinkText: { color: Colors.textSecondary, fontSize: FontSize.sm },

  statusBanner: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: Colors.primaryMuted, borderWidth: 1, borderColor: 'rgba(0,200,83,0.3)', borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 10 },
  statusBannerWarning: { backgroundColor: Colors.warningMuted, borderColor: Colors.warning },
  statusBannerText: { flex: 1, color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },

  progressCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: Radius.xl, padding: Spacing.xl, gap: Spacing.md },
  progressLabel: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  progressNumbers: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  progressCurrent: { color: Colors.primary, fontSize: 42, fontWeight: FontWeight.bold },
  progressSep: { color: Colors.textMuted, fontSize: 28 },
  progressTarget: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  progressBarTrack: { height: 8, backgroundColor: Colors.surfaceElevated, borderRadius: 4, overflow: 'hidden' },
  progressBarFill: { height: '100%', backgroundColor: Colors.primary, borderRadius: 4 },
  progressMeta: { flexDirection: 'row', justifyContent: 'space-between' },
  progressMetaText: { color: Colors.textMuted, fontSize: FontSize.xs },

  referralCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.primary, borderRadius: Radius.lg, padding: Spacing.lg, gap: Spacing.md },
  referralTitle: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  referralCodeRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.primaryMuted, borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.md },
  referralCode: { flex: 1, color: Colors.primary, fontSize: FontSize.xxl, fontWeight: FontWeight.bold, letterSpacing: 2 },
  copyBtn: { padding: 4 },
  referralHint: { color: Colors.textMuted, fontSize: FontSize.xs, lineHeight: 18 },
  shareBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, backgroundColor: Colors.primary, borderRadius: Radius.md, height: 46 },
  shareBtnText: { color: Colors.black, fontWeight: FontWeight.bold, fontSize: FontSize.sm },

  reEnrollBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, backgroundColor: Colors.warning, borderRadius: Radius.md, height: 50 },
  reEnrollText: { color: Colors.black, fontWeight: FontWeight.bold, fontSize: FontSize.sm },

  bankRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder },
  bankRowSelected: { backgroundColor: Colors.primaryMuted },
  bankName: { color: Colors.text, fontSize: FontSize.sm, flex: 1, paddingRight: Spacing.sm },

  cycleCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: Radius.xl, padding: Spacing.xl, gap: Spacing.md },
  cycleCardComplete: { borderColor: Colors.success },
  cycleCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cycleCardTitle: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  cycleCompleteBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.successMuted, borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  cycleCompleteBadgeText: { color: Colors.success, fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  cycleActiveText: { color: Colors.primary, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  cycleNumbers: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  cycleCurrent: { color: Colors.primary, fontSize: 36, fontWeight: FontWeight.bold },
  cycleSep: { color: Colors.textMuted, fontSize: 24 },
  cycleTarget: { color: Colors.text, fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  cycleReward: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.xs },
  cycleRewardText: { color: Colors.textSecondary, fontSize: FontSize.sm, flex: 1 },
  payoutStatusBadge: { borderRadius: Radius.full, paddingHorizontal: 8, paddingVertical: 3 },
  payoutStatusText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },

  pitchSection: { gap: Spacing.sm },
  sectionHeader2: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold, marginBottom: 4 },
  pitchSub: { color: Colors.textSecondary, fontSize: FontSize.sm, marginBottom: Spacing.sm },
  pitchCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: Radius.lg, padding: Spacing.md, gap: Spacing.sm },
  pitchCardOpen: { borderColor: Colors.primary },
  pitchCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pitchAudienceBadge: { backgroundColor: Colors.primaryMuted, borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  pitchAudience: { color: Colors.primary, fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  pitchHeadline: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, lineHeight: 20 },
  pitchBody: { color: Colors.textSecondary, fontSize: FontSize.sm, lineHeight: 22, borderTopWidth: 1, borderTopColor: Colors.surfaceBorder, paddingTop: Spacing.sm, marginTop: Spacing.xs },

  payoutSection: { gap: Spacing.sm },
  payoutRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: Radius.md, padding: Spacing.md },
  payoutIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  payoutLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  payoutMeta: { color: Colors.textSecondary, fontSize: FontSize.xs, marginTop: 2 },
  payoutAmount: { fontSize: FontSize.md, fontWeight: FontWeight.bold },
});
