import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View, Text, Animated, StyleSheet, Easing } from 'react-native';

interface ImageContentProps {
  uri: string;
  alt?: string;
  onPress?: (uri: string) => void;
  maxWidth?: number;
}

export function ImageContent({ uri, alt, onPress, maxWidth }: ImageContentProps) {
  // Default 3:2 to match ComfyUI output (1296x864).
  // Updated to true ratio onLoad once dimensions are known.
  const [aspectRatio, setAspectRatio] = useState(1.5);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const opacity = useRef(new Animated.Value(0)).current;

  // Fade the image in gently once loaded, so the placeholder → image
  // transition doesn't "pop" and flash the page.
  useEffect(() => {
    if (status === 'loaded') {
      Animated.timing(opacity, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    }
  }, [status, opacity]);

  const containerStyle = [
    styles.container,
    { aspectRatio, maxWidth: maxWidth ?? 280 },
  ];

  return (
    <Pressable onPress={() => onPress?.(uri)} style={styles.wrapper}>
      <View style={containerStyle}>
        {/* No spinner during loading — plain gray background only.
            A spinner after the 100% placeholder looked like "reloading".
            The gray background (same family as placeholder) provides a
            seamless transition: placeholder → gray box → image fades in. */}
        {/* Error state */}
        {status === 'error' && (
          <Text style={styles.errorText}>Failed to load image</Text>
        )}
        {/* Only render Image when not in error state.
            Image stays mounted but invisible until loaded (opacity trick)
            so onLoad fires without layout shift. */}
        {status !== 'error' && (
          <Animated.Image
            source={{ uri }}
            style={[styles.image, status !== 'loaded' && styles.imageHidden, { opacity }]}
            accessibilityLabel={alt}
            onLoad={(e) => {
              const { width, height } = e.nativeEvent.source;
              if (width && height) {
                setAspectRatio(width / height);
              }
              setStatus('loaded');
            }}
            onError={() => setStatus('error')}
          />
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    marginTop: 8,
  },
  container: {
    width: '100%',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
    resizeMode: 'contain',
  },
  // While loading, keep Image in DOM but invisible so onLoad fires,
  // without it taking visual space or pushing the spinner.
  imageHidden: {
    opacity: 0,
  },
  errorText: {
    color: '#9CA3AF',
    fontSize: 13,
  },
});
