import { useEffect, useRef } from 'react';
import { View, Animated } from 'react-native';

const DOT_COUNT = 3;
const DOT_SIZE = 6;
const DOT_GAP = 6;
const WAVE_HEIGHT = 5;
const PHASE_DELAY = 160; // ms between each dot

interface TypingDotsProps {
  color?: string;
}

/** Pure animated dots — no container. Drop into any bubble. */
export function TypingDots({ color = '#1D4ED8' }: TypingDotsProps) {
  const anims = useRef(
    Array.from({ length: DOT_COUNT }, () => new Animated.Value(0))
  ).current;

  useEffect(() => {
    const loops: Animated.CompositeAnimation[] = [];

    anims.forEach((anim, i) => {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.delay(i * PHASE_DELAY),
          Animated.timing(anim, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0, duration: 300, useNativeDriver: true }),
          Animated.delay((DOT_COUNT - 1 - i) * PHASE_DELAY),
        ])
      );
      loop.start();
      loops.push(loop);
    });

    return () => loops.forEach((l) => l.stop());
  }, []);

  const dotStyle = (anim: Animated.Value) => ({
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    backgroundColor: color,
    transform: [{
      translateY: anim.interpolate({
        inputRange: [0, 1],
        outputRange: [0, -WAVE_HEIGHT],
      }),
    }],
    opacity: anim.interpolate({
      inputRange: [0, 0.5, 1],
      outputRange: [0.4, 0.7, 1],
    }),
  });

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: DOT_GAP }}>
      {anims.map((anim, i) => (
        <Animated.View key={i} style={dotStyle(anim)} />
      ))}
    </View>
  );
}

/** Standalone typing indicator for user pending messages (renders its own bubble). */
interface TypingIndicatorProps {
  variant?: 'ai' | 'user';
}

export function TypingIndicator({ variant = 'ai' }: TypingIndicatorProps) {
  const isUser = variant === 'user';

  if (isUser) {
    return (
      <View className="flex-col items-end gap-0.5 self-end max-w-[90%]">
        <View
          style={{
            borderRadius: 8,
            borderTopRightRadius: 2,
            borderWidth: 1,
            borderColor: 'rgba(22,119,255,0.15)',
            backgroundColor: '#E8F3FF',
            paddingHorizontal: 16,
            paddingVertical: 12,
          }}
        >
          <TypingDots color="#1677FF" />
        </View>
      </View>
    );
  }

  return (
    <View
      className="flex-row items-center self-start"
      style={{ paddingHorizontal: 16, paddingVertical: 12 }}
    >
      <TypingDots color="#1D4ED8" />
    </View>
  );
}
