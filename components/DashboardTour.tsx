import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Dimensions,
  ScrollView, Animated, Easing,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get('window');
const TOOLTIP_MARGIN = 12;
const HIGHLIGHT_PADDING = 8;

export type TourStep = {
  ref?: React.RefObject<View | null>;
  title: string;
  body: string;
};

type Props = {
  visible: boolean;
  steps: TourStep[];
  scrollViewRef?: React.RefObject<ScrollView | null> | null;
  onComplete: () => void;
  skippable?: boolean;
  onSkip?: () => void;
};

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Sequential coach-mark overlay. When a step has no ref the tooltip is
 * centered on screen with no highlight box. When skippable=true a Skip
 * button is shown alongside Next/Got it.
 */
export default function DashboardTour({
  visible, steps, scrollViewRef, onComplete, skippable = false, onSkip,
}: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [stepKey, setStepKey] = useState(0);
  const [measuring, setMeasuring] = useState(false);
  const fade = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    setStepIndex(0);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    measureAndScrollToStep(stepIndex);
  }, [visible, stepIndex]);

  const glowLoop = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: false }).start();

    if (rect) {
      glowLoop.current?.stop();
      glow.setValue(0);
      glowLoop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(glow, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
          Animated.timing(glow, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        ]),
      );
      glowLoop.current.start();
    } else {
      glowLoop.current?.stop();
    }

    return () => { glowLoop.current?.stop(); };
  }, [stepKey]);

  const measureAndScrollToStep = (index: number) => {
    const step = steps[index];
    if (!step?.ref?.current) {
      setRect(null);
      setStepKey((k) => k + 1);
      return;
    }
    setMeasuring(true);

    step.ref.current.measureInWindow((x, y, width, height) => {
      const targetBand = SCREEN_HEIGHT * 0.32;
      const delta = y - targetBand;
      if (Math.abs(delta) > 24 && scrollViewRef?.current) {
        scrollViewRef.current.scrollTo({ y: Math.max(0, delta), animated: true });
        setTimeout(() => {
          step.ref!.current?.measureInWindow((x2, y2, w2, h2) => {
            setRect({ x: x2, y: y2, width: w2, height: h2 });
            setStepKey((k) => k + 1);
            setMeasuring(false);
          });
        }, 380);
      } else {
        setRect({ x, y, width, height });
        setStepKey((k) => k + 1);
        setMeasuring(false);
      }
    });
  };

  if (!visible || steps.length === 0) return null;

  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  const handleNext = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (isLast) {
      onComplete();
    } else {
      setStepIndex((i) => i + 1);
    }
  };

  const handleSkip = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSkip?.();
  };

  let tooltipTop: number | undefined;
  let tooltipBottom: number | undefined;

  if (rect) {
    const spaceBelow = SCREEN_HEIGHT - (rect.y + rect.height);
    const placeBelow = spaceBelow > 220;
    tooltipTop = placeBelow ? rect.y + rect.height + HIGHLIGHT_PADDING + TOOLTIP_MARGIN : undefined;
    tooltipBottom = !placeBelow ? SCREEN_HEIGHT - (rect.y - HIGHLIGHT_PADDING) + TOOLTIP_MARGIN : undefined;
  } else {
    tooltipTop = SCREEN_HEIGHT / 2 - 120;
  }

  // Spotlight: when a target is measured, dim everything EXCEPT the target by
  // drawing four panels around it, so the highlighted content stays fully
  // visible instead of sitting under the dark overlay.
  let holeLeft = 0, holeTop = 0, holeRight = 0, holeBottom = 0;
  if (rect) {
    holeLeft = Math.max(0, rect.x - HIGHLIGHT_PADDING);
    holeTop = Math.max(0, rect.y - HIGHLIGHT_PADDING);
    holeRight = Math.min(SCREEN_WIDTH, rect.x + rect.width + HIGHLIGHT_PADDING);
    holeBottom = Math.min(SCREEN_HEIGHT, rect.y + rect.height + HIGHLIGHT_PADDING);
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="auto">
      {rect && !measuring ? (
        <>
          <View style={[styles.backdropPanel, { top: 0, left: 0, right: 0, height: holeTop }]} />
          <View style={[styles.backdropPanel, { top: holeBottom, left: 0, right: 0, bottom: 0 }]} />
          <View style={[styles.backdropPanel, { top: holeTop, left: 0, width: holeLeft, height: holeBottom - holeTop }]} />
          <View style={[styles.backdropPanel, { top: holeTop, left: holeRight, right: 0, height: holeBottom - holeTop }]} />
        </>
      ) : (
        <View style={styles.backdrop} />
      )}

      {rect && !measuring ? (
        <Animated.View
          style={[
            styles.highlight,
            {
              left: rect.x - HIGHLIGHT_PADDING,
              top: rect.y - HIGHLIGHT_PADDING,
              width: rect.width + HIGHLIGHT_PADDING * 2,
              height: rect.height + HIGHLIGHT_PADDING * 2,
              opacity: fade,
              borderColor: glow.interpolate({
                inputRange: [0, 1],
                outputRange: [Colors.primary, '#ffffff'],
              }),
            },
          ]}
          pointerEvents="none"
        />
      ) : null}

      <Animated.View
        style={[
          styles.tooltip,
          tooltipTop !== undefined ? { top: tooltipTop } : { bottom: tooltipBottom },
          { opacity: fade },
        ]}
      >
        <Text style={styles.stepCounter}>{stepIndex + 1} of {steps.length}</Text>
        <Text style={styles.title}>{step.title}</Text>
        <Text style={styles.body}>{step.body}</Text>
        <View style={styles.btnRow}>
          {skippable && (
            <TouchableOpacity style={styles.skipBtn} onPress={handleSkip} activeOpacity={0.85}>
              <Text style={styles.skipBtnText}>Skip</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.nextBtn, skippable && styles.nextBtnFlex]}
            onPress={handleNext}
            activeOpacity={0.85}
          >
            <Text style={styles.nextBtnText}>{isLast ? 'Got it' : 'Next'}</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  backdropPanel: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  highlight: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: Radius.lg,
    backgroundColor: 'transparent',
  },
  tooltip: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.primary,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    gap: 6,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  stepCounter: {
    color: Colors.primary,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  title: { color: Colors.text, fontSize: FontSize.md, fontWeight: FontWeight.bold },
  body: { color: Colors.textSecondary, fontSize: FontSize.sm, lineHeight: 20 },
  btnRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  skipBtn: {
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md,
    paddingVertical: 12,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
  },
  skipBtnText: { color: Colors.textSecondary, fontWeight: FontWeight.semibold, fontSize: FontSize.sm },
  nextBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    paddingVertical: 12,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
  },
  nextBtnFlex: { flex: 1 },
  nextBtnText: { color: Colors.black, fontWeight: FontWeight.bold, fontSize: FontSize.md },
});
