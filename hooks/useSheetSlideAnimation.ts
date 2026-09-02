import { useEffect, useRef } from 'react';
import { Animated, Dimensions, Easing } from 'react-native';

export function useSheetSlideAnimation(visible: boolean) {
  const screenH = Dimensions.get('window').height;
  const translateY = useRef(new Animated.Value(screenH)).current;

  useEffect(() => {
    Animated.timing(translateY, {
      toValue: visible ? 0 : screenH,
      duration: visible ? 280 : 240,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, screenH, translateY]);

  return translateY;
}
