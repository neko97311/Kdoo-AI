/**
 * My Location tool renderer — compact preview card + full-screen map.
 *
 * Architecture:
 *
 *   ┌─ Preview card (inline in chat bubble) ──────────────────┐
 *   │  ┌─ Mini-map banner (live WebView, previewMode) ──────┐ │
 *   │  │  Map tiles only; header/info-card hidden via CSS.    │ │
 *   │  │  Tap → opens full-screen modal                      │ │
 *   │  └─────────────────────────────────────────────────────┘ │
 *   │  [crosshairs] Resolving address...              [jump]   │
 *   │                lat, lng                                  │
 *   └──────────────────────────────────────────────────────────┘
 *                         │
 *                         │ user taps banner or info area
 *                         ▼
 *   ┌─ <Modal> full-screen map ──────────────────────────────┐
 *   │  - Full McpWebView instance with all UI chrome visible  │
 *   │  - Address, coordinates, accuracy, Open-in-Maps button  │
 *   │  - Reverse geocoding runs inside the HTML               │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Why not reuse MapToolRenderer?
 *   - MapToolRenderer is route-planning specific: mode chips, route info
 *     protocol, distance/duration row, AMap/Google navigation deep links
 *     for turn-by-turn directions to a destination.
 *   - MyLocation has no destination, no route, no mode selection. Its
 *     preview shows address + coords + a single "open in maps" action.
 *   - Forcing it into MapToolRenderer would require null-checks scattered
 *     across every mode chip / routeInfo code path. Cleaner to have a
 *     dedicated slim renderer.
 *
 * @module components/chat/MyLocationToolRenderer
 */

import React, { useMemo, useRef, useState, useCallback } from 'react';
import { View, Text, Pressable, Modal, StatusBar, StyleSheet, ActivityIndicator, Platform, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useResolvedScheme } from '@/hooks/useColors';
import { useI18n } from '@/hooks/useI18n';
import { useToastStore } from '@/stores/toast';
import { ToastHost } from '@/components/ui/Toast';
import { McpWebView } from './McpWebView';
import { MapChatInput } from './MapChatInput';
import { KeyboardAvoidingView } from '@/components/KeyboardAvoidingView';
import type { LocationResultInfo } from './McpWebView';
import type { ToolInvocationContent, McpToolCallPayload } from '@/types';

interface MyLocationToolRendererProps {
  content: ToolInvocationContent;
  onMcpToolCall?: (params: McpToolCallPayload) => void;
}

/**
 * Extract the optional `label` argument passed by the tool. The args shape
 * is `{ label?: string, zoom?: number }`. Falls back to the localized
 * "My Location" string when no label is provided.
 */
function extractLabel(args: unknown, fallback: string): string {
  if (!args) return fallback;
  const obj = typeof args === 'string' ? safeParse(args) : args;
  if (obj && typeof obj === 'object' && 'label' in obj) {
    const label = (obj as Record<string, unknown>).label;
    if (typeof label === 'string' && label.trim()) return label;
  }
  return fallback;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

export function MyLocationToolRenderer({ content, onMcpToolCall }: MyLocationToolRendererProps) {
  const [overlayOpen, setOverlayOpen] = useState(false);
  // Address pushed up from the WebView after reverse geocoding resolves.
  // null = still resolving ("Locating..."); string = resolved address;
  // undefined-after-non-null = geocoding failed ("Address unavailable").
  const [address, setAddress] = useState<string | null>(null);
  const [addressFailed, setAddressFailed] = useState(false);
  // Raw WGS84 coordinates pushed up from the WebView alongside the address.
  // null until the first locationResult event arrives. Shown in the preview
  // card so the user can verify the pin even before reverse geocoding
  // resolves (or when it fails entirely).
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const scheme = useResolvedScheme();
  const insets = useSafeAreaInsets();
  const isDark = scheme === 'dark';
  const { t } = useI18n();

  // The preview WebView mounts once and stays resident. The full-screen
  // modal mounts a second WebView only while open (RN Modal unmounts on
  // close). This mirrors MapToolRenderer's pattern.
  const resourceUri = content.structuredContent?.resourceUri;

  const safeToolName = typeof content.toolName === 'string'
    ? content.toolName
    : String((content.toolName as { name?: string })?.name ?? 'myLocationTool');

  const label = extractLabel(content.args, t('map.myLocation'));

  const toolInput = useMemo(
    () => (content.args ? { toolName: safeToolName, input: content.args } : undefined),
    [safeToolName, content.args],
  );
  const toolResult = useMemo(
    () => (content.result !== undefined ? { toolName: safeToolName, result: content.result } : undefined),
    [safeToolName, content.result],
  );

  // Launch the native map app (Google Maps / AMap) centered on the user's
  // current location. The HTML-side acquires GPS; the RN host receives the
  // `locationAcquired` message via McpWebView, but this preview does not
  // plumb that through — the full-screen modal WebView handles its own
  // acquisition. Here we simply rely on the user opening the modal once
  // to populate `currentLocation`, then using this button afterwards.
  // For the preview card, we just open the default maps app at the
  // device's current location via a `geo:0,0?q=my+location` style URL.
  const openExternalMap = useCallback(async () => {
    const schemes = Platform.select<{ primary: string; fallback: string }>({
      android: {
        primary: 'geo:0,0?q=my+location',
        fallback: 'https://maps.google.com/maps?q=my+location',
      },
      ios: {
        primary: 'maps://?q=my+location',
        fallback: 'https://maps.apple.com/?q=my+location',
      },
      default: {
        primary: 'https://maps.google.com/maps?q=my+location',
        fallback: 'https://maps.google.com/maps?q=my+location',
      },
    }) ?? { primary: '', fallback: '' };

    if (schemes.primary) {
      try {
        await Linking.openURL(schemes.primary);
        return;
      } catch (err) {
        console.warn('[MyLocationToolRenderer NAV] Primary scheme failed:', schemes.primary, err);
      }
    }
    try {
      await Linking.openURL(schemes.fallback);
    } catch (err) {
      console.warn('[MyLocationToolRenderer NAV] Fallback also failed:', err);
      useToastStore
        .getState()
        .showToast({ message: t('map.navUnavailableMsg'), variant: 'warning' });
    }
  }, [t]);

  // Pushed up from the WebView via McpWebView's locationResult forwarding
  // whenever reverse geocoding completes (success or failure). Updates the
  // preview sub-label to the real address or a failure hint.
  const handleLocationResult = useCallback((info: LocationResultInfo) => {
    // Capture coordinates regardless of geocoding outcome so the preview
    // can always show lat/lng (geocoding may fail or hang in China, but
    // coords are the ground truth).
    if (typeof info.lat === 'number' && typeof info.lng === 'number') {
      setCoords({ lat: info.lat, lng: info.lng });
    }
    if (info.address) {
      setAddress(info.address);
      setAddressFailed(false);
    } else {
      setAddress(null);
      setAddressFailed(true);
    }
  }, []);

  const bannerHeight = Platform.select({ web: 260, default: 200 });

  // Theme tokens
  const cardBg = isDark ? '#1a1a2e' : '#f8f9fa';
  const cardBorder = isDark ? '#2a2a3e' : '#e5e7eb';
  const titleColor = isDark ? '#e5e7eb' : '#1e293b';
  const subColor = isDark ? '#9CA3AF' : '#6B7280';
  const accent = '#4f46e5';
  const thumbBg = isDark ? '#1e3a5f' : '#dbeafe';

  // Streaming / no resourceUri yet — show a placeholder card.
  if (!resourceUri) {
    return (
      <View style={[styles.previewCard, { backgroundColor: cardBg, borderColor: cardBorder }]}>
        <View style={[styles.previewBannerWrap, { height: bannerHeight, backgroundColor: thumbBg }]}>
          <ActivityIndicator size="small" color={accent} />
        </View>
        <View style={styles.previewInfoArea}>
          <Text style={[styles.previewTitle, { color: titleColor }]} numberOfLines={1}>
            {label}
          </Text>
          <Text style={[styles.previewSub, { color: subColor }]}>
            {t('map.locating')}
          </Text>
        </View>
      </View>
    );
  }

  // Sub-label priority: resolved address > "Address unavailable" >
  // "Locating...". Coordinates render on a separate tertiary line so the
  // user always sees the pin's ground-truth lat/lng regardless of
  // reverse-geocoder state (which can hang indefinitely in China).
  const subLabel = address
    ? address
    : addressFailed
      ? t('map.addressUnavailable')
      : t('map.locating');
  // Format coords to 6 decimal places (~0.1m precision at the equator).
  // Trailing zeros are kept so the column width stays stable while the
  // GPS reading stabilises.
  const coordsText = coords
    ? `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`
    : '';

  return (
    <View style={styles.root}>
      {/* ── Preview card (inline in chat bubble) ──
          Layout:
            1. Mini-map banner (live WebView in previewMode). UI chrome
               (.loc-header, .info-card, .action-btn) hidden via injected CSS.
               Whole banner is tappable to open the modal.
            2. Bottom info panel (opaque, themed):
               Row 1: destination label (e.g. "My Location")
               Row 2: "Locating..." placeholder (RN-side; the address comes
                      from inside the WebView, not exposed to RN preview)
               Jump icon → opens native maps app at device location. */}
      <View style={[styles.previewCard, { backgroundColor: cardBg, borderColor: cardBorder }]}>
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
              resourceUri={resourceUri}
              toolCallId={content.toolCallId}
              toolInput={toolInput}
              toolResult={toolResult}
              previewMode
              fillContainer
              onLocationResult={handleLocationResult}
            />
          </View>
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

        <View style={[styles.bottomPanel, { backgroundColor: cardBg }]}>
          <View style={styles.infoRow}>
            <Pressable
              onPress={() => setOverlayOpen(true)}
              style={({ pressed }) => [styles.infoLeft, pressed && { opacity: 0.6 }]}
            >
              <View style={styles.titleRow}>
                <MaterialCommunityIcons name="crosshairs-gps" size={14} color={accent} />
                <Text style={[styles.infoDestination, { color: titleColor }]} numberOfLines={1}>
                  {label}
                </Text>
              </View>
              <Text style={[styles.infoSub, { color: subColor }]} numberOfLines={1}>
                {subLabel}
              </Text>
              {coordsText ? (
                <Text style={[styles.infoCoords, { color: subColor }]} numberOfLines={1}>
                  {coordsText}
                </Text>
              ) : null}
            </Pressable>
            <Pressable
              onPress={openExternalMap}
              hitSlop={8}
              style={({ pressed }) => [styles.jumpIcon, pressed && { opacity: 0.5 }]}
            >
              <MaterialCommunityIcons
                name="open-in-new"
                size={22}
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
           *  navigation errors (fallback Linking.openURL failures) triggered
           *  while the full-screen map is open. */}
          <ToastHost />
          <McpWebView
            resourceUri={resourceUri}
            toolCallId={content.toolCallId}
            toolInput={toolInput}
            toolResult={toolResult}
            onToolCall={onMcpToolCall}
            fillContainer
            topInset={insets.top}
          />
          {/* Keep chatting with the AI while viewing the map (ChatGPT-style). */}
          <MapChatInput onSent={() => setOverlayOpen(false)} />
          <Pressable
            onPress={() => setOverlayOpen(false)}
            style={[styles.closeBtnFloat, { top: insets.top }]}
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
  root: {},
  previewCard: {
    marginTop: 6,
    marginRight: 4,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  previewBannerWrap: {
    width: '100%',
    overflow: 'hidden',
  },
  bannerExpandBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 2,
  },
  expandHint: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomPanel: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  infoLeft: {
    flex: 1,
    gap: 3,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  infoDestination: {
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
  },
  infoSub: {
    fontSize: 12,
  },
  infoCoords: {
    fontSize: 11,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    opacity: 0.7,
    marginTop: 1,
  },
  jumpIcon: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewInfoArea: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  previewTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  previewSub: {
    fontSize: 12,
    marginTop: 2,
  },
  // ── Modal ──
  modalRoot: {
    flex: 1,
  },
  closeBtnFloat: {
    position: 'absolute',
    left: 8,
    zIndex: 10,
    elevation: 5,
  },
  closeBtnRing: {
    padding: 0,
    borderRadius: 26,
    backgroundColor: 'transparent',
  },
  closeBtnCore: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
});
