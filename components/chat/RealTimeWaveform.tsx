import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

interface RealTimeWaveformProps {
  /**
   * Normalised amplitude 0..1. Caller is responsible for converting dBFS
   * to this range. On web where no metering is available this stays at 0
   * and the waveform sits at its idle baseline.
   */
  amplitude: number;
  isSlideCancel: boolean;
  /** Number of bars in the rolling history. Default 30. */
  barCount?: number;
  /** Maximum height (px) of the tallest bar when amplitude = 1. */
  maxBarHeight?: number;
  /** Bar width in px. */
  barWidth?: number;
  /** Gap between bars in px. */
  barGap?: number;
  /** Override the recording color. Defaults to white. */
  colorOverride?: string;
}

const RECORDING_COLOR = '#FFFFFF';
const CANCEL_COLOR = '#DC2626';

/**
 * Rolling-history waveform — each frame the latest amplitude is pushed
 * into the front of a buffer and old samples slide rightward. When the
 * user stops talking the bars naturally taper off (newer amplitude = 0)
 * producing the "波浪起伏 / 逐步消失" effect called for in the spec.
 *
 * Each bar reads from `sharedHistory[i]` and animates its height via a
 * Reanimated useAnimatedStyle, so audio frames never round-trip through
 * the React tree.
 */
export function RealTimeWaveform({
  amplitude,
  isSlideCancel,
  barCount = 45,
  maxBarHeight = 32,
  barWidth = 3,
  barGap = 4,
  colorOverride,
}: RealTimeWaveformProps) {
  // sharedHistory[i] holds the smoothed amplitude for the i-th oldest
  // sample in the rolling buffer (index 0 = newest).
  const sharedHistory = useSharedValue<number[]>(
    new Array(barCount).fill(0),
  );

  // Mirror the latest amplitude prop into a ref so the ticker can read
  // it without re-subscribing on every change.
  const amplitudeRef = useRef(amplitude);
  amplitudeRef.current = amplitude;

  // CRITICAL: a fixed-interval ticker — NOT a useEffect([amplitude]).
  // The old useEffect approach only pushed when amplitude CHANGED. When
  // the user stopped talking, setAmplitude(0) fired once, React bailed
  // out on subsequent identical 0s, and the history froze with stale
  // speech values — so the waveform never decayed back to silence.
  //
  // The ticker fires every 50ms (synced with the metering poll in
  // ChatInputBar) and always pushes the current amplitude, even if it's
  // 0. This makes the rolling buffer flush stale values so bars
  // naturally taper off when speech stops.
  useEffect(() => {
    const interval = setInterval(() => {
      const current = sharedHistory.value;
      const next = [amplitudeRef.current, ...current.slice(0, barCount - 1)];
      sharedHistory.value = next;
    }, 50);
    return () => clearInterval(interval);
  }, [barCount, sharedHistory]);

  const color = isSlideCancel ? CANCEL_COLOR : (colorOverride ?? RECORDING_COLOR);
  const indices = new Array(barCount).fill(0).map((_, i) => i);

  return (
    <View
      style={[styles.row, { gap: barGap, height: maxBarHeight + 8 }]}
      accessibilityRole="image"
      accessibilityLabel={isSlideCancel ? 'release to cancel' : 'voice waveform'}
    >
      {indices.map((i) => (
        <AnimatedBar
          key={i}
          index={i}
          barCount={barCount}
          sharedHistory={sharedHistory}
          color={color}
          maxBarHeight={maxBarHeight}
          barWidth={barWidth}
        />
      ))}
    </View>
  );
}

interface AnimatedBarProps {
  index: number;
  barCount: number;
  sharedHistory: SharedValue<number[]>;
  color: string;
  maxBarHeight: number;
  barWidth: number;
}

function AnimatedBar({
  index,
  barCount,
  sharedHistory,
  color,
  maxBarHeight,
  barWidth,
}: AnimatedBarProps) {
  const display = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => {
    const target = sharedHistory.value[index] ?? 0;
    display.value = withTiming(target, {
      duration: 90 + index * 4,
      easing: Easing.out(Easing.quad),
    });
    const v = display.value;
    const minH = 6;
    // Square-curve: low-amplitude sounds stay visible (taller idle),
    // mid-range gets a bigger swing so the bars look "alive" during
    // normal speech, peak hits maxBarHeight at v=1.
    const eased = v * v * 0.4 + v * 0.6;
    const h = minH + eased * maxBarHeight;
    return { height: h };
  });

  return (
    <Animated.View
      style={[
        styles.bar,
        { width: barWidth, backgroundColor: color },
        animatedStyle,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bar: {
    borderRadius: 999,
  },
});
