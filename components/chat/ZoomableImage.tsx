import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  StyleSheet,
  Text,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector, State } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { i18n } from '@/i18n';

// ─── Tunables ──────────────────────────────────────────────

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
/** scale 超过该阈值视为"已放大"。 */
const ZOOM_EPSILON = 0.01;
/** 下滑关闭的位移阈值(px) / 速度阈值(px/s)。 */
const DISMISS_THRESHOLD = 120;
const DISMISS_VELOCITY = 1000;
const DISMISS_FADE_RANGE = 400;
const DISMISS_MIN_OPACITY = 0.45;
/** 下滑关闭时随位移缩小的区间与下限。 */
const SWIPE_SCALE_RANGE = 500;
const SWIPE_MIN_SCALE = 0.85;
/** 拖出边界时的橡皮筋阻尼系数(0-1,越大越跟手)。 */
const RUBBER_BAND = 0.3;

type LoadStatus = 'loading' | 'loaded' | 'error';

export interface ZoomableImageProps {
  uri: string;
  /** 未放大状态下的单击(overlay 用它关闭)。 */
  onTap?: () => void;
  /** 未放大状态下纵向拖拽超过阈值时触发;提供该回调即启用下滑关闭。 */
  onSwipeClose?: () => void;
  /** 放大状态变化回调(供外部调整 chrome)。 */
  onZoomChange?: (zoomed: boolean) => void;
}

// ─── Worklet helpers ───────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  'worklet';
  return Math.min(Math.max(v, lo), hi);
}

/** 硬限制之外的部分按橡皮筋系数衰减。 */
function rubberBand(v: number, maxOffset: number): number {
  'worklet';
  const base = clamp(v, -maxOffset, maxOffset);
  return base + (v - base) * RUBBER_BAND;
}

/** scale 下内容可平移的最大偏移(以容器中心为缩放原点)。 */
function maxOffsetFor(scale: number, dimension: number): number {
  'worklet';
  return ((scale - 1) * dimension) / 2;
}

// ─── Component ─────────────────────────────────────────────

/**
 * 可缩放图片:双指捏合(1x-4x)、放大态自由平移(边界橡皮筋 + 回弹)、
 * 双击以触点为中心放大/复位、未放大时下滑关闭、未放大时单击回调。
 * 所有逐帧数值走 reanimated shared value,React state 只承载加载/错误标记。
 */
export function ZoomableImage({ uri, onTap, onSwipeClose, onZoomChange }: ZoomableImageProps) {
  const [status, setStatus] = useState<LoadStatus>('loading');

  // ── Gesture state(shared values,全部 UI 线程) ──
  const scale = useSharedValue(MIN_SCALE);
  const startScale = useSharedValue(MIN_SCALE);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const opacity = useSharedValue(1);
  const zoomedFlag = useSharedValue(false);
  const swipeEnabled = useSharedValue(!!onSwipeClose);
  const width = useSharedValue(Dimensions.get('window').width);
  const height = useSharedValue(Dimensions.get('window').height);
  /** pan 手动激活判定用的首个触点坐标(静止态横向要让给外层横向分页列表)。 */
  const startTouchX = useSharedValue(0);
  const startTouchY = useSharedValue(0);

  // ── 回调走 latest-ref,手势闭包永远拿到最新引用 ──
  const tapRef = useRef(onTap);
  const swipeCloseRef = useRef(onSwipeClose);
  const zoomChangeRef = useRef(onZoomChange);
  useEffect(() => {
    tapRef.current = onTap;
    swipeCloseRef.current = onSwipeClose;
    zoomChangeRef.current = onZoomChange;
    swipeEnabled.value = !!onSwipeClose;
  });

  const invokeTap = useCallback(() => tapRef.current?.(), []);
  const invokeSwipeClose = useCallback(() => swipeCloseRef.current?.(), []);
  const notifyZoomChange = useCallback((zoomed: boolean) => zoomChangeRef.current?.(zoomed), []);

  /** 仅在放大状态真正翻转时通知外部。 */
  const updateZoomFlag = (next: boolean) => {
    'worklet';
    if (zoomedFlag.value === next) return;
    zoomedFlag.value = next;
    runOnJS(notifyZoomChange)(next);
  };

  /** 把平移回弹到 scale s 下的合法边界(worklet 上下文)。 */
  const clampTranslate = (s: number) => {
    'worklet';
    const maxX = maxOffsetFor(s, width.value);
    const maxY = maxOffsetFor(s, height.value);
    translateX.value = withSpring(clamp(translateX.value, -maxX, maxX));
    translateY.value = withSpring(clamp(translateY.value, -maxY, maxY));
  };

  // 切换图片时重置全部手势状态。
  useEffect(() => {
    scale.value = MIN_SCALE;
    translateX.value = 0;
    translateY.value = 0;
    startX.value = 0;
    startY.value = 0;
    opacity.value = 1;
    zoomedFlag.value = false;
    setStatus('loading');
    onZoomChange?.(false);
    // onZoomChange 走 latest-ref,这里只需在 uri 变化时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  // ── Gestures ──
  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      'worklet';
      startScale.value = scale.value;
      startX.value = translateX.value;
      startY.value = translateY.value;
    })
    .onUpdate((event) => {
      'worklet';
      // 逐帧以焦点为锚点做增量缩放:内容大致留在指尖下。
      const next = clamp(startScale.value * event.scale, MIN_SCALE, MAX_SCALE);
      const growth = next / scale.value;
      const offsetX = event.focalX - width.value / 2;
      const offsetY = event.focalY - height.value / 2;
      translateX.value = translateX.value * growth - offsetX * (growth - 1);
      translateY.value = translateY.value * growth - offsetY * (growth - 1);
      scale.value = next;
    })
    .onEnd(() => {
      'worklet';
      // 结束后硬性收敛回 [1, 4]:捏过头则整体回弹到静止态。
      const target = clamp(scale.value, MIN_SCALE, MAX_SCALE);
      if (target <= MIN_SCALE + ZOOM_EPSILON) {
        scale.value = withSpring(MIN_SCALE);
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        updateZoomFlag(false);
      } else {
        scale.value = withSpring(target);
        clampTranslate(target);
        updateZoomFlag(true);
      }
    });

  const panGesture = Gesture.Pan()
    // 手动激活:默认 Pan 一拖动就接管触控,会把外层横向分页列表(FlatList)
    // 的滚动抢走 → 多图左右切不动。这里按方向决策:放大态或"静止态纵向且
    // 允许下滑关闭"才真正接管;静止态横向一律 fail() 让给外层分页列表。
    .manualActivation(true)
    .onTouchesDown((e) => {
      'worklet';
      if (e.numberOfTouches > 0) {
        const t = e.allTouches[0];
        startTouchX.value = t.x;
        startTouchY.value = t.y;
      }
    })
    .onTouchesMove((e, manager) => {
      'worklet';
      const st = e.state;
      // 已激活/已终结就不再重复决策。
      if (st === State.ACTIVE || st === State.END || st === State.FAILED || st === State.CANCELLED) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = Math.abs(t.x - startTouchX.value);
      const dy = Math.abs(t.y - startTouchY.value);
      // 位移太小先不决策,避免小幅抖动误判方向。
      if (dx < 6 && dy < 6) return;
      if (scale.value > MIN_SCALE + ZOOM_EPSILON) {
        // 放大态:接管两轴平移(此时外层 FlatList 已 scrollEnabled=false)。
        manager.activate();
      } else if (dx > dy) {
        // 静止态横向:让给外层横向分页列表(photo-compose / overlay 翻页)。
        manager.fail();
      } else if (swipeEnabled.value) {
        // 静止态纵向且允许下滑关闭(overlay)。
        manager.activate();
      } else {
        // 静止态纵向但无下滑关闭(photo-compose):不占用触控。
        manager.fail();
      }
    })
    .onStart(() => {
      'worklet';
      startX.value = translateX.value;
      startY.value = translateY.value;
    })
    .onUpdate((event) => {
      'worklet';
      if (scale.value > MIN_SCALE + ZOOM_EPSILON) {
        // 放大态:自由平移,出界按橡皮筋衰减。
        const maxX = maxOffsetFor(scale.value, width.value);
        const maxY = maxOffsetFor(scale.value, height.value);
        translateX.value = rubberBand(startX.value + event.translationX, maxX);
        translateY.value = rubberBand(startY.value + event.translationY, maxY);
      } else if (swipeEnabled.value) {
        // 静止态:只处理纵向(忽略横向,避免与外层横向列表抢手势),
        // 下滑同时缩图 + 淡出。
        const dragY = Math.max(0, startY.value + event.translationY);
        translateX.value = 0;
        translateY.value = dragY;
        scale.value = interpolate(dragY, [0, SWIPE_SCALE_RANGE], [MIN_SCALE, SWIPE_MIN_SCALE], Extrapolation.CLAMP);
        opacity.value = interpolate(dragY, [0, DISMISS_FADE_RANGE], [1, DISMISS_MIN_OPACITY], Extrapolation.CLAMP);
      }
    })
    .onEnd((event) => {
      'worklet';
      if (scale.value > MIN_SCALE + ZOOM_EPSILON) {
        // 放大态:回弹到合法边界。
        clampTranslate(scale.value);
        return;
      }
      if (swipeEnabled.value && (translateY.value > DISMISS_THRESHOLD || event.velocityY > DISMISS_VELOCITY)) {
        // 先播放下滑淡出动画,再通知关闭。
        opacity.value = withTiming(0.15, { duration: 240 });
        translateY.value = withTiming(Math.max(height.value * 1.15, 640), { duration: 240 }, (finished) => {
          'worklet';
          if (finished) runOnJS(invokeSwipeClose)();
        });
      } else {
        // 未过阈值:整体回弹到静止态。
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        scale.value = withSpring(MIN_SCALE);
        opacity.value = withSpring(1);
        updateZoomFlag(false);
      }
    });

  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event) => {
      'worklet';
      if (scale.value > MIN_SCALE + ZOOM_EPSILON) {
        // 已放大:复位。
        scale.value = withSpring(MIN_SCALE);
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        updateZoomFlag(false);
      } else {
        // 以触点为中心放大:补偿平移,让触点下的内容留在触点下。
        const maxX = maxOffsetFor(DOUBLE_TAP_SCALE, width.value);
        const maxY = maxOffsetFor(DOUBLE_TAP_SCALE, height.value);
        scale.value = withSpring(DOUBLE_TAP_SCALE);
        translateX.value = withSpring(clamp((width.value / 2 - event.x) * (DOUBLE_TAP_SCALE - 1), -maxX, maxX));
        translateY.value = withSpring(clamp((height.value / 2 - event.y) * (DOUBLE_TAP_SCALE - 1), -maxY, maxY));
        updateZoomFlag(true);
      }
    });

  const singleTapGesture = Gesture.Tap().onEnd(() => {
    'worklet';
    // 放大态下单击不做任何事,避免误触关闭整个查看器。
    if (scale.value <= MIN_SCALE + ZOOM_EPSILON) {
      runOnJS(invokeTap)();
    }
  });

  // 双击优先于单击;捏合/平移与点击互不阻塞。
  const composedGesture = Gesture.Simultaneous(pinchGesture, panGesture, Gesture.Exclusive(doubleTapGesture, singleTapGesture));

  const containerStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={composedGesture}>
      <Animated.View
        style={[styles.container, containerStyle]}
        onLayout={(event: LayoutChangeEvent) => {
          width.value = event.nativeEvent.layout.width;
          height.value = event.nativeEvent.layout.height;
        }}
      >
        {status !== 'error' && (
          <Animated.Image
            source={{ uri }}
            style={[styles.image, imageStyle]}
            resizeMode="contain"
            onLoad={() => setStatus('loaded')}
            onError={() => setStatus('error')}
          />
        )}
        {status === 'loading' && <ActivityIndicator color="#fff" style={StyleSheet.absoluteFill} />}
        {status === 'error' && <Text style={styles.errorText}>{i18n.t('imagePreview.loadFailed')}</Text>}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  errorText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
  },
});
