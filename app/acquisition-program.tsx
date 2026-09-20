import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, Share, TextInput,
  KeyboardAvoidingView, Platform, Dimensions, Modal, Animated,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { useAlert } from '@/template';
import {
  AcquisitionParticipant, ReferredCustomer, PitchItem, LeadPayout,
  getMyParticipant, enrollInProgram, reEnrollInProgram,
  getMyReferredCustomers, getPitchLibrary,
  daysRemainingInQualification, getMyPayouts,
  computeCycleProgress, paidPeriodsRemaining,
  currentBlockNumber, daysRemainingInCurrentWindow, closeMyExpiredBlocks,
} from '@/services/acquisitionService';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

type Screen = 'landing' | 'enroll' | 'dashboard' | 'bank_onboarding';
type DashTab = 'proving' | 'onteam';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

type AcqLaunchState = 'first_launch' | 'downgraded' | 'active_staff';

const LANDING_STEPS = [
  {
    label: 'Side income',
    icon: 'schedule' as const,
    title: 'A side income that fits your life',
    body: "Whether you're in school, at work, or building your own thing — we've created a way for you to earn on the side without changing anything about your routine. No office. No fixed hours. Just results.",
  },
  {
    label: 'NumVault product',
    icon: 'phone-android' as const,
    title: 'Protect your number. Power your business.',
    body: "NumVault gives you a dedicated number for any platform — one that's yours permanently, with no recurring fees. It keeps your personal number private while giving your businesses their own dedicated phone numbers across 2,300+ apps and services. This protects your private contact information from data reselling and spam messages from other platforms.",
  },
  {
    label: 'Customer Acquisition Lead commitment',
    icon: 'emoji-events' as const,
    title: 'Earn your Job Position with our company as a Customer Acquisition Lead',
    body: 'You are a Brand Ambassador for NumVault. Share your referral code. A referral counts when a new customer signs up with your code and pays for at least one number. Each customer must have a different email address and counts once. Your first 76 customers are an unpaid qualification, and you have 30 days to reach them. At 76 you are brought on automatically as a Customer Acquisition Lead and your Staff Dashboard opens. Each month, 76 customers earns you ₦100,000, paid in two halves of ₦50,000. You have 30 days for each month, and if you reach 76 sooner your next month starts straight away. The contract is for six months, for up to ₦600,000 in total. Every payout is reviewed before it is sent. We pay by Paystack to Nigerian bank accounts, including Palmpay, Kuda and Opay. No card details. If you want to extend your contract beyond six months, email support@numvault.cloud.',
  },
];

const QUAL_RULES = [
  "Refer 76 paying customers within 30 days. This stage is unpaid.",
  "Go at your own pace. No daily targets.",
  "If your 30 days run out before you reach 76, your count resets to 0 and you can start again.",
];

const PAID_RULES = [
  "You earn for every paying customer you refer, whether it is 1 or 76.",
  "At 38 customers a half payout (₦50,000) goes under review. At 76, the second half (₦50,000) goes under review and your next month starts immediately. Every payout is checked before it is sent.",
  "Didn't hit 76 this month? You still get paid for every customer you brought in. Re-qualify to start again.",
];

// ── Payout status display ────────────────────────────────────────────────────

function payoutStatusLabel(status: string): { text: string; color: string; desc: string } {
  switch (status) {
    case 'under_review':
      return { text: 'Under review', color: '#fbbf24', desc: 'We are checking these customers. We will notify you when it is approved.' };
    case 'approved':
      return { text: 'Approved', color: '#60a5fa', desc: 'Approved. Your payment is on its way.' };
    case 'sent':
      return { text: 'Paid', color: '#4ade80', desc: '' };
    case 'held':
      return { text: 'Held', color: '#fb923c', desc: 'Needs more review. Contact support.' };
    case 'failed':
      return { text: 'Failed', color: '#f87171', desc: 'There was a payment problem. We are retrying.' };
    case 'pending':
      return { text: 'Under review', color: '#fbbf24', desc: 'We are checking these customers. We will notify you when it is approved.' };
    default:
      return { text: status, color: '#4a7a4a', desc: '' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

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
  const [dashTab, setDashTab] = useState<DashTab>('proving');

  // Landing
  const [landingStep, setLandingStep] = useState(0);
  const [acqLaunchState, setAcqLaunchState] = useState<AcqLaunchState>('first_launch');
  const landingScrollRef = useRef<ScrollView>(null);
  const [destinationScreen, setDestinationScreen] = useState<Screen>('enroll');

  // Enroll
  const [enrollName, setEnrollName] = useState('');
  const [enrolling, setEnrolling] = useState(false);

  // Dashboard UI state
  const [reqOpen, setReqOpen] = useState(false);
  const [c2Open, setC2Open] = useState(false);
  const [pitchOpen, setPitchOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const welcomeOpacity = useRef(new Animated.Value(0)).current;

  // Bank onboarding
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankList, setBankList] = useState<{ name: string; code: string }[]>([]);
  const [selectedBank, setSelectedBank] = useState<{ name: string; code: string } | null>(null);
  const [showBankPicker, setShowBankPicker] = useState(false);
  const [resolvedAccountName, setResolvedAccountName] = useState<string | null>(null);
  const [resolvingAccount, setResolvingAccount] = useState(false);
  const [savingBank, setSavingBank] = useState(false);

  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => { loadAll(); }, []);

  // ── Auto-refresh polling ─────────────────────────────────────────────────────
  useEffect(() => {
    if (screen !== 'dashboard' || !participant) return;
    const interval = setInterval(async () => {
      try {
        const [freshP, freshRefs, freshPays] = await Promise.all([
          getMyParticipant(),
          getMyReferredCustomers(participant.id),
          getMyPayouts(participant.id),
        ]);
        if (freshP) setParticipant(freshP);
        if (freshRefs) setReferred(freshRefs);
        if (freshPays) setPayouts(freshPays as LeadPayout[]);
      } catch { /* silent */ }
    }, 30_000);
    return () => clearInterval(interval);
  }, [screen, participant?.id]);

  useEffect(() => {
    if (screen === 'bank_onboarding' && bankList.length === 0) loadBankList();
  }, [screen]);

  const resolveAcqLaunchState = useCallback((p: AcquisitionParticipant | null) => {
    if (!p) { setAcqLaunchState('first_launch'); return; }
    const isActive =
      p.status === 'active_lead' ||
      (p.status === 'qualifying' && p.qualification_customers_count > 0 && isWithin30Days(p.qualification_start_date));
    const isDowngraded =
      p.status === 'inactive' || p.status === 'needs_requalification' ||
      (p.status === 'qualifying' && !isWithin30Days(p.qualification_start_date));
    setAcqLaunchState(isActive ? 'active_staff' : isDowngraded ? 'downgraded' : 'first_launch');
  }, []);

  const loadAll = async () => {
    try {
      setLoading(true);
      // Close expired blocks before loading data
      await closeMyExpiredBlocks().catch(() => {});
      const [p, lib] = await Promise.all([getMyParticipant(), getPitchLibrary()]);
      setPitches(lib);
      if (p) {
        setParticipant(p);
        resolveAcqLaunchState(p);
        setDestinationScreen('dashboard');
        if (p.status === 'active_lead' || p.status === 'contract_complete') setDashTab('onteam');
        else setDashTab('proving');
        const [refs, pays] = await Promise.all([getMyReferredCustomers(p.id), getMyPayouts(p.id)]);
        setReferred(refs);
        setPayouts(pays as LeadPayout[]);
        setScreen('landing');
      } else {
        resolveAcqLaunchState(null);
        setDestinationScreen('enroll');
        setScreen('landing');
      }
    } catch (e) {
      console.error('AcquisitionProgram load error', e);
    } finally {
      setLoading(false);
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
    } catch {
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
      showAlert('Bank Details Saved', 'Your bank account has been saved. You can now receive payouts.');
      await loadAll();
      setScreen('dashboard');
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
      setDashTab('proving');
      setScreen('dashboard');
      (async () => {
        try {
          const { getSupabaseClient } = await import('@/template');
          const supabase = getSupabaseClient();
          await supabase.functions.invoke('notify-admin', {
            body: { action: 'enrollment', participant_name: enrollName.trim() },
          });
        } catch { /* non-blocking */ }
      })();
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
      message: `Sign up on NumVault and use my referral code: ${participant.referral_code}\n\nNumVault gives you a private phone number for any app or service — pay as you go, no subscription.`,
      title: 'Join NumVault',
    });
  };

  const triggerWelcome = () => {
    setShowWelcome(true);
    Animated.timing(welcomeOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  };

  const dismissWelcome = () => {
    Animated.timing(welcomeOpacity, { toValue: 0, duration: 250, useNativeDriver: true }).start(() => {
      setShowWelcome(false);
      // Show bank onboarding if no bank details yet
      if (!participant?.bank_account_number) {
        setScreen('bank_onboarding');
      }
    });
  };

  // ── Derived state ────────────────────────────────────────────────────────────
  const isQualified = participant?.status === 'active_lead' || participant?.status === 'contract_complete';
  const qualCount = participant?.qualification_customers_count ?? 0;

  // Switch to onteam tab automatically if participant becomes qualified while screen is open
  useEffect(() => {
    if (isQualified) setDashTab('onteam');
  }, [isQualified]);

  // For qualifying tab: daysLeft is from qualification_start_date
  // For active_lead tab: daysLeft is from paid_period_start_date
  const daysLeft = daysRemainingInCurrentWindow(participant ?? { status: 'qualifying', qualification_start_date: null, paid_period_start_date: null } as unknown as AcquisitionParticipant);
  const windowExpired =
    daysLeft <= 0 &&
    (participant?.status === 'qualifying' || participant?.status === 'needs_requalification') &&
    qualCount < 76;

  const blockNum = participant ? currentBlockNumber(participant) : 1;
  const monthsRemaining = paidPeriodsRemaining(participant ?? { paid_periods_completed: 0 } as AcquisitionParticipant);
  const potentialRemaining = monthsRemaining * 100000;

  // Cycle counts from referred customers for current block
  const cycleProgress = participant?.status === 'active_lead' && participant.paid_period_start_date
    ? computeCycleProgress(referred, participant.paid_period_start_date, blockNum)
    : null;

  const c1 = cycleProgress?.cycle1Count ?? Math.min(qualCount, 38);
  const c2 = cycleProgress?.cycle2Count ?? Math.max(0, qualCount - 38);

  // Under review payouts for banner
  const underReviewPayouts = payouts.filter((p) => p.status === 'under_review' || p.status === 'approved');
  const underReviewTotal = underReviewPayouts.reduce((s, p) => s + Number(p.amount), 0);

  // Whether to show bank details screen: active_lead with no bank on file
  const needsBankDetails = participant?.status === 'active_lead' && !participant?.bank_account_number;

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={GREEN} size="large" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0d0a" />

      {/* ── WELCOME OVERLAY (fires at 76th qualification customer) ── */}
      {showWelcome ? (
        <Animated.View style={[styles.welcomeOverlay, { opacity: welcomeOpacity }]}>
          <Text style={styles.welcomeEmoji}>🎉</Text>
          <Text style={styles.welcomeTitle}>You did it.</Text>
          <Text style={styles.welcomeSub}>
            76 customers referred. You have proven yourself. Welcome to the NumVault team. Your Staff Dashboard is now active.
          </Text>
          <TouchableOpacity style={styles.welcomeBtn} onPress={dismissWelcome} activeOpacity={0.85}>
            <Text style={styles.welcomeBtnText}>Set up my bank account</Text>
          </TouchableOpacity>
        </Animated.View>
      ) : null}

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
          <MaterialIcons name="arrow-back" size={22} color={GREEN} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Customer Acquisition Lead</Text>
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
              <ScrollView key={i} style={{ width: SCREEN_WIDTH }} showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.landingPage}>
                <View style={styles.landingIconRow}>
                  <View style={styles.landingIconWrap}>
                    <MaterialIcons name={step.icon} size={32} color={GREEN} />
                  </View>
                  <Text style={styles.landingStepLabel}>{step.label}</Text>
                </View>
                <Text style={styles.landingTitle}>{step.title}</Text>
                <Text style={styles.landingBody}>{step.body}</Text>
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
                  // If active_lead and no bank details, show bank onboarding
                  if (needsBankDetails) {
                    setScreen('bank_onboarding');
                  } else {
                    setScreen(destinationScreen);
                  }
                }
              }}
              activeOpacity={0.85}
            >
              <Text style={styles.ctaBtnText}>
                {landingStep < LANDING_STEPS.length - 1
                  ? 'Next'
                  : participant ? 'View My Progress' : 'Become an Ambassador'}
              </Text>
            </TouchableOpacity>
            {participant ? (
              <TouchableOpacity style={styles.backLink}
                onPress={async () => {
                  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  if (needsBankDetails) setScreen('bank_onboarding');
                  else setScreen('dashboard');
                }}>
                <Text style={styles.backLinkText}>Skip to my dashboard</Text>
              </TouchableOpacity>
            ) : landingStep > 0 ? (
              <TouchableOpacity style={styles.backLink}
                onPress={async () => {
                  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  const prev = landingStep - 1;
                  landingScrollRef.current?.scrollTo({ x: prev * SCREEN_WIDTH, animated: true });
                  setLandingStep(prev);
                }}>
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
                <MaterialIcons name="person-add" size={32} color={GREEN} />
              </View>
              <Text style={styles.heroTitle}>Enroll in the Program</Text>
              <Text style={styles.heroSub}>
                Your enrollment starts a 30-day qualification window. Acquire 76 validated customers to become an active NumVault Lead.
              </Text>
            </View>

            <View style={styles.formCard}>
              <Text style={styles.formLabel}>Your Full Name</Text>
              <TextInput
                style={styles.formInput}
                value={enrollName}
                onChangeText={setEnrollName}
                placeholder="Enter your full name"
                placeholderTextColor="#3a6a3a"
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
                'At 76 customers you automatically become an active lead — no review needed.',
              ].map((r, i) => (
                <View key={i} style={styles.ruleRow}>
                  <View style={styles.ruleDot} />
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
              {enrolling ? <ActivityIndicator color="#061006" /> : (
                <Text style={styles.ctaBtnText}>Start My 30-Day Qualification</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.backLink}
              onPress={() => { setLandingStep(0); setScreen('landing'); }}>
              <Text style={styles.backLinkText}>Back</Text>
            </TouchableOpacity>
            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* ── DASHBOARD ── */}
      {screen === 'dashboard' && participant && (
        <View style={{ flex: 1 }}>
          {/* Tabs — hidden when qualified (only On the team remains) */}
          {!isQualified && (
            <View style={styles.tabsRow}>
              <TouchableOpacity
                style={[styles.tabBtn, dashTab === 'proving' && styles.tabBtnActive]}
                onPress={async () => { await Haptics.selectionAsync(); setDashTab('proving'); }}
                activeOpacity={0.8}
              >
                <Text style={[styles.tabBtnText, dashTab === 'proving' && styles.tabBtnTextActive]}>
                  Earn your invite
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tabBtn, dashTab === 'onteam' && styles.tabBtnActive]}
                onPress={async () => { await Haptics.selectionAsync(); setDashTab('onteam'); }}
                activeOpacity={0.8}
              >
                <Text style={[styles.tabBtnText, dashTab === 'onteam' && styles.tabBtnTextActive]}>
                  On the team
                </Text>
              </TouchableOpacity>
            </View>
          )}

          <View style={{ flex: 1 }}>
            {/* Lock overlay for "On the team" if not qualified */}
            {dashTab === 'onteam' && !isQualified ? (
              <View style={styles.lockOverlay} pointerEvents="box-none">
                <View style={styles.lockIconWrap}>
                  <MaterialIcons name="lock" size={26} color={GREEN} />
                </View>
                <Text style={styles.lockTitle}>Staff Dashboard</Text>
                <Text style={styles.lockSub}>
                  Unlocks once you complete your referral challenge. Your referral code is
                </Text>
                <View style={styles.lockCodeBox}>
                  <Text style={styles.lockCode}>{participant.referral_code}</Text>
                  <Text style={styles.lockBrand}>NumVault</Text>
                </View>
                <Text style={styles.lockSub2}>Keep sharing your code. You have got this.</Text>
                <TouchableOpacity style={styles.lockBtn}
                  onPress={async () => { await Haptics.selectionAsync(); setDashTab('proving'); }}
                  activeOpacity={0.85}>
                  <Text style={styles.lockBtnText}>Back to my challenge</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingBottom: 40 }}>

                {/* ── UNDER REVIEW BANNER ── */}
                {dashTab === 'onteam' && underReviewPayouts.length > 0 ? (
                  <View style={styles.reviewBanner}>
                    <MaterialIcons name="info-outline" size={14} color="#fbbf24" />
                    <Text style={styles.reviewBannerText}>
                      Your payout of ₦{underReviewTotal.toLocaleString()} is under review. Every payout is checked before it is sent.
                    </Text>
                  </View>
                ) : null}

                {/* ── PROVING YOURSELF tab ── */}
                {dashTab === 'proving' && (
                  <>
                    <View style={styles.topCard}>
                      <View style={styles.topCardTop}>
                        <View style={styles.topCardLeft}>
                          <Text style={styles.topCardLabel}>Your proving ground</Text>
                          <Text style={styles.topCardHeadline}>
                            Earn your <Text style={{ color: GREEN }}>invite</Text>
                          </Text>
                          <Text style={styles.topCardSub}>76 customers. Unlock your income.</Text>
                        </View>
                        <View style={styles.topCardRight}>
                          <Text style={styles.topCardLabel}>You can earn up to</Text>
                          <Text style={styles.topCardBig}>₦600,000</Text>
                          <Text style={styles.topCardBigSub}>over your 6-month contract</Text>
                        </View>
                      </View>
                      <View style={styles.topCardDivider} />
                      <View style={styles.topCardBottom}>
                        <View style={styles.topCardStat}>
                          <View style={styles.statIcon}>
                            <MaterialIcons name="schedule" size={15} color={GREEN} />
                          </View>
                          <View>
                            <Text style={styles.statLabel}>Your progress so far</Text>
                            <Text style={styles.statVal}>{qualCount} / 76</Text>
                          </View>
                        </View>
                        <View style={[styles.topCardStat, styles.topCardStatBorder]}>
                          <View style={styles.statIcon}>
                            <MaterialIcons name="calendar-today" size={15} color={GREEN} />
                          </View>
                          <View>
                            <Text style={styles.statLabel}>Days remaining</Text>
                            <Text style={styles.statVal}>{daysLeft}</Text>
                          </View>
                        </View>
                      </View>
                    </View>

                    <View style={styles.scard}>
                      <TouchableOpacity style={styles.scardHdr}
                        onPress={async () => { await Haptics.selectionAsync(); setReqOpen(!reqOpen); }}
                        activeOpacity={0.8}>
                        <View style={styles.scardIcon}>
                          <MaterialIcons name="event-note" size={16} color={GREEN} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.scardTitle}>Your 30-day challenge</Text>
                          <Text style={styles.scardSub}>Tap to see how it works</Text>
                        </View>
                        <MaterialIcons name={reqOpen ? 'keyboard-arrow-up' : 'keyboard-arrow-right'} size={20} color={MUTED} />
                      </TouchableOpacity>
                      {reqOpen ? (
                        <View style={styles.scardBody}>
                          <Text style={styles.reqIntro}>
                            You have <Text style={{ color: '#fff', fontWeight: '600' }}>30 days</Text> to refer 76 paying customers.{' '}
                            <Text style={{ color: GREEN, fontWeight: '600' }}>{qualCount}/76</Text> done —{' '}
                            <Text style={{ color: MUTED }}>{Math.max(0, 76 - qualCount)} to go.</Text>
                          </Text>
                          {QUAL_RULES.map((r, i) => (
                            <View key={i} style={styles.ruleRow}>
                              <View style={styles.ruleDot} />
                              <Text style={styles.ruleText}>{r}</Text>
                            </View>
                          ))}
                          <View style={styles.scardDivider} />
                          <Text style={styles.reqQ}>What counts as a successful referral?</Text>
                          <View style={styles.vbox}>
                            <Text style={styles.vboxTitle}>Your referral counts when all 3 happen</Text>
                            <Text style={styles.vboxBody}>
                              {'1. They sign up using your referral code\n2. They buy at least one number\n3. Their order goes through successfully'}
                            </Text>
                            <Text style={styles.vboxNote}>Just signing up is not enough — they need to actually make a purchase.</Text>
                          </View>
                        </View>
                      ) : null}
                    </View>
                  </>
                )}

                {/* ── ON THE TEAM tab ── */}
                {dashTab === 'onteam' && isQualified && (
                  <>
                    {/* Bank details nudge */}
                    {needsBankDetails ? (
                      <TouchableOpacity
                        style={styles.bankNudge}
                        onPress={() => setScreen('bank_onboarding')}
                        activeOpacity={0.85}
                      >
                        <MaterialIcons name="account-balance" size={16} color="#fbbf24" />
                        <Text style={styles.bankNudgeText}>
                          Add your bank account to receive payouts
                        </Text>
                        <MaterialIcons name="chevron-right" size={16} color="#fbbf24" />
                      </TouchableOpacity>
                    ) : null}

                    <View style={styles.topCard}>
                      <View style={styles.topCardTop}>
                        <View style={styles.topCardLeft}>
                          <Text style={styles.topCardLabel}>Month {blockNum} of 6</Text>
                          <Text style={styles.topCardHeadline}>
                            {monthsRemaining} months <Text style={{ color: GREEN }}>remaining</Text>
                          </Text>
                          <Text style={styles.topCardSub}>{daysLeft} days left this month.{'\n'}Reach 76 early and your next month starts straight away.</Text>
                        </View>
                        <View style={styles.topCardRight}>
                          <Text style={styles.topCardLabel}>Potential remaining</Text>
                          <Text style={styles.topCardBig}>₦{potentialRemaining.toLocaleString()}</Text>
                          <Text style={styles.topCardBigSub}>across {monthsRemaining} months</Text>
                        </View>
                      </View>
                      <View style={styles.topCardDivider} />
                      <View style={styles.topCardBottom}>
                        <View style={styles.topCardStat}>
                          <View style={styles.statIcon}>
                            <MaterialIcons name="schedule" size={15} color={GREEN} />
                          </View>
                          <View>
                            <Text style={styles.statLabel}>Customers this month</Text>
                            <Text style={styles.statVal}>{qualCount} / 76</Text>
                          </View>
                        </View>
                        <View style={[styles.topCardStat, styles.topCardStatBorder]}>
                          <View style={styles.statIcon}>
                            <MaterialIcons name="people" size={15} color={GREEN} />
                          </View>
                          <View>
                            <Text style={styles.statLabel}>Days remaining</Text>
                            <Text style={styles.statVal}>{daysLeft}</Text>
                          </View>
                        </View>
                      </View>
                    </View>

                    <View style={styles.scard}>
                      <TouchableOpacity style={styles.scardHdr}
                        onPress={async () => { await Haptics.selectionAsync(); setReqOpen(!reqOpen); }}
                        activeOpacity={0.8}>
                        <View style={styles.scardIcon}>
                          <MaterialIcons name="event-note" size={16} color={GREEN} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.scardTitle}>Month {blockNum}: 30 days or 76 customers, whichever comes first</Text>
                          <Text style={styles.scardSub}>Tap to see how it works</Text>
                        </View>
                        <MaterialIcons name={reqOpen ? 'keyboard-arrow-up' : 'keyboard-arrow-right'} size={20} color={MUTED} />
                      </TouchableOpacity>
                      {reqOpen ? (
                        <View style={styles.scardBody}>
                          {PAID_RULES.map((r, i) => (
                            <View key={i} style={styles.ruleRow}>
                              <View style={styles.ruleDot} />
                              <Text style={styles.ruleText}>{r}</Text>
                            </View>
                          ))}
                          <View style={styles.scardDivider} />
                          <View style={styles.payNotice}>
                            <Text style={styles.payNoticeTitle}>How your pay works</Text>
                            <Text style={styles.payNoticeBody}>
                              <Text style={{ color: GREEN }}>①</Text> Your first month started when you qualified.{'\n'}
                              <Text style={{ color: GREEN }}>②</Text> At 38 customers, ₦50,000 goes under review. At 76, another ₦50,000 goes under review and your next month starts.{'\n'}
                              <Text style={{ color: GREEN }}>③</Text> If your 30 days end before 76, you are paid for the customers you brought in and asked to re-qualify to start again.
                            </Text>
                          </View>
                        </View>
                      ) : null}
                    </View>
                  </>
                )}

                {/* ── CYCLES (both tabs) ── */}
                <View style={styles.cycWrap}>
                  <View style={styles.cycRow}>
                    <View style={styles.cycIcon}>
                      <MaterialIcons name="people" size={16} color={GREEN} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={styles.cycMeta}>
                        <View>
                          <Text style={styles.cycName}>First half</Text>
                          <Text style={styles.cycCt}>{c1} / 38</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={styles.cycRange}>customers 1–38</Text>
                          <Text style={styles.cycPct}>{Math.round(c1 / 38 * 100)}%</Text>
                        </View>
                      </View>
                      <SegBar filled={c1} total={38} />
                      <View style={styles.barFt}>
                        <Text style={styles.barFtTxt}>0</Text>
                        <Text style={styles.barFtTxt}>38</Text>
                      </View>
                    </View>
                  </View>

                  <TouchableOpacity style={styles.cyc2Trigger}
                    onPress={async () => { await Haptics.selectionAsync(); setC2Open(!c2Open); }}
                    activeOpacity={0.8}>
                    <View style={[styles.cycIcon, { width: 32, height: 32 }]}>
                      <MaterialIcons name="people" size={14} color={GREEN} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cyc2Label}>Second half</Text>
                      <Text style={styles.cyc2Sub}>{c2} / 38 · customers 39–76</Text>
                    </View>
                    <MaterialIcons name={c2Open ? 'keyboard-arrow-up' : 'keyboard-arrow-down'} size={18} color={MUTED} />
                  </TouchableOpacity>

                  {c2Open ? (
                    <View style={styles.cyc2Body}>
                      <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
                        <View style={styles.cycMeta}>
                          <Text style={styles.cycCt}>{c2} / 38</Text>
                          <Text style={styles.cycPct}>{Math.round(c2 / 38 * 100)}%</Text>
                        </View>
                        <SegBar filled={c2} total={38} />
                        <View style={styles.barFt}>
                          <Text style={styles.barFtTxt}>39</Text>
                          <Text style={styles.barFtTxt}>76</Text>
                        </View>
                      </View>
                    </View>
                  ) : null}
                </View>

                {/* Referral card */}
                <View style={styles.refCard}>
                  <View style={styles.refTop}>
                    <View style={styles.refIcon}>
                      <MaterialIcons name="link" size={16} color={GREEN} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.refLabel}>Your referral code</Text>
                      <Text style={styles.refCode}>{participant.referral_code}</Text>
                    </View>
                  </View>
                  <TouchableOpacity style={styles.copyBtnLarge} onPress={copyCode} activeOpacity={0.85}>
                    <MaterialIcons name={copiedCode ? 'check' : 'content-copy'} size={16} color="#061006" />
                    <Text style={styles.copyBtnLargeText}>{copiedCode ? 'Copied!' : 'Copy Code'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.shareBtn} onPress={shareCode} activeOpacity={0.85}>
                    <MaterialIcons name="share" size={15} color={GREEN} />
                    <Text style={styles.shareBtnText}>Share referral code</Text>
                  </TouchableOpacity>
                </View>

                {/* Re-enroll button */}
                {(windowExpired || participant.status === 'needs_requalification') && dashTab === 'proving' ? (
                  <View style={{ paddingHorizontal: 16 }}>
                    {participant.status === 'needs_requalification' ? (
                      <View style={styles.requalCard}>
                        <MaterialIcons name="info" size={14} color="#fb923c" />
                        <Text style={styles.requalText}>
                          Your last month ended without reaching 76. Re-enroll to start again.
                        </Text>
                      </View>
                    ) : null}
                    <TouchableOpacity style={styles.reEnrollBtn} onPress={handleReEnroll} activeOpacity={0.85}>
                      <MaterialIcons name="refresh" size={18} color="#061006" />
                      <Text style={styles.reEnrollText}>Re-enroll (Reset 0/76)</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}

                {/* Pitch library */}
                {pitches.length > 0 ? (
                  <View style={styles.pitchWrap}>
                    <TouchableOpacity style={styles.pitchHdr}
                      onPress={async () => { await Haptics.selectionAsync(); setPitchOpen(!pitchOpen); }}
                      activeOpacity={0.8}>
                      <View style={styles.cycIcon}>
                        <MaterialIcons name="chat-bubble-outline" size={16} color={GREEN} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.pitchTitle}>How to talk about NumVault</Text>
                      </View>
                      <MaterialIcons name={pitchOpen ? 'keyboard-arrow-up' : 'keyboard-arrow-down'} size={18} color={MUTED} />
                    </TouchableOpacity>
                    {pitchOpen ? (
                      <View style={styles.pitchBody}>
                        {pitches.map((p) => (
                          <View key={p.id} style={styles.pitchItem}>
                            <View style={styles.piIcon}>
                              <MaterialIcons name="person" size={14} color={GREEN} />
                            </View>
                            <View style={{ flex: 1 }}>
                              <View style={styles.piTag}>
                                <Text style={styles.piTagText}>{p.audience}</Text>
                              </View>
                              <Text style={styles.pitchHeadline}>{p.headline}</Text>
                              <Text style={styles.pitchBodyTxt}>{p.body}</Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </View>
                ) : null}

                {/* ── PAYOUTS section (on the team only) ── */}
                {dashTab === 'onteam' && isQualified && payouts.length > 0 ? (
                  <View style={{ paddingHorizontal: 16, gap: 8 }}>
                    <Text style={styles.payoutSectionTitle}>Payouts</Text>
                    {payouts.map((pout) => {
                      const meta = payoutStatusLabel(pout.status);
                      const isSent = pout.status === 'sent';
                      return (
                        <View key={pout.id} style={[styles.payoutRow, { borderColor: meta.color + '44' }]}>
                          <View style={[styles.payoutIconWrap, { backgroundColor: meta.color + '18' }]}>
                            <MaterialIcons
                              name={isSent ? 'check-circle' : pout.status === 'failed' || pout.status === 'held' ? 'error' : 'pending'}
                              size={16}
                              color={meta.color}
                            />
                          </View>
                          <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                              <Text style={styles.payoutLabel}>
                                Month {pout.block_number ?? '?'} · Half {pout.cycle_number}
                              </Text>
                              <View style={[styles.payoutChip, { backgroundColor: meta.color + '22', borderColor: meta.color + '55' }]}>
                                <Text style={[styles.payoutChipText, { color: meta.color }]}>{meta.text}</Text>
                              </View>
                            </View>
                            <Text style={styles.payoutMeta}>
                              {isSent && pout.sent_at
                                ? `Paid on ${new Date(pout.sent_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}`
                                : meta.desc}
                            </Text>
                            <Text style={styles.payoutCustomers}>{pout.customers_in_cycle} customers</Text>
                          </View>
                          <Text style={[styles.payoutAmount, { color: isSent ? GREEN : '#fff' }]}>
                            ₦{Number(pout.amount).toLocaleString()}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                ) : null}

              </ScrollView>
            )}
          </View>
        </View>
      )}

      {/* ── BANK ONBOARDING ── */}
      {screen === 'bank_onboarding' && participant && (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
            <View style={styles.heroCard}>
              <View style={[styles.heroIcon, { backgroundColor: '#0d2a0d' }]}>
                <MaterialIcons name="account-balance" size={36} color={GREEN} />
              </View>
              <Text style={styles.heroTitle}>Set up your payout</Text>
              <Text style={styles.heroSub}>
                Add your bank details so we can pay you directly. We will verify your account name through Paystack.
              </Text>
            </View>

            <View style={styles.payNotice}>
              <Text style={styles.payNoticeTitle}>How your pay works</Text>
              <Text style={styles.payNoticeBody}>
                <Text style={{ color: GREEN }}>①</Text> Your first month is now running.{'\n'}
                <Text style={{ color: GREEN }}>②</Text> At 38 customers, ₦50,000 goes under admin review. At 76, another ₦50,000 goes under review and your next month starts immediately.{'\n'}
                <Text style={{ color: GREEN }}>③</Text> We will push you a notification when each payout is approved.
              </Text>
            </View>

            <View style={styles.formCard}>
              <Text style={styles.formLabel}>Bank</Text>
              <TouchableOpacity style={[styles.formInput, { justifyContent: 'center' }]}
                onPress={() => setShowBankPicker(true)} activeOpacity={0.8}>
                <Text style={{ color: selectedBank ? '#fff' : '#3a6a3a', fontSize: 14 }}>
                  {selectedBank ? selectedBank.name : 'Select your bank'}
                </Text>
              </TouchableOpacity>

              <Text style={[styles.formLabel, { marginTop: Spacing.md }]}>Account Number</Text>
              <TextInput
                style={styles.formInput}
                value={bankAccountNumber}
                onChangeText={(t) => { setBankAccountNumber(t.replace(/\D/g, '').slice(0, 10)); setResolvedAccountName(null); }}
                placeholder="Enter 10-digit account number"
                placeholderTextColor="#3a6a3a"
                keyboardType="number-pad"
                maxLength={10}
              />

              {bankAccountNumber.length === 10 && selectedBank ? (
                <TouchableOpacity
                  style={[styles.lookupBtn, resolvingAccount && { opacity: 0.5 }]}
                  onPress={resolveAccount}
                  disabled={resolvingAccount}
                  activeOpacity={0.85}
                >
                  <Text style={styles.lookupBtnText}>
                    {resolvingAccount ? 'Verifying...' : 'Verify my account name'}
                  </Text>
                </TouchableOpacity>
              ) : null}

              {resolvedAccountName ? (
                <View style={styles.nameResult}>
                  <Text style={styles.nameResultLabel}>Account holder name</Text>
                  <Text style={styles.nameResultVal}>{resolvedAccountName}</Text>
                  <Text style={styles.nameResultSub}>Is this you? If yes, confirm below.</Text>
                </View>
              ) : null}
            </View>

            <TouchableOpacity
              style={[styles.ctaBtn, (!resolvedAccountName || savingBank) && styles.ctaBtnDisabled]}
              onPress={saveBankDetails}
              disabled={!resolvedAccountName || savingBank}
              activeOpacity={0.85}
            >
              {savingBank ? <ActivityIndicator color="#061006" /> : (
                <Text style={styles.ctaBtnText}>Confirm and unlock Staff Dashboard</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.backLink} onPress={() => setScreen('dashboard')}>
              <Text style={styles.backLinkText}>Set up later</Text>
            </TouchableOpacity>
            <View style={{ height: 40 }} />
          </ScrollView>

          <Modal visible={showBankPicker} animationType="slide" onRequestClose={() => setShowBankPicker(false)}>
            <View style={[styles.container, { paddingTop: insets.top }]}>
              <View style={styles.header}>
                <TouchableOpacity style={styles.backBtn} onPress={() => setShowBankPicker(false)} activeOpacity={0.7}>
                  <MaterialIcons name="close" size={22} color={GREEN} />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>Select Bank</Text>
                <View style={{ width: 36 }} />
              </View>
              <ScrollView showsVerticalScrollIndicator={false}>
                {bankList.length === 0 ? (
                  <View style={[styles.center, { padding: Spacing.xl }]}>
                    <ActivityIndicator color={GREEN} />
                  </View>
                ) : (
                  bankList.map((bank) => (
                    <TouchableOpacity
                      key={bank.code}
                      style={[styles.bankRow, selectedBank?.code === bank.code && styles.bankRowSelected]}
                      onPress={() => { setSelectedBank(bank); setResolvedAccountName(null); setShowBankPicker(false); }}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.bankName, selectedBank?.code === bank.code && { color: GREEN }]}>{bank.name}</Text>
                      {selectedBank?.code === bank.code ? <MaterialIcons name="check" size={16} color={GREEN} /> : null}
                    </TouchableOpacity>
                  ))
                )}
              </ScrollView>
            </View>
          </Modal>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

// ── Segmented bar ─────────────────────────────────────────────────────────────

function SegBar({ filled, total }: { filled: number; total: number }) {
  const segments = Array.from({ length: total }, (_, i) => i < filled);
  return (
    <View style={segStyles.bar}>
      {segments.map((on, i) => (
        <View key={i} style={[segStyles.seg, on && segStyles.segOn]} />
      ))}
    </View>
  );
}

const segStyles = StyleSheet.create({
  bar: { flexDirection: 'row', gap: 2, height: 8, marginVertical: 4 },
  seg: { flex: 1, borderRadius: 2, backgroundColor: '#1a3a1a' },
  segOn: { backgroundColor: '#4ade80' },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isWithin30Days(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false;
  return Date.now() < new Date(dateStr).getTime() + 30 * 24 * 60 * 60 * 1000;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const BG = '#0a0d0a';
const SURFACE = '#0d1f0d';
const BORDER = '#1a3a1a';
const BORDER2 = '#1e3a1e';
const GREEN = '#4ade80';
const MUTED = '#4a7a4a';
const MUTED2 = '#3a6a3a';
const TEXT = '#fff';
const TEXT2 = '#a0c0a0';

const styles = StyleSheet.create({
  accent: { color: GREEN },
  container: { flex: 1, backgroundColor: BG },
  center: { alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 16,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#111a11', borderWidth: 1, borderColor: BORDER2,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: TEXT, fontSize: 20, fontWeight: '700' },

  welcomeOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(5,10,5,0.96)', zIndex: 200,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 32, paddingBottom: 40,
  },
  welcomeEmoji: { fontSize: 60, marginBottom: 20 },
  welcomeTitle: { fontSize: 28, fontWeight: '700', color: GREEN, marginBottom: 12 },
  welcomeSub: { fontSize: 14, color: TEXT2, lineHeight: 24, textAlign: 'center', maxWidth: 290, marginBottom: 28 },
  welcomeBtn: { backgroundColor: GREEN, borderRadius: 100, paddingHorizontal: 48, paddingVertical: 15 },
  welcomeBtnText: { color: '#061006', fontSize: 15, fontWeight: '700' },

  landingPage: { width: SCREEN_WIDTH, padding: 20, paddingTop: 32, gap: 20 },
  landingIconRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  landingIconWrap: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: '#0d2a0d', borderWidth: 1, borderColor: '#1a5a1a',
    alignItems: 'center', justifyContent: 'center',
  },
  landingStepLabel: { color: GREEN, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase' },
  landingTitle: { color: TEXT, fontSize: 24, fontWeight: '700', lineHeight: 32 },
  landingBody: { color: TEXT2, fontSize: 15, lineHeight: 26 },
  landingFooter: {
    paddingHorizontal: 20, paddingTop: 12, gap: 10,
    borderTopWidth: 1, borderTopColor: BORDER, backgroundColor: BG,
  },
  landingDots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginBottom: 4 },
  landingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: BORDER },
  landingDotActive: { width: 20, backgroundColor: GREEN },

  tabsRow: {
    flexDirection: 'row', marginHorizontal: 16, marginBottom: 14,
    backgroundColor: '#111a11', borderWidth: 1, borderColor: BORDER2,
    borderRadius: 100, padding: 4,
  },
  tabBtn: { flex: 1, paddingVertical: 10, borderRadius: 100, alignItems: 'center' },
  tabBtnActive: { backgroundColor: '#1a3a1a' },
  tabBtnText: { fontSize: 13, fontWeight: '500', color: MUTED },
  tabBtnTextActive: { color: GREEN, fontWeight: '600' },

  lockOverlay: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 32, backgroundColor: 'rgba(5,10,5,0.82)',
  },
  lockIconWrap: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: '#0d2a0d', borderWidth: 2, borderColor: '#1a5a1a',
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  lockTitle: { fontSize: 22, fontWeight: '700', color: TEXT, marginBottom: 8 },
  lockSub: { fontSize: 13, color: MUTED, lineHeight: 22, textAlign: 'center', maxWidth: 260, marginBottom: 14 },
  lockCodeBox: {
    backgroundColor: '#0d2a0d', borderWidth: 1, borderColor: '#1a5a1a',
    borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24, marginBottom: 10,
    alignItems: 'center',
  },
  lockCode: { fontSize: 22, fontWeight: '700', color: GREEN, letterSpacing: 3 },
  lockBrand: { fontSize: 10, color: MUTED2, marginTop: 3 },
  lockSub2: { fontSize: 12, color: MUTED2, marginBottom: 20 },
  lockBtn: { backgroundColor: '#1a5a2a', borderRadius: 100, paddingHorizontal: 32, paddingVertical: 12 },
  lockBtnText: { color: GREEN, fontSize: 13, fontWeight: '600' },

  reviewBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(251,191,36,0.1)', borderWidth: 1, borderColor: 'rgba(251,191,36,0.35)',
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, marginHorizontal: 16,
  },
  reviewBannerText: { flex: 1, color: '#fbbf24', fontSize: 12, lineHeight: 18 },

  bankNudge: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(251,191,36,0.08)', borderWidth: 1, borderColor: 'rgba(251,191,36,0.35)',
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, marginHorizontal: 16,
  },
  bankNudgeText: { flex: 1, color: '#fbbf24', fontSize: 12 },

  topCard: {
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 16, padding: 18, marginHorizontal: 16,
  },
  topCardTop: { flexDirection: 'row', marginBottom: 16 },
  topCardLeft: { flex: 1, paddingRight: 16, borderRightWidth: 1, borderRightColor: BORDER },
  topCardRight: { flex: 1, paddingLeft: 16 },
  topCardLabel: { fontSize: 10, color: MUTED2, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 },
  topCardHeadline: { fontSize: 22, fontWeight: '700', color: TEXT, lineHeight: 26, marginBottom: 6 },
  topCardSub: { fontSize: 12, color: MUTED, lineHeight: 18 },
  topCardBig: { fontSize: 28, fontWeight: '700', color: GREEN, lineHeight: 32, marginBottom: 4 },
  topCardBigSub: { fontSize: 11, color: MUTED },
  topCardDivider: { height: 1, backgroundColor: BORDER, marginBottom: 14 },
  topCardBottom: { flexDirection: 'row' },
  topCardStat: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  topCardStatBorder: { borderLeftWidth: 1, borderLeftColor: BORDER, paddingLeft: 14 },
  statIcon: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#112011', borderWidth: 1, borderColor: '#1a4a1a',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  statLabel: { fontSize: 10, color: MUTED, marginBottom: 2 },
  statVal: { fontSize: 18, fontWeight: '700', color: TEXT },
  statValGreen: { fontSize: 15, fontWeight: '700', color: GREEN },

  scard: {
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 16, marginHorizontal: 16, overflow: 'hidden',
  },
  scardHdr: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  scardIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#112011', borderWidth: 1, borderColor: '#1a4a1a',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  scardTitle: { fontSize: 14, fontWeight: '600', color: TEXT, marginBottom: 2 },
  scardSub: { fontSize: 12, color: MUTED },
  scardBody: { borderTopWidth: 1, borderTopColor: BORDER, padding: 14, gap: 8 },
  scardDivider: { height: 1, backgroundColor: BORDER, marginVertical: 10 },

  reqIntro: { fontSize: 12, color: TEXT2, lineHeight: 20, marginBottom: 6 },
  reqQ: { fontSize: 12, fontWeight: '600', color: GREEN, marginBottom: 8 },
  vbox: {
    backgroundColor: '#0f2a0f', borderWidth: 1, borderColor: '#1e4a1e', borderRadius: 10, padding: 12,
  },
  vboxTitle: { fontSize: 11, fontWeight: '600', color: GREEN, marginBottom: 6 },
  vboxBody: { fontSize: 11, color: TEXT2, lineHeight: 22 },
  vboxNote: { fontSize: 10, color: MUTED2, marginTop: 6 },

  payNotice: {
    backgroundColor: '#0d2a0d', borderWidth: 1, borderColor: '#1a5a1a',
    borderRadius: 12, padding: 14, marginHorizontal: 16,
  },
  payNoticeTitle: { fontSize: 12, fontWeight: '600', color: GREEN, marginBottom: 8 },
  payNoticeBody: { fontSize: 12, color: TEXT2, lineHeight: 22 },

  cycWrap: {
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 16, marginHorizontal: 16, overflow: 'hidden',
  },
  cycRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14 },
  cycIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#112011', borderWidth: 1, borderColor: '#1a4a1a',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2,
  },
  cycMeta: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 },
  cycName: { fontSize: 14, fontWeight: '600', color: TEXT, marginBottom: 3 },
  cycCt: { fontSize: 22, fontWeight: '700', color: TEXT, lineHeight: 26 },
  cycRange: { fontSize: 11, color: MUTED, marginBottom: 3 },
  cycPct: { fontSize: 18, fontWeight: '700', color: GREEN },
  barFt: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 3 },
  barFtTxt: { fontSize: 9, color: MUTED2 },

  cyc2Trigger: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, paddingLeft: 14, borderTopWidth: 1, borderTopColor: BORDER,
  },
  cyc2Label: { fontSize: 13, fontWeight: '500', color: TEXT },
  cyc2Sub: { fontSize: 11, color: MUTED, marginTop: 1 },
  cyc2Body: { borderTopWidth: 1, borderTopColor: BORDER },

  refCard: {
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 16, marginHorizontal: 16, padding: 16, gap: 14,
  },
  refTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  refIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#112011', borderWidth: 1, borderColor: '#1a4a1a',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  refLabel: { fontSize: 11, color: MUTED, marginBottom: 3 },
  refCode: { fontSize: 18, fontWeight: '700', color: GREEN, letterSpacing: 2 },
  copyBtnLarge: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: GREEN, borderRadius: 100, paddingVertical: 14,
  },
  copyBtnLargeText: { color: '#061006', fontSize: 14, fontWeight: '700' },
  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: 'transparent', borderWidth: 1, borderColor: '#2a5a2a',
    borderRadius: 100, paddingVertical: 12,
  },
  shareBtnText: { color: GREEN, fontSize: 13, fontWeight: '600' },

  requalCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: 'rgba(251,146,60,0.1)', borderWidth: 1, borderColor: 'rgba(251,146,60,0.35)',
    borderRadius: 12, padding: 12, marginBottom: 10,
  },
  requalText: { flex: 1, color: '#fb923c', fontSize: 12, lineHeight: 18 },

  reEnrollBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: '#b45309', borderRadius: 100, height: 50,
  },
  reEnrollText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  pitchWrap: {
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 16, marginHorizontal: 16, overflow: 'hidden',
  },
  pitchHdr: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  pitchTitle: { fontSize: 14, fontWeight: '600', color: TEXT },
  pitchBody: { borderTopWidth: 1, borderTopColor: BORDER },
  pitchItem: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    padding: 12, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: '#0f1a0f',
  },
  piIcon: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#112011', borderWidth: 1, borderColor: '#1a4a1a',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  piTag: {
    backgroundColor: '#0f2a0f', borderWidth: 1, borderColor: '#1a4a1a',
    borderRadius: 100, paddingHorizontal: 8, paddingVertical: 2,
    alignSelf: 'flex-start', marginBottom: 4,
  },
  piTagText: { fontSize: 10, fontWeight: '600', color: GREEN },
  pitchHeadline: { fontSize: 12, color: TEXT, fontWeight: '500', marginBottom: 3, lineHeight: 18 },
  pitchBodyTxt: { fontSize: 11, color: TEXT2, lineHeight: 18 },

  payoutSectionTitle: { fontSize: 15, fontWeight: '700', color: TEXT, marginBottom: 4 },
  payoutRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: SURFACE, borderWidth: 1,
    borderRadius: 12, padding: 14,
  },
  payoutIconWrap: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  payoutLabel: { fontSize: 13, fontWeight: '600', color: TEXT },
  payoutMeta: { fontSize: 11, color: MUTED, marginTop: 2, lineHeight: 16 },
  payoutCustomers: { fontSize: 10, color: MUTED2, marginTop: 2 },
  payoutAmount: { fontSize: 14, fontWeight: '700', flexShrink: 0 },
  payoutChip: {
    borderWidth: 1, borderRadius: 100, paddingHorizontal: 7, paddingVertical: 2,
  },
  payoutChipText: { fontSize: 10, fontWeight: '700' },

  content: { padding: 20, gap: 20 },
  heroCard: {
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 16, padding: 24, alignItems: 'center', gap: 12,
  },
  heroIcon: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: '#0d2a0d', borderWidth: 1, borderColor: '#1a5a1a',
    alignItems: 'center', justifyContent: 'center',
  },
  heroTitle: { color: TEXT, fontSize: 20, fontWeight: '700', textAlign: 'center', lineHeight: 26 },
  heroSub: { color: TEXT2, fontSize: 13, textAlign: 'center', lineHeight: 22 },

  ctaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: GREEN, borderRadius: 100, height: 52, marginHorizontal: 16,
  },
  ctaBtnDisabled: { opacity: 0.4 },
  ctaBtnText: { color: '#061006', fontSize: 14, fontWeight: '700' },

  formCard: {
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 16, padding: 16, gap: 10,
  },
  formLabel: { fontSize: 10, color: MUTED2, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2 },
  formInput: {
    backgroundColor: '#0d1f0d', borderWidth: 1, borderColor: BORDER,
    borderRadius: 12, paddingHorizontal: 14, height: 50, color: TEXT, fontSize: 14,
  },
  formHint: { fontSize: 11, color: MUTED2, lineHeight: 18 },

  ruleCard: {
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 16, padding: 16, gap: 8,
  },
  ruleTitle: { fontSize: 13, fontWeight: '700', color: TEXT, marginBottom: 4 },
  ruleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  ruleDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: GREEN, marginTop: 7, flexShrink: 0 },
  ruleText: { flex: 1, fontSize: 12, color: TEXT2, lineHeight: 20 },

  backLink: { alignItems: 'center', paddingVertical: 10 },
  backLinkText: { color: MUTED, fontSize: 13 },

  lookupBtn: {
    backgroundColor: '#1a5a2a', borderRadius: 100, height: 50,
    alignItems: 'center', justifyContent: 'center', marginTop: 8,
  },
  lookupBtnText: { color: GREEN, fontSize: 14, fontWeight: '600' },
  nameResult: {
    backgroundColor: '#0d2a0d', borderWidth: 1, borderColor: '#1a5a1a',
    borderRadius: 12, padding: 14, marginTop: 12,
  },
  nameResultLabel: { fontSize: 10, color: MUTED2, marginBottom: 4, letterSpacing: 1, textTransform: 'uppercase' },
  nameResultVal: { fontSize: 22, fontWeight: '700', color: GREEN },
  nameResultSub: { fontSize: 11, color: MUTED2, marginTop: 3 },

  bankRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: BORDER,
  },
  bankRowSelected: { backgroundColor: '#0d2a0d' },
  bankName: { color: TEXT, fontSize: 14, flex: 1, paddingRight: 12 },
});
