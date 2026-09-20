// cache-bust: build-v5
import React, { useState, useRef } from 'react';
import {
  View, Text, StyleSheet, Dimensions, TouchableOpacity,
  ScrollView, StatusBar,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/template';
import { trackOnboardingCompleted } from '@/services/sentryService';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

const { width, height } = Dimensions.get('window');

// ── Screen definitions ────────────────────────────────────────────────────────
const SCREENS = [
  {
    image: require('@/assets/images/nv_s1.png'),
    tag: 'think',
    headline: 'Your number is more exposed than you',
    body: 'Every sign-up form, every stranger you meet online, every app you download — they all want your personal phone number, with the possibility of it becoming another thing tied to your identity that can get leaked or get sold. Privacy shouldn\'t be optional by default',
    steps: null as null | string[],
  },
  {
    image: require('@/assets/images/nv_s2.png'),
    tag: null as null | string,
    headline: 'No subscription, No rent. Pay as you go.',
    body: 'Choose from 2,300+ apps & services and pay only when you need a number without being locked into a monthly subscription. Your purchased number belongs to you for that service.',
    steps: null,
  },
  {
    image: require('@/assets/images/nv_s3.png'),
    tag: null,
    headline: "Here's exactly how it works",
    body: 'Have numbers for different purposes — personal, business, projects, accounts, and more. With 2,300+ apps & services available, you have the capacity to create separation wherever you need it.',
    steps: [
      'Choose what you\'re signing up for',
      'Pick a number',
      'Pay securely with your card or transfer',
      'Get your number instantly. OTP delivered automatically.',
    ],
  },
];

export default function OnboardingScreen() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();

  const finish = async () => {
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

  const screen = SCREENS[currentIndex];
  const isLast = currentIndex === SCREENS.length - 1;

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

      {/* Skip button — visible on all screens except the last */}
      {!isLast ? (
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

        {screen.tag ? (
          <Text style={styles.tag}>{screen.tag}</Text>
        ) : null}
        <Text style={styles.headline}>{screen.headline}</Text>
        <Text style={styles.body}>{screen.body}</Text>

        {screen.steps ? (
          <View style={styles.stepsContainer}>
            {screen.steps.map((step, i) => (
              <View key={i} style={styles.stepRow}>
                <View style={styles.stepNum}>
                  <Text style={styles.stepNumText}>{i + 1}</Text>
                </View>
                <Text style={styles.stepText}>{step}</Text>
              </View>
            ))}
          </View>
        ) : null}

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
  tag: {
    color: Colors.primary,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  stepsContainer: {
    gap: 10,
    marginTop: 4,
    marginBottom: 4,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  stepNumText: {
    color: Colors.black,
    fontSize: 11,
    fontWeight: FontWeight.bold,
  },
  stepText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    lineHeight: 20,
  },
});
