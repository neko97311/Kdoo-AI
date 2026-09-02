import { useState, useEffect } from 'react';
import { Keyboard, KeyboardEvent, Platform, LayoutAnimation, UIManager } from 'react-native';

// Enable LayoutAnimation on Android for smooth padding transitions
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * Detects keyboard visibility and height.
 * - iOS: uses keyboardWillShow/Hide for smooth pre-animation
 * - Android: uses keyboardDidShow/Hide + LayoutAnimation for post-animation smoothing
 */
export function useKeyboard(enabled = true) {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showListener = Keyboard.addListener(showEvent, (e: KeyboardEvent) => {
      if (Platform.OS === 'android') {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      }
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
    });

    const hideListener = Keyboard.addListener(hideEvent, () => {
      if (Platform.OS === 'android') {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      }
      setKeyboardHeight(0);
    });

    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, [enabled]);

  return {
    keyboardHeight,
    isKeyboardVisible: keyboardHeight > 0,
  };
}
