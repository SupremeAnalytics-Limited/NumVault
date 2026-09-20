// cache-bust: build-v4
import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, Dimensions, TouchableOpacity,
  ScrollView, StatusBar, ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/template';
import { trackOnboardingCompleted } from '@/services/sentryService';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

const { width, height } = Dimensions.get('window');

// ── Launch state ──────────────────────────────────────────────────────────────
// first_launch  — brand new user, no skip allowed on any screen
// downgraded    — missed their target, no skip allowed (must re-read commitment)
// active_staff  — has an active qualifying/lead record, skip allowed on 1–3
type LaunchState = 'first_launch' | 'downgraded' | 'active_staff';

// ── Screen definitions ────────────────────────────────────────────────────────
const SCREENS = [
  {
    image: require('@/assets/images/nv_s1.png'),
    headline: 'We build software that opens doors',
    body: 'SupremeAnalytics is a Nigerian software company. We build products that give everyday people — students, freelancers, and working professionals — access to the same digital opportunities as anyone else in the world.',
    steps: null as null | { num: string; text: string }[],
  },
  {
    image: require('@/assets/images/nv_s2.png'),
    headline: 'A side income that fits your life',
    body: "Whether you're in school, at work, or building your own thing — we've created a way for you to earn on the side without changing anything about your routine. No office. No fixed hours. Just results.",
    steps: null,
  },
  {
    image: require('@/assets/images/nv_s3.png'),
    headline: 'Protect your number. Power your business.',
    body: "NumVault gives you a dedicated number for any platform — one that's yours permanently, with no recurring fees. It keeps your personal number private while giving your business, clients, and online activities their own dedicated lines. 2,300+ services. One place. People need this every day — your job is to show them it exists.",
    steps: null,
  },
  {
    // Screen 4 reuses the first image (no new asset needed)
    image: require('@/assets/images/nv_s1.png'),
    headline: 'Earn your Job Position with our company as a Customer Acquisition Lead',
    body: 'Refer 76 paying customers in 30 days and we officially bring you on as a Customer Acquisition Lead — a paid staff role with your own dashboard and up to ₦100,000 a month. This is how you start.',
    steps: null,
  },
];

export default function OnboardingScreen() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [launchState, setLaunchState] = useState<LaunchState>('first_launch');
  const [resolving, setResolving] = useState(true);
  const scrollRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();

  // ── Determine launch state from Supabase participant record ────────────────
  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      try {
        if (!user) {
          // Not logged in yet — treat as first launch
          if (!cancelled) { setLaunchState('first_launch'); setResolving(false); }
          return;
        }
        const { getSupabaseClient } = await import('@/template');
        const supabase = getSupabaseClient();
        const { data: participant } = await supabase
          .from('acquisition_participants')
          .select('id, status, qualification_customers_count, qualification_start_date')
          .eq('user_id', user.id)
          .maybeSingle();

        if (!participant) {
          // No participant record → first launch
          if (!cancelled) { setLaunchState('first_launch'); setResolving(false); }
          return;
        }

        // Active staff: any participant that is qualifying (active window), eligible,
        // or an active_lead — they've demonstrated commitment and can skip 1–3
        const isActive =
          participant.status === 'active_lead' ||
          participant.status === 'eligible_not_joined' ||
          (participant.status === 'qualifying' &&
            participant.qualification_customers_count > 0 &&
            isWithin30Days(participant.qualification_start_date));

        // Downgraded: had a record but window expired without reaching 76, or inactive
        const isDowngraded =
          participant.status === 'inactive' ||
          (participant.status === 'qualifying' &&
            participant.qualification_customers_count === 0 &&
            !isWithin30Days(participant.qualification_start_date));

        if (!cancelled) {
          setLaunchState(isActive ? 'active_staff' : isDowngraded ? 'downgraded' : 'first_launch');
          setResolving(false);
        }
      } catch {
        if (!cancelled) { setLaunchState('first_launch'); setResolving(false); }
      }
    }
    resolve();
    return () => { cancelled = true; };
  }, [user?.id]);

  const finish = () => {
    trackOnboardingCompleted();
    router.replace(user ? '/(tabs)' : '/login');
  };

  const goNext = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (currentIndex < SCREENS.length - 1) {
      const next = currentIndex + 1;
      scrollRef.current?.scrollTo({ x: next * width, animated: true });
      setCurrentIndex(next);
    } else {
      finish();
    }
  };

  const skip = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    finish();
  };

  // Skip is visible only for active_staff AND only on screens 1–3 (not screen 4)
  const showSkip = launchState === 'active_staff' && currentIndex < SCREENS.length - 1;

  const screen = SCREENS[currentIndex];
  const isLast = currentIndex === SCREENS.length - 1;

  if (resolving) {
    return (
      <View style={[styles.container, { alignItems: 'center', justifyContent: 'center' }]}>
        <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
        <ActivityIndicator color={Colors.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Logo watermark */}
      <View style={[styles.logoWatermark, { top: insets.top + 12 }]}>
        <Image
          source={require('@/assets/images/icon.png')}
          style={styles.logoWatermarkImg}
          contentFit="contain"
        />
        <Text style={styles.logoWatermarkText}>NumVault</Text>
      </View>

      {/* Skip button — only for active_staff on screens 1–3 */}
      {showSkip ? (
        <TouchableOpacity
          style={[styles.skipBtn, { top: insets.top + 16 }]}
          onPress={skip}
          activeOpacity={0.7}
        >
          <Text style={styles.skipText}>Skip</Text>
        </TouchableOpacity>
      ) : null}

      {/* Horizontal pager */}
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
      >
        {SCREENS.map((s, i) => (
          <View key={i} style={[styles.page, { width }]}>
            <Image
              source={s.image}
              style={styles.illustration}
              contentFit="cover"
              transition={300}
            />
            <View style={styles.gradient} />
          </View>
        ))}
      </ScrollView>

      {/* Bottom content */}
      <View style={[styles.bottomCard, { paddingBottom: insets.bottom + 24 }]}>
        {/* Screen counter */}
        <Text style={styles.screenCounter}>{currentIndex + 1} / {SCREENS.length}</Text>

        <Text style={styles.headline}>{screen.headline}</Text>
        <Text style={styles.body}>{screen.body}</Text>

        {/* Dots */}
        <View style={styles.dots}>
          {SCREENS.map((_, i) => (
            <View key={i} style={[styles.dot, i === currentIndex && styles.dotActive]} />
          ))}
        </View>

        <TouchableOpacity style={styles.ctaBtn} onPress={goNext} activeOpacity={0.85}>
          <Text style={styles.ctaText}>
            {isLast ? 'Get Started' : 'Continue'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function isWithin30Days(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false;
  const start = new Date(dateStr).getTime();
  const deadline = start + 30 * 24 * 60 * 60 * 1000;
  return Date.now() < deadline;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  logoWatermark: {
    position: 'absolute',
    left: 20,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  logoWatermarkImg: {
    width: 28,
    height: 28,
    borderRadius: 6,
  },
  logoWatermarkText: {
    color: Colors.text,
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.5,
  },
  skipBtn: {
    position: 'absolute',
    right: 20,
    zIndex: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: Radius.full,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  skipText: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },
  page: {
    flex: 1,
    position: 'relative',
  },
  illustration: {
    width: '100%',
    height: height * 0.52,
  },
  gradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: height * 0.22,
    backgroundColor: Colors.background,
    opacity: 0.96,
  },
  bottomCard: {
    backgroundColor: Colors.background,
    paddingHorizontal: 28,
    paddingTop: 4,
  },
  screenCounter: {
    color: Colors.primary,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: Spacing.sm,
  },
  headline: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    marginBottom: Spacing.md,
    lineHeight: 30,
  },
  body: {
    color: Colors.textSecondary,
    fontSize: FontSize.md,
    lineHeight: 26,
    marginBottom: Spacing.lg,
  },
  dots: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: Spacing.lg,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.surfaceBorder,
  },
  dotActive: {
    width: 20,
    backgroundColor: Colors.primary,
  },
  ctaBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    color: Colors.black,
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
  },
});
