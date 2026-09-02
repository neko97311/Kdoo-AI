import React, { useState, useEffect } from 'react';
import {
  View,
  ViewProps,
  Platform,
  Keyboard,
  KeyboardEvent,
  LayoutAnimation,
  UIManager,
  KeyboardAvoidingView as RNKeyboardAvoidingView,
} from 'react-native';
import Constants from 'expo-constants';

// Enable LayoutAnimation on Android for smooth padding transitions
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface KeyboardAvoidingViewProps extends ViewProps {
  /**
   * Distance between the top of the screen and the top of the
   * keyboard, used by iOS to offset the KAV correctly.
   * Pass `insets.top` from useSafeAreaInsets.
   *
   * iOS-only; ignored on Android and Web.
   *
   * @default 0
   */
  keyboardVerticalOffset?: number;
}

/**
 * Cross-platform KeyboardAvoidingView wrapper.
 *
 * - **Android (standalone build)**: plain View. Edge-to-edge is disabled in
 *   `MainActivity.kt`, so Android's `adjustResize` windowSoftInputMode works
 *   correctly — the system natively resizes the window when the keyboard
 *   appears. No JS-level avoidance needed.
 * - **Android (Expo Go)**: manual `paddingBottom = keyboardHeight`. Expo Go's
 *   `MainActivity` cannot be modified, so edge-to-edge remains enabled and
 *   `adjustResize` is bypassed. The keyboard event's `endCoordinates.height`
 *   is used directly as padding to push content above the keyboard.
 * - **iOS**: delegates to RN's built-in `KeyboardAvoidingView` with
 *   `behavior="padding"`.
 * - **Web**: plain View (no keyboard avoidance needed).
 */
export function KeyboardAvoidingView({
  children,
  style,
  keyboardVerticalOffset = 0,
  ...props
}: KeyboardAvoidingViewProps) {
  // RN 0.85+ ReactActivityDelegate unconditionally enables edge-to-edge in
  // super.onCreate, bypassing Android's windowSoftInputMode="adjustResize"
  // on all environments (Expo Go / dev-client / standalone). The
  // setDecorFitsSystemWindows(window, true) workaround in MainActivity.kt
  // is called AFTER super.onCreate and cannot reliably restore adjustResize.
  // Therefore Android always needs JS-side manual paddingBottom.
  const useManualPadding = Platform.OS === 'android';

  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (!useManualPadding) return;

    const showSub = Keyboard.addListener('keyboardDidShow', (e: KeyboardEvent) => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [useManualPadding]);

  if (Platform.OS === 'web') {
    return (
      <View style={[{ flex: 1 }, style]} {...props}>
        {children}
      </View>
    );
  }

  // Android standalone build: adjustResize handles keyboard avoidance natively
  // (edge-to-edge disabled in MainActivity.kt).
  // Android Expo Go: manual paddingBottom (edge-to-edge can't be disabled).
  if (Platform.OS === 'android') {
    if (useManualPadding) {
      return (
        <View
          style={[{ flex: 1, paddingBottom: keyboardHeight }, style]}
          {...props}
        >
          {children}
        </View>
      );
    }
    return (
      <View style={[{ flex: 1 }, style]} {...props}>
        {children}
      </View>
    );
  }

  // iOS: RN's built-in KAV works reliably here.
  return (
    <RNKeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={keyboardVerticalOffset}
      style={[{ flex: 1 }, style]}
      {...props}
    >
      {children}
    </RNKeyboardAvoidingView>
  );
}
