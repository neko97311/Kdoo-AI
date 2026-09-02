import { useEffect, useRef } from 'react';
import { View, Text, Pressable, Animated, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useToastStore } from '@/stores/toast';
import { useResolvedScheme } from '@/hooks/useColors';

/**
 * Global toast host. Mount once near the top of the Z-order (see `app/_layout.tsx`).
 * Reads from `useToastStore` and renders the most recent toasts as
 * top-anchored, auto-dismissing pills. Tapping a pill dismisses it early.
 *
 * Design reference: Doubao (豆包) top warning toast — small card dropping
 * from the top of the screen with an icon + single line of text.
 */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const hideToast = useToastStore((s) => s.hideToast);
  const insets = useSafeAreaInsets();
  const isDark = useResolvedScheme() === 'dark';

  // Position just below the header (not pinned to the very top edge, not
  // floating mid-content) so it reads as a clean top banner.
  const topOffset = insets.top + 64;

  // Cap visual rendering to the latest 3 — the store keeps all for timer
  // correctness, but the UI only shows the newest few to avoid overflow.
  const visible = toasts.slice(-3);

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: topOffset,
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 9999,
        elevation: 9999,
      }}
    >
      <View pointerEvents="box-none" style={{ gap: 8, width: '100%', alignItems: 'center' }}>
        {visible.map((toast) => (
          <ToastItem
            key={toast.id}
            id={toast.id}
            message={toast.message}
            variant={toast.variant}
            isDark={isDark}
            onDismiss={hideToast}
          />
        ))}
      </View>
    </View>
  );
}

interface ToastItemProps {
  id: string;
  message: string;
  variant: 'default' | 'warning' | 'success';
  isDark: boolean;
  onDismiss: (id: string) => void;
}

function ToastItem({ id, message, variant, isDark, onDismiss }: ToastItemProps) {
  // Slide-down + fade-in: opacity 0→1, translateY -8→0 over ~200ms.
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isWarning = variant === 'warning';
  const isSuccess = variant === 'success';

  // White card + black text — matches the app's light card style (see
  // UpdateModal). Warning keeps an amber icon; success a green checkmark.
  // Border + shadow are deliberately strong so the toast lifts off any
  // background (chat bubbles, headers, blank screens).
  const containerStyle = isDark
    ? { backgroundColor: '#1a1b1e', borderColor: '#3a3b3e' }
    : { backgroundColor: '#ffffff', borderColor: '#e5e7eb' };
  const textColor = isDark ? '#e6e8ea' : '#191c1e';
  // Warning keeps an amber icon to signal caution; success a green checkmark;
  // default uses the text color.
  const iconColor = isSuccess ? '#22c55e' : isWarning ? '#f5a623' : textColor;
  const iconName = isSuccess ? 'checkmark-circle' : isWarning ? 'alert-circle' : 'information-circle';

  return (
    <Animated.View
      pointerEvents="auto"
      style={{
        opacity,
        transform: [{ translateY }],
        maxWidth: '90%',
      }}
    >
      <Pressable
        onPress={() => onDismiss(id)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: 12,
          borderWidth: 1.5,
          ...containerStyle,
          // Shadow MUST live on the same element as backgroundColor —
          // iOS renders shadow from opaque contents; a transparent
          // wrapper (Animated.View above) produces no visible shadow.
          ...Platform.select({
            ios: { shadowColor: '#000', shadowOpacity: 0.16, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
            android: { elevation: 6 },
            default: {},
          }),
        }}
      >
        <Ionicons
          name={iconName as any}
          size={16}
          color={iconColor}
          style={{ marginRight: 8 }}
        />
        <Text
          numberOfLines={2}
          style={{
            color: textColor,
            fontSize: 14,
            fontWeight: '500',
            includeFontPadding: false,
          }}
        >
          {message}
        </Text>
      </Pressable>
    </Animated.View>
  );
}
