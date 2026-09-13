// cache-bust: build-v3
import React, { useState, useRef } from 'react';
import {
  View, Text, StyleSheet, Dimensions, TouchableOpacity,
  ScrollView, Platform, StatusBar,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/template';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

const { width, height } = Dimensions.get('window');

const SCREENS = [
  {
    image: require('@/assets/images/nv_s1.png'),
    headline: "Your number is more exposed than you think",
    subtext: "Every sign-up form, every stranger you meet online, every app you download — they all want your real number. NumVault gives you a private one instead.",
  },
  {
    image: require('@/assets/images/nv_s2.png'),
    headline: "Privacy shouldn't be optional",
    subtext: "Protect yourself from spam, harassment, and SIM-swap fraud. Use NumVault for dating apps, online marketplaces, and any sign-up — without ever exposing your real number.",
  },
  {
    image: require('@/assets/images/nv_s3.png'),
    headline: "Here's exactly how it works",
    steps: [
      { num: "1", text: "Choose what you're signing up for" },
      { num: "2", text: "Pick a number" },
      { num: "3", text: "Pay securely with your card or transfer" },
      { num: "4", text: "Get your number instantly. OTP delivered automatically." },
    ],
  },
];

export default function OnboardingScreen() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();

  // If user is already signed in go straight to the app, otherwise go to login.
  const finish = () => router.replace(user ? '/(tabs)' : '/login');

  const goNext = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (currentIndex < SCREENS.length - 1) {
      const nextIndex = currentIndex + 1;
      scrollRef.current?.scrollTo({ x: nextIndex * width, animated: true });
      setCurrentIndex(nextIndex);
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

      {/* Skip button */}
      <TouchableOpacity
        style={[styles.skipBtn, { top: insets.top + 16 }]}
        onPress={skip}
        activeOpacity={0.7}
      >
        <Text style={styles.skipText}>Skip</Text>
      </TouchableOpacity>

      {/* App logo watermark */}
      <View style={[styles.logoWatermark, { top: insets.top + 12 }]}>
        <Image
          source={require('@/assets/images/icon.png')}
          style={styles.logoWatermarkImg}
          contentFit="contain"
        />
        <Text style={styles.logoWatermarkText}>NumVault</Text>
      </View>

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
        <Text style={styles.headline}>{screen.headline}</Text>

        {screen.subtext ? (
          <Text style={styles.subtext}>{screen.subtext}</Text>
        ) : screen.steps ? (
          <View style={styles.stepsContainer}>
            {screen.steps.map((step) => (
              <View key={step.num} style={styles.stepRow}>
                <View style={styles.stepNum}>
                  <Text style={styles.stepNumText}>{step.num}</Text>
                </View>
                <Text style={styles.stepText}>{step.text}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Dots */}
        <View style={styles.dots}>
          {SCREENS.map((_, i) => (
            <View
              key={i}
              style={[styles.dot, i === currentIndex && styles.dotActive]}
            />
          ))}
        </View>

        <TouchableOpacity style={styles.ctaBtn} onPress={goNext} activeOpacity={0.85}>
          <Text style={styles.ctaText}>
            {isLast ? "Get Started" : "Continue"}
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
  skipBtn: {
    position: 'absolute',
    right: 20,
    zIndex: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: Radius.full,
    backgroundColor: 'rgba(255,255,255,0.1)',
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
    height: height * 0.55,
  },
  gradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: height * 0.25,
    backgroundColor: Colors.background,
    opacity: 0.95,
  },
  bottomCard: {
    backgroundColor: Colors.background,
    paddingHorizontal: 28,
    paddingTop: 8,
  },
  headline: {
    color: Colors.text,
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.bold,
    marginBottom: Spacing.md,
    lineHeight: 34,
  },
  subtext: {
    color: Colors.textSecondary,
    fontSize: FontSize.md,
    lineHeight: 26,
    marginBottom: Spacing.lg,
  },
  stepsContainer: {
    marginBottom: Spacing.lg,
    gap: Spacing.sm,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  stepNumText: {
    color: Colors.primary,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
  },
  stepText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: FontSize.md,
    lineHeight: 24,
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
