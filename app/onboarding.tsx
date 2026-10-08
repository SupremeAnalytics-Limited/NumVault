// cache-bust: build-v5
import React, { useState, useRef } from 'react';
import {
  View, Text, StyleSheet, Dimensions, TouchableOpacity,
  ScrollView, StatusBar,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '@/template';
import { trackOnboardingCompleted } from '@/services/sentryService';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { APP_ONBOARDING_SEEN_KEY } from '@/constants/config';

const { width, height } = Dimensions.get('window');

// ── Screen definitions ────────────────────────────────────────────────────────
const SCREENS = [
  {
    image: require('@/assets/images/nv_s1.png'),
    imageOpacity: 1,
    coverBottom: true,
    coverTop: false,
    coverFull: false,
    coverMiddle: false,
    tag: null as null | string,
    headline: 'Use a virtual number instead.',
    body: null as null | string,
    steps: null as null | string[],
    bulletSections: [
      {
        intro: 'Every app and sign-up asking for your real number creates another opportunity for:',
        items: ['Spam', 'Unwanted calls', 'Data Leak', 'Other privacy risks'],
      },
      {
        intro: 'Use a virtual number for:',
        items: ['Business separation', 'Project separation', 'Developer testing', 'More'],
      },
    ] as null | { intro: null | string; items: string[] }[],
  },
  {
    image: require('@/assets/images/nv_s2.png'),
    imageOpacity: 1,
    coverBottom: false,
    coverTop: false,
    coverFull: false,
    coverMiddle: false,
    tag: null as null | string,
    headline: '2,300+ apps & services',
    body: null as null | string,
    steps: null,
    bulletSections: [
      {
        intro: null as null | string,
        items: [
          'No subscription',
          'No rent',
          'Pay as you go',
          'Pay only when you need a number',
          'No monthly commitment',
          'Your purchased number belongs to you for that service',
        ],
      },
    ] as null | { intro: null | string; items: string[] }[],
  },
  {
    image: require('@/assets/images/nv_s3.png'),
    imageOpacity: 1,
    coverBottom: true,
    coverTop: false,
    coverFull: false,
    coverMiddle: true,
    tag: null,
    headline: "Here's exactly how it works",
    body: null,
    bulletSections: null,
    steps: [
      'Choose a service',
      'Pick a number',
      'Pay & transfer securely',
      'Request your OTP',
      'Get your code',
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
    try { await AsyncStorage.setItem(APP_ONBOARDING_SEEN_KEY, '1'); } catch { /* non-fatal */ }
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
              style={[styles.illustration, { opacity: s.imageOpacity }]}
              contentFit="cover"
              transition={300}
            />
            {s.coverMiddle && (
              <View style={styles.imageMiddleCover} />
            )}
            {s.coverFull && (
              <View style={styles.imageFullCover} />
            )}
            {s.coverTop && !s.coverFull && (
              <LinearGradient
                colors={[Colors.background, 'transparent']}
                style={styles.imageTopCover}
              />
            )}
            <View style={styles.gradient} />
            {s.coverBottom && (
              <LinearGradient
                colors={['transparent', Colors.background]}
                style={styles.imageBottomCover}
              />
            )}
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
        {screen.body ? <Text style={styles.body}>{screen.body}</Text> : null}

        {screen.bulletSections ? (
          <View style={styles.bulletSectionsWrap}>
            {screen.bulletSections.map((section, si) => (
              <View key={si} style={si > 0 ? styles.bulletSectionGap : undefined}>
                {section.intro ? <Text style={styles.bulletIntro}>{section.intro}</Text> : null}
                {section.items.map((item, ii) => (
                  <View key={ii} style={styles.bulletRow}>
                    <Text style={styles.bulletDot}>•</Text>
                    <Text style={styles.bulletText}>{item}</Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        ) : null}

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
    height: height * 0.08,
    backgroundColor: Colors.background,
    opacity: 1,
  },
  imageMiddleCover: {
    position: 'absolute',
    top: height * 0.22,
    left: 0,
    right: 0,
    height: height * 0.20,
    backgroundColor: Colors.background,
    zIndex: 2,
  },
  imageFullCover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: height * 0.52,
    backgroundColor: Colors.background,
    zIndex: 2,
  },
  imageTopCover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: height * 0.42,
    zIndex: 2,
  },
  imageBottomCover: {
    position: 'absolute',
    bottom: height * 0.08,
    left: 0,
    right: 0,
    height: height * 0.42,
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
  bulletSectionsWrap: {
    gap: 12,
    marginTop: 4,
  },
  bulletSectionGap: {
    marginTop: 4,
  },
  bulletIntro: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    lineHeight: 20,
    marginBottom: 6,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 4,
  },
  bulletDot: {
    color: Colors.primary,
    fontSize: FontSize.sm,
    lineHeight: 20,
  },
  bulletText: {
    flex: 1,
    color: Colors.text,
    fontSize: FontSize.sm,
    lineHeight: 20,
    fontWeight: FontWeight.medium,
  },
});
