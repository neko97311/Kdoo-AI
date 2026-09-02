// 自制 Slider：项目无 react-native-community/slider 依赖。
// 仅供声音设置页（速度/音调 0.5-2.0）使用。
//
// ⚠️ PanResponder 坐标说明：
// g.moveX 是手指在屏幕上的绝对 X 坐标，不是相对 Slider 的坐标。
// 必须用 ref 记录 Slider 容器在屏幕中的 pageX（通过 onLayout + measure），
// 然后 next = moveX - pageX。
// 不能用 g.dx（相对位移），因为 dx 在 onStart 时归零但 value 可能不是 min。
import { useCallback, useRef } from 'react';
import { View, Pressable, PanResponder, LayoutChangeEvent } from 'react-native';

export interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  /** 长条颜色，默认 aura-primary */
  trackColor?: string;
  /** 未填充部分颜色 */
  trackBgColor?: string;
}

export function Slider({
  value,
  min = 0.5,
  max = 2.0,
  step = 0.1,
  onChange,
  trackColor = '#685891',
  trackBgColor = '#c7c4d7',
}: SliderProps) {
  const widthRef = useRef(1);
  const pageXRef = useRef(0);
  const containerRef = useRef<View>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    widthRef.current = Math.max(1, e.nativeEvent.layout.width);
    // measure 获取容器在屏幕中的绝对 X（RN 上 onLayout 的 x 是相对父容器，不是屏幕坐标）
    containerRef.current?.measure((_x, _y, w, _h, px) => {
      widthRef.current = Math.max(1, w);
      pageXRef.current = px;
    });
  }, []);

  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const fillWidth = ratio * widthRef.current;
  const thumbLeft = fillWidth - 12;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        // 重新 measure 以防布局变化（如键盘弹出）
        containerRef.current?.measure((_x, _y, w, _h, px) => {
          widthRef.current = Math.max(1, w);
          pageXRef.current = px;
        });
      },
      onPanResponderMove: (_, g) => {
        const w = widthRef.current;
        // moveX 是绝对屏幕坐标，减去容器 pageX 得到相对位置
        const next = Math.min(w, Math.max(0, g.moveX - pageXRef.current));
        const r = Math.min(1, Math.max(0, next / w));
        let raw = min + r * (max - min);
        // snap to step
        raw = Math.round(raw / step) * step;
        raw = Math.min(max, Math.max(min, raw));
        // 浮点尾数: 1 位
        const clamped = Math.round(raw * 10) / 10;
        if (clamped !== value) onChange(clamped);
      },
    }),
  ).current;

  return (
    <View
      ref={containerRef}
      className="h-12 justify-center"
      onLayout={onLayout}
      {...responder.panHandlers}
    >
      <Pressable>
        <View
          className="h-1.5 rounded-full"
          style={{ backgroundColor: trackBgColor }}
        >
          <View
            className="h-1.5 rounded-full"
            style={{ width: fillWidth, backgroundColor: trackColor }}
          />
        </View>
        <View
          className="absolute w-6 h-6 rounded-full border-2"
          style={{
            left: Math.max(0, thumbLeft),
            top: 9,
            backgroundColor: '#fff',
            borderColor: trackColor,
          }}
        />
      </Pressable>
    </View>
  );
}
