import { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet, Easing, ActivityIndicator } from 'react-native';

interface GeneratingImagePlaceholderProps {
  percent: number;
}

/**
 * Animated placeholder shown during AI image generation.
 * Renders a 3:2 box (matching ComfyUI 1296x864 output) with:
 *  - Very light background with fast subtle pulse
 *  - Small spinning loader + percentage text
 */
export function GeneratingImagePlaceholder({ percent }: GeneratingImagePlaceholderProps) {
  const bgPulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(bgPulse, {
          toValue: 1,
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(bgPulse, {
          toValue: 0,
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => { pulse.stop(); };
  }, []);

  const bgOpacity = bgPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.25],
  });

  const clampedPercent = Math.max(0, Math.min(100, percent));

  return (
    <View style={styles.container}>
      {/* Subtle pulsing overlay */}
      <Animated.View style={[styles.bgPulse, { opacity: bgOpacity }]} />

      {/* Center: small spinner + percentage */}
      <View style={styles.center}>
        <ActivityIndicator size="small" color="#9CA3AF" />
        <Text style={styles.percentText}>{clampedPercent}%</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    maxWidth: 280,
    aspectRatio: 1.5,
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    marginTop: 8,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bgPulse: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#D1D5DB',
  },
  center: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    zIndex: 1,
  },
  percentText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#6B7280',
  },
});
