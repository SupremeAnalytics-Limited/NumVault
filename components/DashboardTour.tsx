import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Dimensions,
  ScrollView, Animated, Easing,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const TOOLTIP_MARGIN = 12;
const HIGHLIGHT_PADDING = 8;

export type TourStep = {
  ref: React.RefObject<View | null>;
  title: string;
  body: string;
};

type Props = {
  visible: boolean;
  steps: TourStep[];
  scrollViewRef: React.RefObject<ScrollView | null>;
  onComplete: () => void;
};

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Compulsory, sequential coach-mark: scrolls to and highlights each real
 * card in order with an explanation, blocking the rest of the screen until
 * "Next" is tapped on every step. No skip, no tap-outside-to-dismiss — by
 * design, per the ask: force the walkthrough once, so the numbers on this
 * screen (validated customers, checkpoints, cycles...) aren't a mystery.
 */
export default function DashboardTour({ visible, steps, scrollViewRef, onComplete }: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
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
    if (!rect) return;
    // fade shares a node with glow's borderColor animation below (the
    // highlight box), so both must run on the JS driver — mixing a
    // natively-driven and JS-driven animated value on the same Animated.View
    // is unreliable in release builds.
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: false }).start();

    glowLoop.current?.stop();
    glow.setValue(0);
    glowLoop.current = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(glow, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ]),
    );
    glowLoop.current.start();

    return () => { glowLoop.current?.stop(); };
  }, [rect]);

  const measureAndScrollToStep = (index: number) => {
    const step = steps[index];
    if (!step?.ref.current) { setRect(null); return; }
    setMeasuring(true);

    step.ref.current.measureInWindow((x, y, width, height) => {
      // Bring the card into a comfortable viewing band (upper-middle of screen)
      // before taking the final measurement used to draw the highlight.
      const targetBand = SCREEN_HEIGHT * 0.32;
      const delta = y - targetBand;
      if (Math.abs(delta) > 24 && scrollViewRef.current) {
        // We don't track absolute scroll offset here, so nudge by the on-screen
        // delta — accurate enough since we re-measure after the animation settles.
        scrollViewRef.current.scrollTo({
          y: Math.max(0, delta),
          animated: true,
        });
        setTimeout(() => {
          step.ref.current?.measureInWindow((x2, y2, w2, h2) => {
            setRect({ x: x2, y: y2, width: w2, height: h2 });
            setMeasuring(false);
          });
        }, 380);
      } else {
        setRect({ x, y, width, height });
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

  // Position the tooltip above or below the highlighted card, whichever fits.
  const spaceBelow = rect ? SCREEN_HEIGHT - (rect.y + rect.height) : 0;
  const placeBelow = rect ? spaceBelow > 220 : true;
  const tooltipTop = rect
    ? placeBelow
      ? rect.y + rect.height + HIGHLIGHT_PADDING + TOOLTIP_MARGIN
      : undefined
    : undefined;
  const tooltipBottom = rect && !placeBelow
    ? SCREEN_HEIGHT - (rect.y - HIGHLIGHT_PADDING) + TOOLTIP_MARGIN
    : undefined;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="auto">
      {/* Full-screen blocking backdrop — no tap-outside dismiss by design */}
      <View style={styles.backdrop} />

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
        <TouchableOpacity style={styles.nextBtn} onPress={handleNext} activeOpacity={0.85}>
          <Text style={styles.nextBtnText}>{isLast ? "Got it" : 'Next'}</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
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
  nextBtn: {
    marginTop: Spacing.sm,
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    paddingVertical: 12,
    alignItems: 'center',
  },
  nextBtnText: { color: Colors.black, fontWeight: FontWeight.bold, fontSize: FontSize.md },
});
