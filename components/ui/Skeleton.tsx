import { useEffect } from 'react';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';

interface SkeletonProps {
  className?: string;
}

/**
 * Generic shimmer skeleton block.
 *
 * Uses a shared opacity value oscillating between 0.35 and 1.0 with an
 * ease-in-out timing (1200ms). The animation is started exactly once in
 * a mount effect so re-renders of the parent do not spawn duplicate
 * animations (which would happen if withRepeat were called inline in
 * the style factory).
 *
 * Background uses `aura-surface-container-high` so the skeleton blends
 * with the surface in both light and dark modes.
 */
export function Skeleton({ className = '' }: SkeletonProps) {
  const opacity = useSharedValue(0.35);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
      -1, // infinite
      true, // reverse each iteration → breathing effect
    );
  }, [opacity]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      className={`bg-aura-surface-container-high ${className}`}
      style={animStyle}
    />
  );
}
