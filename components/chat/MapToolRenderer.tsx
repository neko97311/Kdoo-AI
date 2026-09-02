/**
 * Map tool renderer — compact preview card + full-screen interactive map.
 *
 * Architecture:
 *
 *   ┌─ Preview card (inline in chat bubble) ──────────────────┐
 *   │  ┌─ Mini-map banner (live WebView, previewMode) ──────┐ │
 *   │  │  Route polyline + markers, no UI chrome             │ │
 *   │  │  Tap → opens full-screen modal                      │ │
 *   │  └─────────────────────────────────────────────────────┘ │
 *   │  [pin] Destination name                          [chev]  │
 *   │        12.3 km · 25 mins                                 │
 *   │  [Drive] [Walk] [Bike] [Transit]                         │
 *   └──────────────────────────────────────────────────────────┘
 *                         │
 *                         │ user taps banner or info area
 *                         ▼
 *   ┌─ <Modal> full-screen map ──────────────────────────────┐
 *   │  - Separate McpWebView instance for interaction         │
 *   │  - User can pan/zoom/switch modes                       │
 *   │  - Closing modal preserves routeInfo in preview         │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Why two WebViews?
 *   - The banner WebView runs in previewMode (UI chrome hidden via CSS),
 *     showing only the route polyline. It stays mounted so mode-chip taps
 *     can trigger route recalculations without opening the full-screen map.
 *   - The modal WebView is the full interactive experience. It unmounts
 *     on close (RN Modal behavior), but the banner holds canonical route.
 *   - Cost: two GPS requests + two Directions API calls. Acceptable.
 *
 * @module components/chat/MapToolRenderer
 */

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { View, Text, Pressable, Modal, StatusBar, StyleSheet, ActivityIndicator, Platform, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useResolvedScheme } from '@/hooks/useColors';
import { useI18n } from '@/hooks/useI18n';
import { useToastStore } from '@/stores/toast';
import { ToastHost } from '@/components/ui/Toast';
import { McpWebView, type McpWebViewHandle, type RouteInfo, type MapMode } from './McpWebView';
import { MapChatInput } from './MapChatInput';
import { KeyboardAvoidingView } from '@/components/KeyboardAvoidingView';
import type { ToolInvocationContent, McpToolCallPayload } from '@/types';

interface MapToolRendererProps {
  content: ToolInvocationContent;
  onMcpToolCall?: (params: McpToolCallPayload) => void;
}

/** Extract destination string from tool args (handles object or JSON string). */
function extractDestination(args: unknown): string {
  if (!args) return 'Destination';
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed.destination === 'string') return parsed.destination;
    } catch {
      return args;
    }
    return 'Destination';
  }
  if (typeof args === 'object' && args !== null) {
    const obj = args as Record<string, unknown>;
    if (typeof obj.destination === 'string') return obj.destination;
  }
  return 'Destination';
}

// Mode chips use MaterialCommunityIcons (not emoji). Icon fonts have
// uniform glyph metrics, so all four chips align and space evenly.
// The full-screen modal WebView uses inline SVG icons with the same
// vivid brand colors (Google Maps style) shown when active.
const MODE_OPTIONS: Array<{ mode: MapMode; icon: string; color: string }> = [
  { mode: 'driving', icon: 'car', color: '#3B82F6' },     // blue
  { mode: 'walking', icon: 'walk', color: '#10B981' },    // green
  { mode: 'bicycling', icon: 'bike', color: '#F59E0B' },  // amber
  { mode: 'transit', icon: 'subway', color: '#8B5CF6' },  // violet
];

export function MapToolRenderer({ content, onMcpToolCall }: MapToolRendererProps) {
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [selectedMode, setSelectedMode] = useState<MapMode>('driving');
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null);
  const scheme = useResolvedScheme();
  const insets = useSafeAreaInsets();
  const isDark = scheme === 'dark';
  const { t } = useI18n();

  // Map mode → i18n label key, recomputed when locale changes.
  const modeLabels: Record<MapMode, string> = {
    driving: t('map.modeDrive'),
    walking: t('map.modeWalk'),
    bicycling: t('map.modeBike'),
    transit: t('map.modeTransit'),
  };

  // Banner WebView: always mounted in previewMode, emits routeInfo,
  // handles mode-chip switches. Visible as the mini-map at card top.
  const hiddenWebViewRef = useRef<McpWebViewHandle>(null);
  // Visible WebView inside Modal: only mounted while overlay is open.
  const visibleWebViewRef = useRef<McpWebViewHandle>(null);

  const resourceUri = content.structuredContent?.resourceUri;

  const safeToolName = typeof content.toolName === 'string'
    ? content.toolName
    : String((content.toolName as any)?.name ?? 'googleMapTool');

  const destinationName = extractDestination(content.args);

  const toolInput = useMemo(
    () => (content.args ? { toolName: safeToolName, input: content.args } : undefined),
    [safeToolName, content.args],
  );
  const toolResult = useMemo(
    () => (content.result !== undefined ? { toolName: safeToolName, result: content.result } : undefined),
    [safeToolName, content.result],
  );

  // Keep selectedMode in sync with routeInfo emitted by the WebViews.
  useEffect(() => {
    if (routeInfo?.mode) setSelectedMode(routeInfo.mode);
  }, [routeInfo?.mode]);

  const handleModeChipPress = (mode: MapMode) => {
    setSelectedMode(mode);
    // Trigger recalculation on the always-running banner WebView.
    hiddenWebViewRef.current?.switchMode(mode);
  };

  // Launch the native map app (Google Maps / AMap) with the current
  // destination for turn-by-turn navigation. Triggered by the jump icon
  // in the bottom panel — NOT by tapping the info row (which opens modal).
  // Priority: native scheme > web fallback URL.
  const openExternalMap = useCallback(async () => {
    const dest = routeInfo?.destination;
    if (!dest || typeof dest.lat !== 'number' || typeof dest.lng !== 'number') {
      useToastStore
        .getState()
        .showToast({ message: t('map.noDestinationMsg'), variant: 'warning' });
      return;
    }
    const { lat, lng } = dest;
    const label = encodeURIComponent(destinationName || 'Destination');
    // Try native scheme first (opens app directly), fall back to web URL.
    const schemes = Platform.select<{
      primary: string;
      fallback: string;
    }>({
      android: {
        primary: `androidamap://navi?sourceApplication=kdoo&lat=${lat}&lon=${lng}&dev=0&style=2`,
        fallback: `https://uri.amap.com/navigation?to=${lng},${lat},${label}&mode=car`,
      },
      ios: {
        primary: `comgooglemaps://?daddr=${lat},${lng}&directionsmode=driving`,
        fallback: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
      },
      default: {
        primary: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
        fallback: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
      },
    }) ?? { primary: '', fallback: '' };

    // IMPORTANT: Do NOT use Linking.canOpenURL() as a gate on Android 11+.
    // canOpenURL() internally calls Intent.resolveActivity(), which returns
    // null for custom schemes (androidamap://, googlemaps://) unless the
    // scheme is declared in <queries> in AndroidManifest.xml. This causes
    // canOpenURL to ALWAYS return false, skipping the native app entirely.
    //
    // Instead, try Linking.openURL(scheme) directly and catch the error.
    // openURL() uses startActivity() which launches the app if an intent
    // filter matches, regardless of <queries> declarations.
    console.log('[MapToolRenderer NAV] openExternalMap start:', JSON.stringify({ lat, lng, primary: schemes.primary }));
    if (schemes.primary) {
      try {
        await Linking.openURL(schemes.primary);
        console.log('[MapToolRenderer NAV] Primary scheme opened successfully:', schemes.primary);
        return;
      } catch (err) {
        console.warn('[MapToolRenderer NAV] Primary scheme failed:', schemes.primary, JSON.stringify(err));
        // Fall through to https fallback below
      }
    }
    try {
      console.log('[MapToolRenderer NAV] Falling back to https:', schemes.fallback);
      await Linking.openURL(schemes.fallback);
    } catch (err) {
      console.warn('[MapToolRenderer NAV] Fallback also failed:', JSON.stringify(err));
      useToastStore
        .getState()
        .showToast({ message: t('map.navUnavailableMsg'), variant: 'warning' });
    }
  }, [routeInfo?.destination, destinationName, t]);

  // Banner height: larger on web (where screen real estate is plentiful),
  // compact on mobile to preserve chat vertical space.
  const bannerHeight = Platform.select({ web: 300, default: 200 });

  // Theme tokens
  const cardBg = isDark ? '#1a1a2e' : '#f8f9fa';
  const cardBorder = isDark ? '#2a2a3e' : '#e5e7eb';
  const titleColor = isDark ? '#e5e7eb' : '#1e293b';
  const subColor = isDark ? '#9CA3AF' : '#6B7280';
  const accent = '#4f46e5';
  const thumbBg = isDark ? '#1e3a5f' : '#dbeafe';
  const chipBg = isDark ? '#1e1e30' : '#ffffff';
  const chipBgActive = isDark ? '#312e81' : '#eef2ff';
  const chipBorder = isDark ? '#2a2a3e' : '#e5e7eb';
  const chipBorderActive = accent;
  const chipTextColor = isDark ? '#cbd5e1' : '#475569';
  const chipTextColorActive = accent;

  // Streaming / no resourceUri yet — placeholder card, no WebView yet.
  if (!resourceUri) {
    return (
      <View style={[styles.previewCard, { backgroundColor: cardBg, borderColor: cardBorder }]}>
        <View style={[styles.previewBannerWrap, { backgroundColor: thumbBg }]}>
          <ActivityIndicator size="small" color={accent} />
        </View>
        <View style={styles.previewInfoArea}>
          <Text style={[styles.previewTitle, { color: titleColor }]} numberOfLines={1}>
            {destinationName}
          </Text>
          <Text style={[styles.previewSub, { color: subColor }]}>
            {t('map.preparing')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* ── Preview card (inline in chat bubble) ──
          Layout:
            1. Mini-map banner (200px, live WebView in previewMode)
               - Route polyline + markers underneath
               - Top-right expand button (opens modal)
            2. Bottom info panel (opaque, themed):
               Row 1: [Drive][Walk][Bike][Transit] mode chips
               Row 2: destination name          ┐
               Row 3: 🧭 distance · duration    ↗ jump icon (spans rows 2-3) */}
      <View style={[styles.previewCard, { backgroundColor: cardBg, borderColor: cardBorder }]}>
        {/* ── Mini-map banner ──
             previewMode strips all UI chrome (header, mode buttons, info bar,
             navigate button), leaving only the map canvas with the route
             polyline. pointerEvents="none" lets taps fall through.
             Whole banner is tappable to open the modal (in addition to the
             explicit expand button at top-right). */}
        <Pressable
          onPress={() => setOverlayOpen(true)}
          style={({ pressed }) => [
            styles.previewBannerWrap,
            { height: bannerHeight },
            pressed && { opacity: 0.85 },
          ]}
        >
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <McpWebView
              ref={hiddenWebViewRef}
              resourceUri={resourceUri}
              toolCallId={content.toolCallId}
              toolInput={toolInput}
              toolResult={toolResult}
              onRouteInfo={setRouteInfo}
              previewMode
              fillContainer
            />
          </View>
          {/* Top-right expand button — opens the full-screen modal.
              Rendered ABOVE the wrapping Pressable via zIndex so its tap
              takes precedence over the banner's own onPress. */}
          <Pressable
            onPress={() => setOverlayOpen(true)}
            style={styles.bannerExpandBtn}
            hitSlop={8}
          >
            <View style={styles.expandHint}>
              <Ionicons name="expand-outline" size={14} color="#ffffff" />
            </View>
          </Pressable>
        </Pressable>

        {/* ── Bottom info panel (opaque) ──
            Doubao-style card layout below the map banner. Unlike the
            previous semi-transparent overlay, this uses a solid themed
            background for guaranteed text legibility. */}
        <View style={[styles.bottomPanel, { backgroundColor: cardBg }]}>
          {/* Row 1: mode chips */}
          <View style={styles.chipRow}>
            {MODE_OPTIONS.map((opt) => {
              const active = selectedMode === opt.mode;
              return (
                <Pressable
                  key={opt.mode}
                  onPress={() => handleModeChipPress(opt.mode)}
                  hitSlop={4}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? chipBgActive : chipBg,
                      borderColor: active ? chipBorderActive : chipBorder,
                    },
                  ]}
                >
                  <MaterialCommunityIcons
                    name={opt.icon as any}
                    size={13}
                    color={opt.color}
                  />
                  <Text
                    style={[
                      styles.chipText,
                      { color: active ? chipTextColorActive : chipTextColor },
                    ]}
                    numberOfLines={1}
                  >
                    {modeLabels[opt.mode]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Row 2-3: destination + route info on the left (tap → modal),
              jump icon on the right (tap → launch external map app).
              Splitting into two independent Pressables avoids event
              bubbling so each tap triggers exactly one action. */}
          <View style={styles.infoRow}>
            {/* Left side: destination + distance/duration.
                Tapping opens the full-screen modal. */}
            <Pressable
              onPress={() => setOverlayOpen(true)}
              style={({ pressed }) => [
                styles.infoLeft,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Text
                style={[styles.infoDestination, { color: titleColor }]}
                numberOfLines={1}
              >
                {destinationName}
              </Text>
              {routeInfo ? (
                <View style={styles.infoMetaRow}>
                  <MaterialCommunityIcons
                    name="navigation-variant-outline"
                    size={13}
                    color={accent}
                  />
                  <Text style={[styles.infoDistance, { color: accent }]}>
                    {routeInfo.distance || '—'}
                  </Text>
                  <Text style={[styles.infoDot, { color: subColor }]}>·</Text>
                  <Text style={[styles.infoDuration, { color: subColor }]}>
                    {routeInfo.duration || '—'}
                  </Text>
                </View>
              ) : (
                <Text style={[styles.infoLoading, { color: subColor }]}>
                  {t('map.loadingRoute')}
                </Text>
              )}
            </Pressable>
            {/* Jump icon — vertically centered across rows 2-3.
                Tapping launches the native map app (Google Maps / AMap)
                for turn-by-turn navigation. Distinct from the info area
                tap which opens the in-app modal. */}
            <Pressable
              onPress={openExternalMap}
              hitSlop={8}
              style={({ pressed }) => [
                styles.jumpIcon,
                pressed && { opacity: 0.5 },
              ]}
            >
              <MaterialCommunityIcons
                name="arrow-top-right"
                size={24}
                color={accent}
              />
            </Pressable>
          </View>
        </View>
      </View>

      {/* ── Full-screen Modal (mounted only while open) ── */}
      <Modal
        visible={overlayOpen}
        animationType="slide"
        presentationStyle="overFullScreen"
        transparent={false}
        statusBarTranslucent
        onRequestClose={() => setOverlayOpen(false)}
      >
        <KeyboardAvoidingView style={styles.modalRoot} keyboardVerticalOffset={insets.top}>
          <StatusBar barStyle="light-content" />
          {/* Local ToastHost — the app-root ToastHost cannot render above this
           *  native <Modal>, so we mount one inside the modal subtree to surface
           *  navigation errors (openExternalMap fallback failures) triggered
           *  while the full-screen map is open. */}
          <ToastHost />
          {/* Map fills the entire screen from the very top */}
          <McpWebView
            ref={visibleWebViewRef}
            resourceUri={resourceUri}
            toolCallId={content.toolCallId}
            toolInput={toolInput}
            toolResult={toolResult}
            onToolCall={onMcpToolCall}
            onRouteInfo={setRouteInfo}
            fillContainer
            topInset={insets.top}
          />
          {/* Keep chatting with the AI while viewing the map (ChatGPT-style). */}
          <MapChatInput onSent={() => setOverlayOpen(false)} />
          {/* Floating circular back button — absolute top-left over the map */}
          <Pressable
            onPress={() => setOverlayOpen(false)}
              style={[
                styles.closeBtnFloat,
                { top: insets.top },
              ]}
            hitSlop={8}
          >
            <View style={styles.closeBtnRing}>
              <View style={styles.closeBtnCore}>
                <Ionicons name="chevron-back" size={26} color="#0f172a" />
              </View>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    // Wrapper for preview card. The Modal is rendered via React Portal at
    // the root, so it covers the full screen regardless of this view's size.
  },
  // ── Preview card ──
  previewCard: {
    marginTop: 6,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    minWidth: 280,
  },
  // Mini-map banner: the live WebView renders here. Height is set via the
  // `bannerHeight` inline style (platform-dependent: 300px on web, 200px
  // on mobile) so the style here only carries the layout primitives.
  previewBannerWrap: {
    width: '100%',
    overflow: 'hidden',
  },
  // Top-right expand button — absolute positioned to stay in the banner's
  // top-right corner regardless of map content underneath.
  bannerExpandBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 2,
  },
  // Small semi-transparent pill holding the expand icon. The dark backdrop
  // keeps the white icon legible over bright map tiles.
  expandHint: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // ── Bottom info panel (opaque, below the map banner) ──
  // Solid themed background (not transparent) for guaranteed readability.
  bottomPanel: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
  },
  // Row 1: mode chips
  // nowrap + flex:1 on each chip ensures 4 chips always fit on one row,
  // even on narrow phones (320px). Without flex:1, chips use intrinsic
  // width and wrap to a second row on small screens.
  chipRow: {
    flexDirection: 'row',
    gap: 5,
    flexWrap: 'nowrap',
    marginBottom: 10,
  },
  chip: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    gap: 3,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '600',
    includeFontPadding: false,
    textAlignVertical: 'center',
    flexShrink: 1,
  },
  // Row 2-3: info + jump icon. Flex row so the jump icon container can
  // stretch vertically and center its icon across both text rows.
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  infoLeft: {
    flex: 1,
    gap: 3,
  },
  infoDestination: {
    fontSize: 14,
    fontWeight: '600',
  },
  infoMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  infoDistance: {
    fontSize: 12,
    fontWeight: '700',
  },
  infoDot: {
    fontSize: 12,
  },
  infoDuration: {
    fontSize: 12,
    fontWeight: '500',
  },
  infoLoading: {
    fontSize: 12,
  },
  // Jump icon — vertically centered in a fixed-width column that spans
  // the full height of the info row (rows 2-3). Doubao-style arrow.
  jumpIcon: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Modal ──
  // Map fills the entire screen; no native header bar. The back button
  // floats over the map as an absolute-positioned circular control.
  modalRoot: {
    flex: 1,
  },
  // Outermost absolute container — positioned via inline `top` (safe-area
  // inset). Two-layer design: a semi-transparent light-gray ring outside
  // a darker semi-transparent gray core, ensuring the white chevron icon
  // stays legible over any map tile (bright or dark).
  closeBtnFloat: {
    position: 'absolute',
    left: 8,
    zIndex: 10,
    elevation: 5,
  },
  // Outer ring: transparent so it never obscures the map behind it
  closeBtnRing: {
    padding: 0,
    borderRadius: 26,
    backgroundColor: 'transparent',
  },
  // Inner core: transparent — the arrow reads as part of the background.
  closeBtnCore: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
});
