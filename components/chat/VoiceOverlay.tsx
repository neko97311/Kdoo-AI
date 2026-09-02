import { useEffect, useMemo } from 'react';
import { View, Text, Modal, Animated, Dimensions, Platform, StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';
import { LinearGradient as ExpoLinearGradient } from 'expo-linear-gradient';
import { useI18n } from '@/hooks/useI18n';
import { TouchGlowLayer } from './TouchGlowLayer';
import { RealTimeWaveform } from './RealTimeWaveform';

interface VoiceOverlayProps {
  visible: boolean;
  onClose: () => void;
  isSlideCancel?: boolean;
  /** Touch x in window coordinates. */
  touchX?: number;
  /** Touch y in window coordinates. */
  touchY?: number;
  /** Real-time mic volume normalised to 0..1. Mobile-only. */
  amplitude?: number;
  /**
   * Visual variant. Defaults to 'chat' (slide-up-to-cancel hint + touch glow).
   * 'clone' omits the TouchGlowLayer since the clone sheet does not track
   * the finger position. All other defaults (hint copy, arc, waveform) are
   * identical to 'chat' so the recording UX is indistinguishable.
   * 'clone-flat' renders NOTHING — used by VoiceCloneSheet which paints its own
   * central recording UI inside the sheet; the arc would double-render.
   */
  mode?: 'chat' | 'clone' | 'clone-flat';
}

/** Arc height as a fraction of screen height. The arc sits at the bottom
 *  and occupies the bottom 25% of the screen — matches the 豆包 reference. */
const ARC_RATIO = 0.25;
/** How high the top edge of the arc rises at its centreline above the
 *  container's top. Controls the curvature — bigger = more arched. */
const ARC_CURVE_DEPTH = 56;
/** Padding around the arc so the glow halo can extend beyond the
 *  silhouette without being clipped. The SVG canvas itself is sized to
 *  arc + 2*HALO_PAD on each axis; arcContainer overflow:visible lets
 *  the halo bleed into the screen above/left/right of the arc. */
const HALO_PAD = 36;
/** Maximum halo extension at amplitude=1, in CSS pixels. The halo path
 *  is grown by `amplitude * HALO_MAX` in every direction. */
const HALO_MAX = 28;

function buildArcPath(width: number, height: number, expansion = 0): string {
  // Inverted-bowl shape: starts top-left at (0, ARC_CURVE_DEPTH),
  // sweeps up to the centre peak at (width/2, 0), down to top-right at
  // (width, ARC_CURVE_DEPTH), then straight down the right, across the
  // bottom, and up the left to close.
  //
  // When `expansion` > 0 the silhouette is grown uniformly so it sits
  // outside the main fill — used for the breathing halo that radiates
  // from the arc edge in response to the user's voice volume.
  const w = width + expansion * 2;
  const h = height + expansion;
  const x = -expansion;
  const y = -expansion;
  const d = ARC_CURVE_DEPTH + expansion;
  return [
    `M ${x} ${y + d}`,
    `Q ${x + w / 2} ${y} ${x + w} ${y + d}`,
    `L ${x + w} ${y + h}`,
    `L ${x} ${y + h}`,
    'Z',
  ].join(' ');
}

/** Recording overlay for the hold-to-speak gesture. Renders a true
 *  inverted-bowl arc (top edge is a curved path, not a rounded rectangle)
 *  occupying the bottom 25% of the screen. The arc fills with a vertical
 *  wash + radial highlight; colour flips to pink when the touch point
 *  leaves the arc region. */
export function VoiceOverlay({
  visible,
  onClose,
  isSlideCancel,
  touchX = 0,
  touchY = 0,
  amplitude = 0,
  mode = 'chat',
}: VoiceOverlayProps) {
  const { t } = useI18n();
  const fadeAnim = useMemo(() => new Animated.Value(0), []);

  const showModal = visible;

  // Match the ChatInputBar gesture: `e.absoluteY` is in screen coords
  // (status-bar included) on both iOS and Android, so the arc must use
  // `screen` not `window` for its top edge to align with the cancel
  // threshold there.
  const screenH = Dimensions.get('screen').height;
  const screenW = Dimensions.get('window').width;
  const arcHeight = screenH * ARC_RATIO;
  const arcFillPath = useMemo(
    () => buildArcPath(screenW, arcHeight),
    [screenW, arcHeight],
  );
  const haloExpansion = amplitude * HALO_MAX;
  const arcHaloPath = useMemo(
    () => (haloExpansion > 0.5 ? buildArcPath(screenW, arcHeight, haloExpansion) : ''),
    [screenW, arcHeight, haloExpansion],
  );

  useEffect(() => {
    if (showModal) {
      // Show instantly — no fade-in. The 100ms holdTimer already
      // provides the gating delay; an additional animation on top
      // felt laggy/disconnected from the gesture.
      fadeAnim.setValue(1);
    } else {
      fadeAnim.setValue(0);
    }
  }, [showModal, fadeAnim]);

  const isMobile = Platform.OS !== 'web';
  // Recording palette: indigo→light-indigo within the same hue family.
  // Matches the 豆包 reference — deep indigo body fading upward to a
  // soft indigo wash, not a stark blue→violet jump.
  const baseTop = isSlideCancel ? '#FECACA' : '#818CF8';
  const baseBottom = isSlideCancel ? '#FCA5A5' : '#4F46E5';
  // Highlight: bright enough to pop against the body, soft enough not to
  // compete with the white text/waveform.
  const highlightColor = isSlideCancel ? '#FEE2E2' : '#C7D2FE';
  // Halo: a near-white tint of the state's hue so it reads as light
  // spilling past the arc edge instead of disappearing into the body.
  const haloColor = isSlideCancel ? '#FFFFFF' : '#E0E7FF';
  // Backdrop rectangle: a desaturated tint of the arc colour, fading to
  // fully transparent at the top.
  const backdropColor = isSlideCancel ? '#FCA5A5' : '#A5B4FC';
  // Halo opacity grows aggressively with amplitude so even a quiet voice
  // produces a visible breath (alpha 0.25 at amp=0.25, 1.0 at amp=0.9+).
  const haloAlpha = Math.min(1, amplitude * 1.6);
  // Hint text + waveform: white in recording state, red in cancel state
  // so the warning reads through against the pale red arc fill.
  const hintColor = isSlideCancel ? '#DC2626' : '#FFFFFF';

  // Translucent backdrop rectangle: extends ~1.5× the arc height above
  // the arc top, fading from a soft tint at the bottom to fully
  // transparent at the top. Gives the overlay a "stage" feel without
  // blocking chat content above. Implemented as a separate absolutely-
  // positioned View (not inside the SVG) so it can extend beyond the
  // SVG's clipping bounds.
  const backdropHeight = arcHeight * 1.4;

  return (
    <>
    {mode === 'clone-flat' ? null : (
    <Modal visible={showModal} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.root, { opacity: fadeAnim }]} pointerEvents="none">
        <View
          style={[
            styles.arcContainer,
            {
              width: screenW + HALO_PAD * 2,
              height: arcHeight + HALO_PAD * 2,
              top: screenH - arcHeight - HALO_PAD,
              left: -HALO_PAD,
            },
          ]}
        >
          <ExpoLinearGradient
            pointerEvents="none"
            colors={[
              `${backdropColor}00`,
              `${backdropColor}2E`,
              `${backdropColor}55`,
            ]}
            locations={[0, 0.55, 1]}
            style={[
              styles.backdrop,
              {
                width: screenW + HALO_PAD * 2,
                height: backdropHeight,
                bottom: 0,
                left: -HALO_PAD,
              },
            ]}
          />
          <Svg
            width={screenW + HALO_PAD * 2}
            height={arcHeight + HALO_PAD * 2}
            pointerEvents="none"
            viewBox={`${-HALO_PAD} ${-HALO_PAD} ${screenW + HALO_PAD * 2} ${arcHeight + HALO_PAD * 2}`}
          >
            <Defs>
              <LinearGradient id="voiceArcBase" x1="0" y1="1" x2="0" y2="0">
                <Stop offset="0%" stopColor={baseBottom} stopOpacity={1} />
                <Stop offset="55%" stopColor={baseTop} stopOpacity={0.85} />
                <Stop offset="100%" stopColor={baseTop} stopOpacity={0.55} />
              </LinearGradient>
              <RadialGradient
                id="voiceArcHighlight"
                cx={screenW / 2}
                cy={arcHeight * 0.15}
                r={screenW * 0.6}
                gradientUnits="userSpaceOnUse"
              >
                <Stop offset="0%" stopColor={highlightColor} stopOpacity={0.65} />
                <Stop offset="55%" stopColor={highlightColor} stopOpacity={0.18} />
                <Stop offset="100%" stopColor={highlightColor} stopOpacity={0} />
              </RadialGradient>
              <RadialGradient
                id="voiceArcHalo"
                cx={screenW / 2}
                cy={HALO_PAD - 10}
                r={screenW * 1.1}
                gradientUnits="userSpaceOnUse"
              >
                <Stop offset="0%" stopColor={haloColor} stopOpacity={0.9} />
                <Stop offset="35%" stopColor={haloColor} stopOpacity={0.55} />
                <Stop offset="70%" stopColor={haloColor} stopOpacity={0.2} />
                <Stop offset="100%" stopColor={haloColor} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Path d={arcFillPath} fill="url(#voiceArcBase)" />
            <Path d={arcFillPath} fill="url(#voiceArcHighlight)" />
            {arcHaloPath ? (
              <Path d={arcHaloPath} fill="url(#voiceArcHalo)" opacity={haloAlpha} />
            ) : null}
          </Svg>

          <View style={styles.waveformWrap} pointerEvents="none">
            <Text style={[styles.hint, { color: hintColor }]} pointerEvents="none">
              {isSlideCancel
                ? t('voiceOverlay.releaseToCancel')
                : t('voiceOverlay.slideUpToCancel')}
            </Text>
            {isMobile && (
              <View style={{ width: '85%' }} pointerEvents="none">
                <RealTimeWaveform
                  amplitude={amplitude}
                  isSlideCancel={!!isSlideCancel}
                />
              </View>
            )}
          </View>
        </View>

        {mode !== 'clone' && !isSlideCancel && (
          <TouchGlowLayer
            x={touchX}
            y={touchY}
            isSlideCancel={false}
            intensity={1}
          />
        )}
      </Animated.View>
    </Modal>
    )}
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  arcContainer: {
    position: 'absolute',
    overflow: 'visible',
  },
  backdrop: {
    position: 'absolute',
  },
  waveformWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: ARC_CURVE_DEPTH + 8,
    bottom: 36,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  hint: {
    fontSize: 13,
    fontWeight: '600',
  },
});
