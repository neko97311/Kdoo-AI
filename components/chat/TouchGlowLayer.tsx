import { StyleSheet } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

interface TouchGlowLayerProps {
  /** Touch x in window coordinates (e.g. e.absoluteX from gesture). */
  x: number;
  /** Touch y in window coordinates. */
  y: number;
  /** Whether the user has slid up past the cancel threshold. */
  isSlideCancel: boolean;
  /** Shadow strength 0..1 — 1 when actively recording, fades out on release. */
  intensity?: number;
  /** Outer glow radius in px. */
  radius?: number;
  /** Inner ring stroke radius. */
  ringRadius?: number;
}

/**
 * Visual layer anchored at the user's finger during a hold-to-speak gesture.
 * A radial gradient fades out from the touch point and a stroked ring sits
 * at the same coordinates — the "deeper shadow + ring anchor" effect called
 * for in the redesign spec.
 */
export function TouchGlowLayer({
  x,
  y,
  isSlideCancel,
  intensity = 1,
  radius = 140,
  ringRadius = 18,
}: TouchGlowLayerProps) {
  const innerColor = isSlideCancel ? '#F53F3F' : '#1D4ED8';
  const ringColor = isSlideCancel ? '#FCA5A5' : '#C4B5FD';
  // RN-svg resolves cx/cy in user units, so we anchor the gradient by
  // passing absolute coords + an explicit radius (not percentages).
  const safe = Math.max(0, Math.min(1, intensity));

  return (
    <Svg
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      preserveAspectRatio="xMidYMid meet"
    >
      <Defs>
        <RadialGradient
          id="touchGlow"
          cx={x}
          cy={y}
          r={radius}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0%" stopColor={innerColor} stopOpacity={0.55 * safe} />
          <Stop offset="35%" stopColor={innerColor} stopOpacity={0.28 * safe} />
          <Stop offset="70%" stopColor={innerColor} stopOpacity={0.08 * safe} />
          <Stop offset="100%" stopColor={innerColor} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={x} cy={y} r={radius} fill="url(#touchGlow)" />
      <Circle
        cx={x}
        cy={y}
        r={ringRadius}
        fill="none"
        stroke={ringColor}
        strokeWidth={2}
        opacity={0.9 * safe}
      />
    </Svg>
  );
}
