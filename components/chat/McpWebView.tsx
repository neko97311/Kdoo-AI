/**
 * MCP interactive WebView component.
 *
 * Renders a react-native-webview that hosts an MCP App (e.g., calculatorTool).
 *
 * Auth strategy: fetch the app HTML via an authenticated fetch() call (which
 * uses api.ts token-refresh logic), then inject the HTML directly via
 * source={{ html }}. This bypasses react-native-webview's source.headers
 * which is unreliable on Android (headers silently dropped → infinite 401).
 *
 * Uses the useMcpBridge hook for JSON-RPC communication:
 *   - Inbound: app sends ui/initialize, tools/call, ui/size_changed, etc.
 *   - Outbound: host pushes tool-input/tool-result notifications
 *
 * @module components/chat/McpWebView
 */

import React, { useRef, useState, useEffect, useCallback, forwardRef, useImperativeHandle, useMemo } from 'react';
import { View, ActivityIndicator, StyleSheet, PermissionsAndroid, Platform, Linking } from 'react-native';
import { WebView } from 'react-native-webview';
import { getToken, ensureValidToken, refreshAccessToken } from '@/services/api';
import { useMcpBridge, type WebViewLike } from '@/hooks/useMcpBridge';
import { useResolvedScheme } from '@/hooks/useColors';
import { useI18n } from '@/hooks/useI18n';
import { useToastStore } from '@/stores/toast';
import {
  fetchMcpAppState,
  fetchMapOrigin,
  saveMapOrigin,
  isAddressFresh,
  isNearbyFresh,
  type CachedPoi,
  type MapOriginState,
} from '@/services/session-service';
import { wsService } from '@/services/websocket';
import { useChatStore } from '@/stores/chat';
import type { McpToolCallPayload } from '@/types';
import { logger } from '@/utils/logger';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'https://api.example.com';

/** Travel modes supported by the map HTML. Must match data-mode in HTML. */
export type MapMode = 'driving' | 'walking' | 'bicycling' | 'transit';

/** Route info emitted by the map HTML after each successful calculateRoute. */
export interface RouteInfo {
  mode: MapMode;
  distance: string;
  duration: string;
  origin?: { lat: number; lng: number };
  destination?: { lat: number; lng: number };
  destinationName?: string;
}

/**
 * Result summary emitted by the my-location HTML after each successful
 * reverse-geocode attempt. Carries the resolved address (or null when
 * geocoding failed) so the RN preview card can replace its "Locating..."
 * placeholder with the real text.
 */
export interface LocationResultInfo {
  /** Resolved address string, or null when reverse geocoding failed. */
  address: string | null;
  /** Coordinates used for the reverse-geocode query. */
  lat: number;
  lng: number;
}

/**
 * Result summary emitted by the nearby-search HTML after each successful
 * POI search. Carries just enough data for the RN preview card to render
 * the count and power a "navigate to first result" shortcut — full POI
 * list stays inside the WebView.
 */
export interface NearbyResultInfo {
  /** Total number of POIs found. */
  count: number;
  /** First POI coords (also auto-selected inside the WebView). */
  firstPoi?: {
    lat: number;
    lng: number;
    name?: string;
    rating?: number | null;
    photo?: string | null;
    category?: string;
    priceLevel?: number | null;
    openNow?: boolean | null;
    distanceMeters?: number | null;
  };
  /** Anchor coords used for the search (useful for fallback nav URL). */
  anchor?: { lat: number; lng: number };
  /** True when the widget rendered from the DB cache itself; the host should
   *  skip re-persisting this data (it is already stored). */
  cached?: boolean;
  /** Top 10 POIs for caching. Optional — not emitted in legacy flows. */
  pois?: CachedPoi[];
}

/** Imperative handle exposed via ref. */
export interface McpWebViewHandle {
  /** Switch the map's travel mode and trigger route recalculation. */
  switchMode: (mode: MapMode) => void;
}

/**
 * Inject a locationResponse into the WebView so the map HTML's message
 * listener picks up the origin coords and feeds them to onLocationAcquired.
 */
function buildLocationResponseScript(
  lat: number,
  lng: number,
  label: string,
  extras?: {
    cachedAddress?: string;
    cachedNearbyPois?: CachedPoi[];
    cachedNearbyCount?: number;
  },
): string {
  console.log(`[McpWebView] Injecting origin (${label}):`, lat, lng, extras ? 'with extras' : '');
  const ex = extras || {};
  const cachedAddressStr = ex.cachedAddress ? JSON.stringify(ex.cachedAddress) : 'null';
  const cachedPoisStr = ex.cachedNearbyPois ? JSON.stringify(ex.cachedNearbyPois) : 'null';
  const cachedCountStr =
    typeof ex.cachedNearbyCount === 'number' ? String(ex.cachedNearbyCount) : 'null';
  return `(function(){
    var payload = {
      type: 'locationResponse',
      location: { lat: ${lat}, lng: ${lng} },
      source: ${JSON.stringify(label)},
      cachedAddress: ${cachedAddressStr},
      cachedNearbyPois: ${cachedPoisStr},
      cachedNearbyCount: ${cachedCountStr}
    };
    window.dispatchEvent(new MessageEvent('message', { data: payload }));
    console.log('[Map] Dispatched origin (${label}):', ${lat}, ${lng});
  })();true;`;
}

export interface McpWebViewProps {
  /** The ui:// URI identifying the MCP app resource (e.g., "ui://calculator/main") */
  resourceUri: string;
  /** Tool call ID — used for tracking tool-input/tool-result pushes */
  toolCallId?: string;
  /** Latest tool input to push to the WebView (fire-and-forget on change) */
  toolInput?: { toolName: string; input: unknown };
  /** Latest tool result to push to the WebView (fire-and-forget on change) */
  toolResult?: { toolName: string; result: unknown };
  /** Callback when the app requests a server-side tool call */
  onToolCall?: (params: McpToolCallPayload) => void;
  /** Callback when the app updates model context */
  onUpdateModelContext?: (context: unknown) => void;
  /** Min height while loading or before size_changed is received */
  minHeight?: number;
  /** Max height cap to prevent excessively tall WebViews */
  maxHeight?: number;
  /** When true, container uses flex:1 to fill parent (ignores height calc).
   *  Use for full-screen layouts like modals where the WebView should fill
   *  all available area. */
  fillContainer?: boolean;
  /** When true, hides all map UI chrome (header, mode buttons, info bar,
   *  navigate button) and shows only the map canvas with route polyline.
   *  Used for compact preview thumbnails ("Inline Map + Route" pattern). */
  previewMode?: boolean;
  /** Called when the map HTML emits route info (distance/duration/mode). */
  onRouteInfo?: (info: RouteInfo) => void;
  /** Called when the my-location HTML emits a reverse-geocode result. */
  onLocationResult?: (info: LocationResultInfo) => void;
  /** Called when the nearby-search HTML emits a search-result summary. */
  onNearbyResult?: (info: NearbyResultInfo) => void;
  /** Safe-area top inset (status bar height) for full-screen map layouts.
   *  Injected as body padding-top so the widget's own header renders below
   *  the phone's status bar instead of overlapping its notification text.
   *  Only applied in full-screen (non-preview) mode. */
  topInset?: number;
}

const DEFAULT_MIN_HEIGHT = 420;
const DEFAULT_MAX_HEIGHT = 800;

/**
 * Inline replacement for the ext-apps SDK ES module import.
 *
 * Android WebView's loadDataWithBaseURL may treat the page origin as
 * about:blank, causing ES module imports (`import { App } from '/npm/...'`)
 * to silently fail — the SDK never loads, no ui/initialize handshake happens,
 * and the calculator stays blank.
 *
 * This stub reimplements the SDK's JSON-RPC transport as inline JS:
 * - App.connect() → sends ui/initialize, resolves on response
 * - App.callServerTool() → sends tools/call, resolves on immediate response
 *   (actual result arrives later via ontoolresult notification)
 * - Listens for notifications/tool-input, tool-result, tool-cancelled via
 *   window MessageEvent (dispatched by useMcpBridge.postToWebView)
 *
 * Replaces ONLY the `import { App } from '...'` line — all calculator
 * logic in the module script remains unchanged.
 */
const INLINE_APP_STUB = `
var __MCP_PENDING = {};
var __MCP_ID = 0;
var __MCP_APP = null;
window.addEventListener('message', function(ev) {
  var d = ev.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch(e) { return; } }
  if (!d || d.jsonrpc !== '2.0') return;
  if (d.id !== undefined && __MCP_PENDING[d.id]) {
    var p = __MCP_PENDING[d.id];
    delete __MCP_PENDING[d.id];
    if (d.error) p.reject(new Error(d.error.message || 'RPC error'));
    else p.resolve(d.result);
    return;
  }
  if (d.method && __MCP_APP) {
    if (d.method === 'ui/notifications/tool-input') {
      if (__MCP_APP.ontoolinput) __MCP_APP.ontoolinput(d.params || {});
    } else if (d.method === 'ui/notifications/tool-result') {
      if (__MCP_APP.ontoolresult) __MCP_APP.ontoolresult(d.params || {});
    } else if (d.method === 'ui/notifications/tool-cancelled') {
      if (__MCP_APP.ontoolcancelled) __MCP_APP.ontoolcancelled(d.params || {});
    }
  }
});
function __MCP_POST(msg) {
  var j = JSON.stringify(msg);
  if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
    window.ReactNativeWebView.postMessage(j);
  } else if (window.parent && window.parent.postMessage) {
    window.parent.postMessage(j, '*');
  }
}
class App {
  constructor(config) {
    this.config = config;
    this.ontoolinput = null;
    this.ontoolresult = null;
    this.ontoolcancelled = null;
  }
  connect() {
    __MCP_APP = this;
    return new Promise(function(resolve) {
      var id = ++__MCP_ID;
      __MCP_PENDING[id] = { resolve: resolve, reject: resolve };
      __MCP_POST({ jsonrpc: '2.0', id: id, method: 'ui/initialize', params: {} });
      setTimeout(function() { document.body.classList.add('ready'); }, 150);
    });
  }
  callServerTool(request, options) {
    var id = ++__MCP_ID;
    var timeout = (options && options.timeout) || 30000;
    return new Promise(function(resolve, reject) {
      __MCP_PENDING[id] = { resolve: resolve, reject: reject };
      __MCP_POST({ jsonrpc: '2.0', id: id, method: 'tools/call', params: { name: request.name, arguments: request.arguments } });
      setTimeout(function() {
        if (__MCP_PENDING[id]) {
          delete __MCP_PENDING[id];
          reject(new Error('Request timed out'));
        }
      }, timeout);
    });
  }
}
`;

export const McpWebView = forwardRef(function McpWebView({
  resourceUri,
  toolCallId,
  toolInput,
  toolResult,
  onToolCall,
  onUpdateModelContext,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxHeight = DEFAULT_MAX_HEIGHT,
  fillContainer = false,
  previewMode = false,
  onRouteInfo,
  onLocationResult,
  onNearbyResult,
  topInset = 0,
}: McpWebViewProps, ref: React.ForwardedRef<McpWebViewHandle>) {
  const webViewRef = useRef<WebView>(null);
  const scheme = useResolvedScheme();
  const { locale, t } = useI18n();
  const [isLoading, setIsLoading] = useState(true);
  const [fetchedHtml, setFetchedHtml] = useState<string | null>(null);

  // ── Resolve app locale to a 2-letter code the HTML map expects ──
  const mapLocale = useMemo(() =>
    locale?.startsWith('zh') ? 'zh'
    : locale?.startsWith('pt') ? 'pt'
    : 'en',
    [locale],
  );

  // ── Inject locale changes into the WebView so the map HTML can
  // re-apply translations (button labels, status text, etc.) when the
  // user switches language in the app settings.
  useEffect(() => {
    webViewRef.current?.injectJavaScript(
      `if(typeof window.__mcpSetLocale==='function'){window.__mcpSetLocale(${JSON.stringify(mapLocale)});}true;`
    );
  }, [mapLocale]);

  // ── Imperative API: expose switchMode so parent (MapToolRenderer) can
  // trigger travel-mode changes on the live WebView without remounting it.
  useImperativeHandle(ref, () => ({
    switchMode(mode: MapMode) {
      const script = `(function(){
        if (typeof window.__mcpMapSwitchMode === 'function') {
          window.__mcpMapSwitchMode(${JSON.stringify(mode)});
        }
      })();true;`;
      webViewRef.current?.injectJavaScript(script);
    },
  }), []);

  // ── Track pending tool name for WS result delivery ──
  const pendingToolName = useRef<string>('');

  // ── Serialize map-origin DB writes within this McpWebView instance ──
  // Each McpWebView renders ONE toolCallId. RN's WebView onMessage does not
  // await the previous handler before invoking the next, so two concurrent
  // postMessages (e.g. locationAcquired then locationResult) would race two
  // upserts against the same (resourceId, sessionId, toolCallId) row and
  // trigger MySQL P2002 unique-constraint violation. The chain below
  // guarantees every save runs strictly after the previous one completes.
  // saveMapOrigin already swallows errors and always resolves, so a rejected
  // save never breaks the chain.
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const queueMapOriginSave = useCallback(
    (
      sid: string,
      tcId: string,
      origin: Parameters<typeof saveMapOrigin>[2],
    ): Promise<boolean> => {
      saveChainRef.current = saveChainRef.current.then(() =>
        saveMapOrigin(sid, tcId, origin),
      );
      return saveChainRef.current;
    },
    [],
  );

  // ── Bridge hook: manages JSON-RPC communication ──
  // Intercept onToolCall to capture the toolName for later WS result routing.
  // The bridge sends an immediate JSON-RPC response to tools/call (preventing
  // SDK timeout -32001), so the actual result is delivered via pushToolResult
  // notification when the WS mcp-tool-result event arrives.
  const handleToolCall = useCallback((params: McpToolCallPayload) => {
    pendingToolName.current = params.toolName;
    onToolCall?.(params);
  }, [onToolCall]);

  const bridge = useMcpBridge(
    webViewRef as React.RefObject<WebViewLike | null>,
    {
      theme: scheme,
      toolCallId,
      onToolCall: handleToolCall,
      onUpdateModelContext,
    },
  );

  // ── Listen for WS mcp-tool-result / mcp-tool-error events ──
  // When the server responds to a tool call, push the result to the WebView
  // via the bridge's tool-result notification channel. This works in
  // conjunction with the immediate JSON-RPC response sent during tools/call.
  //
  // CRITICAL: This listener bypasses the chat store's streamingMessageId
  // gate (chat.ts line 883), which silently drops WS results when no message
  // is actively streaming. Without this listener, calculator results never
  // reach the WebView when the user interacts with it outside of streaming.
  const { pushToolResult, pushToolCancelled } = bridge;
  useEffect(() => {
    const unsubResult = wsService.on('mcp-tool-result', (event) => {
      const payload = (event as any).payload as
        | { toolCallId?: string; result?: unknown }
        | undefined;
      if (!payload?.toolCallId) return;
      // Only accept results matching THIS iframe's toolCallId.
      if (payload.toolCallId !== toolCallId) return;
      pushToolResult(payload.toolCallId, pendingToolName.current, payload.result);
    });
    const unsubError = wsService.on('mcp-tool-error', (event) => {
      const payload = (event as any).payload as
        | { toolCallId?: string; error?: string }
        | undefined;
      if (!payload?.toolCallId) return;
      if (payload.toolCallId !== toolCallId) return;
      pushToolCancelled(payload.toolCallId, payload.error ?? 'Unknown error');
    });
    return () => {
      unsubResult();
      unsubError();
    };
  }, [pushToolResult, pushToolCancelled, toolCallId]);

  // ── Push tool input and result to WebView (live updates only) ──
  // The INITIAL push is handled by the API fetch effect below, which gets
  // the latest state from the DB (not stale props from message history).
  // This effect only fires for SUBSEQUENT updates (e.g., live streaming).
  const { initialized } = bridge;
  const initialPushDone = useRef(false);
  useEffect(() => {
    if (!initialized) return;
    // Skip initial mount — API fetch effect handles hydration
    if (!initialPushDone.current) {
      initialPushDone.current = true;
      return;
    }
    // Live updates only (toolInput/toolResult changed during streaming)
    if (toolInput) {
      bridge.pushToolInput(toolCallId ?? '', toolInput.toolName, toolInput.input);
    }
    if (toolResult) {
      bridge.pushToolResult(toolCallId ?? '', toolResult.toolName, toolResult.result);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolInput, toolResult, initialized]);

  // ── Fetch latest MCP app state from DB (initial hydration) ──
  // Only pushes tool-INPUT (not tool-result). The calculator's
  // ontoolinput handler calls evaluate() internally when all three
  // args (num1, num2, operation) are present, which computes and
  // displays the result without triggering ontoolresult.
  //
  // Pushing tool-result separately causes "Tool returned no displayable
  // result" because the ext-apps SDK's ontoolresult handler has strict
  // format expectations that our client-side computation may not match
  // exactly.
  useEffect(() => {
    if (!initialized || !resourceUri) return;
    const sessionId = useChatStore.getState().currentSessionId;
    if (!sessionId) return;
    let cancelled = false;
    // Start API fetch immediately
    const statePromise = fetchMcpAppState(resourceUri, sessionId, toolCallId);
    // Delay push to allow WebView SDK stub to finish initializing
    const timer = setTimeout(() => {
      statePromise.then((state) => {
        if (cancelled) return;
        const tcId = toolCallId ?? '';
        // [MCP-LOG] Whether the destination/tool-input reached the WebView.
        // A missing push here means the map never gets its destination.
        const inputToPush = state?.toolInput?.input ?? toolInput?.input;
        logger.info('McpWebView', 'push tool input', {
          resourceUri,
          toolCallId: tcId,
          hasStateInput: !!state?.toolInput,
          hasPropInput: !!toolInput,
          dest: inputToPush && typeof inputToPush === 'object' ? (inputToPush as { destination?: unknown }).destination ?? null : null,
        });
        // Only push tool-input — calculator evaluates internally
        if (state?.toolInput) {
          bridge.pushToolInput(tcId, state.toolInput.toolName, state.toolInput.input);
        } else if (toolInput) {
          bridge.pushToolInput(tcId, toolInput.toolName, toolInput.input);
        }
      });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, resourceUri, toolCallId]);

  // ── Dynamic height from appSize, clamped ──
  const height = bridge.appSize?.height
    ? Math.min(Math.max(bridge.appSize.height, minHeight), maxHeight)
    : minHeight;

   // ── Fetch app HTML via authenticated fetch (bypasses WebView header bug) ──
   // Android's react-native-webview silently drops source.headers, causing
   // infinite 401 loops. Fetching the HTML ourselves (with ensureValidToken +
   // 401 retry, same as api.ts request()) sidesteps the issue entirely.
   //
   // The fetched HTML is passed via source={{ html, baseUrl }}. The baseUrl
   // maps to loadDataWithBaseURL() on Android, which sets the page origin to
   // the API server. This is critical: source={{ html }} alone uses origin
   // 'about:blank', causing ES module imports and fetch() calls from the page
   // to fail CORS checks (blank white page). A <base> tag does NOT fix this
   // because it only resolves URLs, not the security origin.
   //
   // DEBUG: A forced-visible style is injected so any rendering-layer issue
   // (SDK module load failure, etc.) becomes visible instead of leaving the
   // page at opacity:0 forever.
  useEffect(() => {
    if (!resourceUri) return;
    let cancelled = false;
    setIsLoading(true);
    setFetchedHtml(null);

    const viewPath = `/api/user/v1/mcp/apps/view?uri=${encodeURIComponent(resourceUri)}`;

    // [MCP-LOG] Entry — record which API we are fetching the widget HTML from
    // and the requested resource. In release builds this reveals whether the
    // app is hitting the real backend or being served a Nuxt SPA fallback.
    logger.info('McpWebView', 'fetch-app-html start', {
      resourceUri,
      apiBaseUrl: API_BASE_URL,
      viewPath,
      previewMode,
      topInset,
    });

    const doFetch = async (isRetry: boolean): Promise<string> => {
      if (!isRetry) await ensureValidToken(viewPath);
      const token = await getToken();
      const res = await fetch(`${API_BASE_URL}${viewPath}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      });
      if (res.status === 401 && !isRetry) {
        const refreshed = await refreshAccessToken();
        if (refreshed) return doFetch(true);
        throw new Error('HTTP 401 (session expired)');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    };

    doFetch(false)
      .then((html) => {
        if (cancelled) return;
        // [MCP-LOG] Fetch succeeded — log the raw length and whether the body
        // looks like a real widget HTML vs a Nuxt SPA fallback page (the latter
        // means /api/user/v1/mcp/apps/view was not proxied to the backend).
        const looksNuxt = html.includes('_nuxt') || html.includes('x-powered-by');
        const looksMapWidget = html.includes('map-app') || html.includes('navigate-btn') || html.includes('ui://googlemap');
        logger.info('McpWebView', 'fetch-app-html ok', {
          resourceUri,
          htmlLength: html.length,
          looksNuxt,
          looksMapWidget,
          headPreview: html.slice(0, 120),
        });
        // DEBUG: Force body visible + report viewport diagnostics back to RN.
        //
        // Per-app CSS overrides:
        //   - Calculator: clamp() values mis-evaluate under Android WebView's
        //     overview-mode viewport, so we pin them to fixed px values.
        //   - Map: needs body/html at zero padding/margin and full height so
        //     the map canvas can fill the WebView. The calculator's
        //     `padding: 16px !important` on body (previous bug) broke the
        //     map layout, shrinking the map viewport and hiding the Start
        //     Navigation button below the fold.
        const isMapApp = resourceUri?.includes('googlemap') || resourceUri?.includes('map');
        const mapBaseCss = `body, html { opacity: 1 !important; margin: 0 !important; padding: 0 !important; width: 100% !important; height: 100% !important; overflow: hidden !important; }`;
        // Preview mode ("Inline Map + Route" pattern): hide all UI chrome and
        // show only the map canvas with route polyline + markers. Used for
        // compact thumbnails embedded in chat bubbles.
        // Preview mode ("Inline Map + Route" pattern): hide all interactive
        // UI chrome but keep the destination name as a compact bottom overlay
        // floating over the map canvas. Used for compact thumbnails in chat.
        const mapPreviewCss = previewMode
            ? ` .mode-btn, .travel-modes, .info-bar, .status-bar, .navigate-btn, .nav-wrap,
    .loc-header, .info-card, .map-header,
    .nearby-header, .list-pane,
    .card-strip, .detail-panel,
    .locate-btn { display: none !important; }
    .map-container { min-height: 0 !important; }
    .map-app { position: relative !important; }
    .map-header {
      position: absolute !important;
      bottom: 0 !important;
      left: 0 !important;
      right: 0 !important;
      background: rgba(255,255,255,0.88) !important;
      backdrop-filter: blur(6px) !important;
      -webkit-backdrop-filter: blur(6px) !important;
      border-top: none !important;
      border-bottom: none !important;
      height: auto !important;
      padding: 6px 12px !important;
      gap: 6px !important;
      z-index: 5 !important;
    }
    .map-header .pin-icon { font-size: 13px !important; }
    .map-header .title { font-size: 12px !important; font-weight: 600 !important; }
    /* My-location and nearby-search apps: force the map container to fill
       the entire iframe so the preview banner shows map tiles only.
       The hidden UI chrome (header, info-card, list-pane) is replaced by
       RN-rendered info rows outside the WebView. */
    .loc-app, .nearby-app { position: relative !important; height: 100% !important; }
    .loc-app .map-container, .nearby-app .map-pane {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
    }`
            : '';
        const appCss = isMapApp
          ? mapBaseCss + mapPreviewCss +
            // Full-screen map (unified top style, navigation as reference):
            // remove the white safe-area strip so the map extends under the
            // translucent status bar (transparent top, map visible through),
            // and hide the widget's top title headers — the title is shown at
            // the bottom instead. Only the app's floating back button sits at
            // the top.
            (!previewMode && topInset > 0
              ? ` body { padding-top: 0 !important; }
    .nearby-header, .loc-header { display: none !important; }
    /* The navigation map keeps its own .map-header in normal (static) flow —
       it sits below the map canvas, above the travel-modes row, as part of
       the card stack. Do NOT reposition it absolutely here: that would pull
       the title to the very top, detached from the card. Its single bottom
       border + the travel-modes border-top removal give exactly one line. */
    .nearby-app .map-pane, .loc-app .map-container { top: 0 !important; }`
              : '')
          : `body { opacity: 1 !important; min-height: 100vh !important; width: 100% !important; padding: 16px !important; }
  .calculator { max-width: 360px !important; width: 100% !important; padding: 20px !important; gap: 12px !important; border-radius: 16px !important; }
  .display { min-height: 72px !important; padding: 16px !important; border-radius: 10px !important; }
  .display .expr { font-size: 14px !important; }
  .display .value { font-size: 28px !important; }
  .keys { gap: 8px !important; }
  .key { padding: 14px 0 !important; font-size: 18px !important; border-radius: 10px !important; }`;
        const debugInjections = `<style>${appCss}</style>
<script>
  (function() {
    function sendDiag() {
      try {
        var calc = document.querySelector('.calculator');
        var mapEl = document.querySelector('.map-container, #map, #mapCanvas');
        var info = {
          type: 'viewport-diagnostic',
          app: ${JSON.stringify(isMapApp ? 'map' : 'calculator')},
          uri: ${JSON.stringify(resourceUri ?? '')},
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
          screenWidth: screen.width,
          screenHeight: screen.height,
          bodyOffsetWidth: document.body.offsetWidth,
          bodyOffsetHeight: document.body.offsetHeight,
          bodyClientWidth: document.body.clientWidth,
          calcWidth: calc ? calc.offsetWidth : null,
          calcHeight: calc ? calc.offsetHeight : null,
          mapWidth: mapEl ? mapEl.offsetWidth : null,
          mapHeight: mapEl ? mapEl.offsetHeight : null,
          viewportMeta: document.querySelector('meta[name=viewport]') ? document.querySelector('meta[name=viewport]').content : null,
          readyState: document.readyState,
          bodyClassReady: document.body.classList.contains('ready'),
        };
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify(info));
        }
      } catch(e) { console.log('[DIAG ERROR]', e.message); }
    }
    if (document.readyState === 'complete') sendDiag();
    else window.addEventListener('load', function() { setTimeout(sendDiag, 100); });
    setTimeout(sendDiag, 500);
    setTimeout(sendDiag, 2000);
    setTimeout(sendDiag, 5000);
  })();
</script>`;
        // Replace relative /npm/ paths with absolute URLs.
        // Android WebView's loadDataWithBaseURL may not resolve ES module
        // import specifiers (which use /npm/... absolute paths) correctly —
        // the page origin can be treated as about:blank, making /npm/...
        // unresolvable. Using full http://host/npm/... URLs ensures the
        // browser can fetch the module regardless of origin handling.
        // Once the top-level module is fetched from the correct origin,
        // its transitive imports (/npm/...) also resolve correctly because
        // ES module specifier resolution uses the importing module's URL.
        let processed = html
          .replace(/from\s*["'](\/npm\/[^"']+)["]/g, `from "${API_BASE_URL}$1"`)
          .replace(/src=["'](\/npm\/[^"']+)["']/g, `src="${API_BASE_URL}$1"`)
          .replace(/href=["'](\/npm\/[^"']+)["']/g, `href="${API_BASE_URL}$1"`);
        // Replace the ext-apps SDK ES module import with an inline JSON-RPC
        // stub. This eliminates the dependency on ES module loading, which is
        // unreliable on Android WebView (loadDataWithBaseURL may treat the
        // page origin as about:blank, causing module fetches to silently fail).
        // Only the import line is replaced — all calculator logic in the
        // module script (render, evaluate, button handlers, ontoolresult, etc.)
        // remains unchanged and uses the inline App class.
        processed = processed.replace(
          /import\s*\{\s*App\s*\}\s*from\s*["'][^"']*ext-apps[^"']*["'];?/,
          INLINE_APP_STUB,
        );
        // Embed the locale directly into the HTML so it's available the
        // moment the <script> tag parses — before any module/i18n code runs.
        // This is more reliable than injectedJavaScriptBeforeContentLoaded,
        // which may not fire (or fires too late) when source={{ html }} uses
        // loadDataWithBaseURL on Android. The runtime locale-switch effect
        // (L210-214) still handles subsequent language changes.
        const localeInit = `<script>window.__MCP_LOCALE=${JSON.stringify(mapLocale)};</script>`;
        processed = processed.replace(/<\/head>/i, `${localeInit}${debugInjections}</head>`);
        // [MCP-LOG] HTML processing result — confirm the ext-apps import was
        // inlined and /npm/ paths were rewritten to the API origin. If the
        // source was a Nuxt fallback page, these will all be false/0.
        logger.info('McpWebView', 'fetch-app-html processed', {
          resourceUri,
          finalLength: processed.length,
          appStubInlined: processed.includes(INLINE_APP_STUB.slice(0, 40)),
          npmRewritten: processed.includes(`${API_BASE_URL}/npm/`),
          localeInjected: processed.includes('__MCP_LOCALE'),
        });
        setFetchedHtml(processed);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        // [MCP-LOG] Fetch/parse failure — the widget stays blank + the map
        // never requests location when this fires.
        logger.error('McpWebView', 'fetch-app-html error', {
          resourceUri,
          apiBaseUrl: API_BASE_URL,
          error: err instanceof Error ? err.message : String(err),
        });
        console.error('[McpWebView] Failed to fetch app HTML:', err);
        setIsLoading(false);
      });

      return () => {
       cancelled = true;
     };
   }, [resourceUri, previewMode, topInset]);

  // ── Loading indicator ──
  const renderLoading = useCallback(() => {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator
          size="small"
          color={scheme === 'dark' ? '#9CA3AF' : '#6B7280'}
        />
      </View>
    );
  }, [scheme]);

  // ── Error handler (non-auth errors only — auth handled by fetch) ──
  const handleError = useCallback(
    (e: { nativeEvent: { description?: string } }) => {
      // [MCP-LOG] WebView failed to render the fetched HTML. If the HTML was
      // actually a Nuxt SPA fallback, this fires because that page's JS can't
      // run under loadDataWithBaseURL — revealing the proxy misroute.
      logger.error('McpWebView', 'webview load error', {
        resourceUri,
        description: e.nativeEvent.description,
      });
      console.warn('[McpWebView] Load error:', e.nativeEvent.description);
    },
    [resourceUri],
  );

  // ── Message handler: intercept diagnostics + map messages, delegate JSON-RPC to bridge ──
  // The MCP Google Map app sends two non-JSON-RPC messages that bridge.handleMessage
  // would silently drop (it requires `jsonrpc: '2.0'`):
  //   - { type: 'requestLocation' } — WebView asks the host to ensure GPS permission
  //                                  and trigger its own navigator.geolocation call
  //   - { type: 'openNavigation', url, fallbackUrl } — WebView asks the host to
  //                                  launch the native map app (Google Maps / AMap)
  // Both are routed to handleMapPlatformMessage; everything else goes to the bridge.
  const handleMapPlatformMessage = useCallback(
    async (parsed: { type: string; url?: string; fallbackUrl?: string; location?: { lat: number; lng: number } }) => {
      // ── locationAcquired: save origin directly to DB ──
      // The WebView reports its GPS result. We persist it using the same
      // generic state API as the calculator — keyed by real sessionId + toolCallId.
      if (parsed.type === 'locationAcquired') {
        if (parsed.location) {
          const sid = useChatStore.getState().currentSessionId;
          if (sid && toolCallId) {
            // Source filtering happens in the HTML layer (onLocationAcquired
            // skips __MCP_POST when source === 'DB'), so by the time we get
            // here the location is always a fresh GPS / web-host acquisition.
            // Persist under this (sessionId, toolCallId) so reopening this
            // message reuses the cached origin instead of re-locating.
            await queueMapOriginSave(sid, toolCallId, parsed.location);
            console.log('[McpWebView] Origin saved to DB:', parsed.location.lat, parsed.location.lng);
          }
        }
        return;
      }

      if (parsed.type === 'requestLocation') {
        // [MCP-LOG] The map widget asked the host for location (this is the
        // gateway to the OS permission prompt). If this never logs, the
        // widget JS didn't reach requestUserLocation (e.g. blank/failed page).
        logger.info('McpWebView', 'requestLocation received', { resourceUri, toolCallId });
        // ── DB-first lookup policy (Option C: fixed anchor) ──
        // The "My Location" widget (ui://googlemap/location) is a PINNED
        // location — once saved it should NOT refresh on subsequent opens,
        // because the user explicitly expects "My Location" to stay where it
        // was first captured (e.g., home, office). Other map widgets
        // (route planner, nearby search) use the same cached origin as
        // their anchor.
        // To re-pin: delete the chat session's stored origin (clear DB).
        try {
          const sid = useChatStore.getState().currentSessionId;
          if (sid && toolCallId) {
            const savedOrigin: MapOriginState | null = await fetchMapOrigin(sid, toolCallId);
            if (savedOrigin) {
              console.log(
                '[McpWebView] requestLocation DB hit (per-toolCall):',
                savedOrigin.lat, savedOrigin.lng,
              );
              // Filter cached extras by presence (permanent cache — see
              // isAddressFresh / isNearbyFresh in session-service). Stale
              // fields are simply absent rather than expired by time.
              const extras: {
                cachedAddress?: string;
                cachedNearbyPois?: CachedPoi[];
                cachedNearbyCount?: number;
              } = {};
              if (isAddressFresh(savedOrigin) && savedOrigin.address) {
                extras.cachedAddress = savedOrigin.address;
              }
              if (isNearbyFresh(savedOrigin) && savedOrigin.nearbyResult) {
                extras.cachedNearbyPois = savedOrigin.nearbyResult.pois;
                extras.cachedNearbyCount = savedOrigin.nearbyResult.count;
              }
              webViewRef.current?.injectJavaScript(
                buildLocationResponseScript(
                  savedOrigin.lat,
                  savedOrigin.lng,
                  'DB',
                  Object.keys(extras).length > 0 ? extras : undefined,
                ),
              );
              return;
            }
            console.log('[McpWebView] requestLocation MISS (no DB origin for this toolCall) — falling to GPS');
          }
        } catch (e) {
          console.warn('[McpWebView] DB origin fetch failed, falling through to GPS:', e);
        }
        // ── DB miss: acquire via GPS / IP geolocation ──
        // ── Web platform: iframe geolocation is blocked by the browser's
        // permissions policy when the parent page is not a secure context
        // (e.g. http://192.168.x.x dev server). The HTML's phase 1/2
        // getCurrentPosition calls fail, triggering requestLocationFromRN.
        // Here we acquire location from the parent window (works if parent
        // is HTTPS or localhost) and fall back to IP geolocation. The
        // acquired coords are dispatched back into the iframe via
        // injectJavaScript, which the HTML's message listener picks up as
        // a { type: 'locationResponse' } event and feeds to onLocationAcquired.
        if (Platform.OS === 'web') {
          const tryParentGeolocation = (): Promise<{ lat: number; lng: number }> =>
            new Promise((resolve, reject) => {
              if (!navigator.geolocation) {
                reject(new Error('navigator.geolocation unavailable'));
                return;
              }
              navigator.geolocation.getCurrentPosition(
                (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
                (err) => reject(err),
                { timeout: 5000, enableHighAccuracy: false, maximumAge: 30000 },
              );
            });
          const tryIpGeolocation = async (): Promise<{ lat: number; lng: number }> => {
            // Free IP-based geolocation. City-level accuracy (~10km) is
            // sufficient for route distance/time estimation.
            const res = await fetch('https://ipapi.co/json/');
            if (!res.ok) throw new Error(`IP geolocation HTTP ${res.status}`);
            const data = await res.json();
            if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') {
              throw new Error('IP geolocation: missing coords');
            }
            return { lat: data.latitude, lng: data.longitude };
          };
          try {
            // Prefer precise browser geolocation; fall back to IP-based.
            const loc = await tryParentGeolocation().catch(() => tryIpGeolocation());
            // Persist to DB for subsequent map opens.
            const sid = useChatStore.getState().currentSessionId;
            if (sid && toolCallId) {
              await queueMapOriginSave(sid, toolCallId, loc);
            }
            console.log('[McpWebView] Web origin saved to DB:', loc.lat, loc.lng);
            const script = buildLocationResponseScript(loc.lat, loc.lng, 'web host');
            webViewRef.current?.injectJavaScript(script);
          } catch (err) {
            console.warn('[McpWebView] Web geolocation + IP fallback both failed:', err);
          }
          return;
        }
        // Step 1: Ensure Android runtime permission is granted.
        // react-native-webview auto-grants onGeolocationPermissionsShowPrompt
        // but only if the app holds ACCESS_FINE_LOCATION. Without runtime grant
        // on Android 6+, getCurrentPosition fails with permission denied.
        if (Platform.OS === 'android') {
          try {
            // [MCP-LOG] Android runtime location permission request starts.
            // If this line is absent from release logs, the requestLocation
            // message never reached this branch (blank page / no JS).
            logger.info('McpWebView', 'requesting Android location permission', {
              resourceUri,
            });
            const granted = await PermissionsAndroid.request(
              PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
              {
                title: 'Location Permission',
                message:
                  'KDOO needs location access to show directions and distance on the map.',
                buttonNeutral: 'Ask Me Later',
                buttonNegative: 'Cancel',
                buttonPositive: 'OK',
              },
            );
            if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
              logger.warn('McpWebView', 'location permission denied', { granted });
              console.warn('[McpWebView] Location permission denied');
              return;
            }
            logger.info('McpWebView', 'location permission granted');
          } catch (err) {
            logger.warn('McpWebView', 'permission request failed', {
              error: err instanceof Error ? err.message : String(err),
            });
            console.warn('[McpWebView] Permission request failed:', err);
            return;
          }
        }
        // Step 2: Inject a script that calls navigator.geolocation from inside
        // the WebView. On success, dispatch a MessageEvent that the map HTML's
        // message listener will pick up (it expects { type: 'locationResponse',
        // location: { lat, lng } }).
        // Two-phase geolocation strategy:
        //   Phase 1: low accuracy (network/WiFi) — fast (~2-5s), coarse (~100m).
        //            Sufficient for route calculation; distance won't change
        //            meaningfully with 100m offset.
        //   Phase 2: high accuracy (GPS) — slow (cold start 30s+), precise.
        //            Only tried if phase 1 fails entirely.
        // Previous bug: single call with enableHighAccuracy:true + 10s timeout.
        // Android GPS cold start takes 30s+, so both the HTML's initial call
        // and this injected call timed out, leaving the map with no origin.
        const script = `(function(){
          if (!navigator.geolocation) {
            console.warn('[Map] navigator.geolocation unavailable after permission grant');
            return;
          }
          function dispatch(lat, lng) {
            var payload = { type: 'locationResponse', location: { lat: lat, lng: lng } };
            window.dispatchEvent(new MessageEvent('message', { data: payload }));
            // Report back to native host so it can cache the origin for
            // subsequent map opens (option B: reuse first fix).
            if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'locationAcquired', location: { lat: lat, lng: lng } }));
            }
          }
          // Phase 1: fast network-based location
          navigator.geolocation.getCurrentPosition(
            function(pos) {
              console.log('[Map] Phase 1 (low accuracy) success:', pos.coords.latitude, pos.coords.longitude);
              dispatch(pos.coords.latitude, pos.coords.longitude);
            },
            function(err1) {
              console.warn('[Map] Phase 1 failed:', err1.message, '— retrying with GPS...');
              // Phase 2: GPS with extended timeout
              navigator.geolocation.getCurrentPosition(
                function(pos) {
                  console.log('[Map] Phase 2 (GPS) success:', pos.coords.latitude, pos.coords.longitude);
                  dispatch(pos.coords.latitude, pos.coords.longitude);
                },
                function(err2) {
                  console.warn('[Map] Phase 2 (GPS) also failed:', err2.message);
                },
                { timeout: 30000, enableHighAccuracy: true, maximumAge: 60000 }
              );
            },
            { timeout: 5000, enableHighAccuracy: false, maximumAge: 30000 }
          );
        })();true;`;
        webViewRef.current?.injectJavaScript(script);
        return;
      }

      if (parsed.type === 'openNavigation') {
        const scheme = parsed.url;
        const fallback = parsed.fallbackUrl;
        console.log('[McpWebView NAV] openNavigation received:', JSON.stringify({ scheme, fallback }));
        if (!scheme && !fallback) {
          console.warn('[McpWebView NAV] No scheme and no fallback — aborting');
          return;
        }
        // Skip Linking.canOpenURL(): on Android 11+ it requires a <queries>
        // declaration in AndroidManifest.xml for each custom scheme and will
        // otherwise return false even when the target app is installed.
        //
        // Linking.openURL() also fails for the same reason: React Native's
        // Android implementation internally calls intent.resolveActivity()
        // before startActivity(). On Android 11+ without <queries>,
        // resolveActivity() returns null → openURL rejects.
        //
        // Fallback strategy: if Linking.openURL(scheme) fails, inject the
        // scheme URL into the WebView via window.location.href. Android
        // WebView's shouldOverrideUrlLoading calls startActivity() directly
        // (without resolveActivity), so custom schemes are resolved by the
        // OS even without <queries>.
        if (scheme) {
          console.log('[McpWebView NAV] Attempting Linking.openURL:', scheme);
          try {
            await Linking.openURL(scheme);
            console.log('[McpWebView NAV] Linking.openURL succeeded');
            return;
          } catch (err) {
            console.warn('[McpWebView NAV] Linking.openURL failed (resolveActivity returned null on Android 11+):', JSON.stringify(err));
            // WebView fallback: trigger navigation from inside the WebView.
            // This bypasses React Native's resolveActivity check and uses
            // the OS's direct intent resolution via startActivity().
            console.log('[McpWebView NAV] Trying WebView navigation fallback:', scheme);
            webViewRef.current?.injectJavaScript(
              `(function(){ window.location.href = ${JSON.stringify(scheme)}; })();true;`,
            );
            // Give the OS a brief window to launch the external app before
            // attempting the https fallback. The external app launch is near-
            // instantaneous when the APK is installed.
            await new Promise((resolve) => setTimeout(resolve, 1500));
            // If we reach here, the scheme may have failed silently in the
            // WebView (no handler). Fall through to the https fallback below.
            console.log('[McpWebView NAV] WebView navigation may have failed — falling through to https fallback');
          }
        }
        if (fallback) {
          console.log('[McpWebView NAV] Attempting https fallback:', fallback);
          try {
            await Linking.openURL(fallback);
            console.log('[McpWebView NAV] Fallback opened successfully');
          } catch (err) {
            console.warn('[McpWebView NAV] Fallback also FAILED:', JSON.stringify(err));
            useToastStore
              .getState()
              .showToast({ message: t('map.navUnavailableMsg'), variant: 'warning' });
          }
        }
      }
    },
    [toolCallId, queueMapOriginSave, t],
  );

  const handleWebViewMessage = useCallback(
    async (rawData: string) => {
      // Intercept non-JSON-RPC messages: viewport diagnostics + map host actions.
      // These are dispatched before bridge.handleMessage which would drop them.
      try {
        const parsed = JSON.parse(rawData);
        // Log every non-JSON-RPC message for diagnostics. JSON-RPC messages
        // (jsonrpc: '2.0') are high-volume and noisy, so they're skipped.
        if (!parsed.jsonrpc) {
          logger.info('McpWebView', 'webview msg', {
            resourceUri,
            type: parsed.type ?? '(no type)',
          });
          console.log(`[McpWebView MSG] uri=${resourceUri ?? ''} type=${parsed.type ?? '(no type)'}`);
        }
        if (parsed && parsed.type === 'viewport-diagnostic') {
          console.log('[McpWebView DIAG]', JSON.stringify(parsed));
          return;
        }
        if (parsed && parsed.type === 'mapDiag') {
          // Execution-trace beacon from the map HTML. Each lifecycle milestone
          // (script start, SDK load, initMap, ontoolinput, geolocation, etc.)
          // emits a { type: 'mapDiag', name, data } message. This is the only
          // way to see the in-WebView execution path from release logs.
          logger.info('McpWebView', 'mapDiag', { resourceUri, name: parsed.name, data: parsed.data ?? null });
          console.log('[mapDiag]', parsed.name, parsed.data ? JSON.stringify(parsed.data) : '');
          return;
        }
        if (parsed && parsed.type === 'routeInfo') {
          // Map HTML emits this after each successful calculateRoute.
          // Forward to parent so the preview card can show distance/duration.
          console.log('[McpWebView] routeInfo received:', JSON.stringify(parsed));
          onRouteInfo?.(parsed as RouteInfo);
          return;
        }
        if (parsed && parsed.type === 'locationResult') {
          // My-location HTML emits this after reverse geocoding resolves
          // (or fails). address is null on failure so the preview can show
          // "Address unavailable" instead of hanging on "Locating...".
          console.log('[McpWebView] locationResult received:', JSON.stringify(parsed));
          onLocationResult?.(parsed as LocationResultInfo);
          // Persist address to DB so the next open skips reverse geocoding
          // (permanent cache — see isAddressFresh in session-service).
          if (typeof parsed.lat === 'number' && typeof parsed.lng === 'number') {
            const sid = useChatStore.getState().currentSessionId;
            if (sid && toolCallId) {
              await queueMapOriginSave(sid, toolCallId, {
                lat: parsed.lat,
                lng: parsed.lng,
                address: typeof parsed.address === 'string' ? parsed.address : undefined,
                resolvedAt: parsed.address ? Date.now() : undefined,
              });
              console.log(
                '[McpWebView] Address saved to DB:',
                parsed.address || '(empty)',
              );
            }
          }
          return;
        }
        if (parsed && parsed.type === 'nearbyResult') {
          // Nearby-search HTML emits this after each successful POI search.
          // Forward to parent so the preview card can render the count and
          // power the "navigate to first result" shortcut button.
          console.log('[McpWebView] nearbyResult received:', JSON.stringify(parsed));
          onNearbyResult?.(parsed as NearbyResultInfo);
          // If the widget rendered from the DB cache itself (cached=true),
          // the data is already persisted — skip the redundant re-save
          // (re-saving also used to overwrite the origin anchor and drift).
          if (parsed.cached) {
            return;
          }
          // Persist POI list to DB so the next open skips the Google Places
          // call (permanent cache — see isNearbyFresh in session-service).
          if (
            parsed.anchor &&
            typeof parsed.anchor.lat === 'number' &&
            typeof parsed.anchor.lng === 'number' &&
            Array.isArray(parsed.pois)
          ) {
            const sid = useChatStore.getState().currentSessionId;
            if (sid && toolCallId) {
              await queueMapOriginSave(sid, toolCallId, {
                lat: parsed.anchor.lat,
                lng: parsed.anchor.lng,
                nearbyResult: {
                  count: typeof parsed.count === 'number' ? parsed.count : parsed.pois.length,
                  firstPoi: parsed.firstPoi,
                  pois: parsed.pois as CachedPoi[],
                  searchedAt: Date.now(),
                },
              });
              console.log('[McpWebView] Nearby result saved to DB:', parsed.pois.length, 'pois');
            }
          }
          return;
        }
        if (parsed && (parsed.type === 'requestLocation' || parsed.type === 'openNavigation' || parsed.type === 'locationAcquired')) {
          console.log(`[McpWebView] Map action: ${parsed.type}`);
          await handleMapPlatformMessage(parsed);
          return;
        }
      } catch { /* not JSON, pass through to bridge */ }
      bridge.handleMessage(rawData);
    },
    [bridge, handleMapPlatformMessage, onRouteInfo, onLocationResult, onNearbyResult, resourceUri, queueMapOriginSave],
  );

  return (
    <View
      style={[
        styles.container,
        fillContainer ? { flex: 1, minHeight: 0, borderRadius: 0, minWidth: 0 } : { height },
        {
          backgroundColor: scheme === 'dark' ? '#0f1117' : '#FFFFFF',
        },
      ]}
      onLayout={(e) => {
        const { width: lw, height: lh } = e.nativeEvent.layout;
        console.log(`[McpWebView Layout] container: ${lw}x${lh}, state height=${height}`);
      }}
    >
      {fetchedHtml ? (
        <WebView
          ref={webViewRef}
          // IMPORTANT: baseUrl choice determines whether navigator.geolocation
          // works inside the WebView. Chromium blocks geolocation on insecure
          // origins, and http://192.168.x.x:PORT is NOT secure (the diagnostic
          // beacon shows: "Only secure origins are allowed"). 
          //  - HTTPS API origin (production) → use it directly: the permission
          //    prompt shows the real domain (e.g. https://www.kdoo.ai) and
          //    geolocation works because it is a secure context.
          //  - Non-HTTPS (dev on a LAN IP) → fall back to http://localhost/,
          //    which Chromium treats as a secure origin, so GPS still works
          //    (at the cost of the prompt showing "localhost").
          // Other apps (calculator) keep the API base URL so relative resource
          // URLs still resolve.
          source={{
            html: fetchedHtml,
            baseUrl: resourceUri.startsWith('ui://googlemap/')
              ? (API_BASE_URL.startsWith('https://') ? `${API_BASE_URL}/` : 'http://localhost/')
              : `${API_BASE_URL}/`,
          }}
          onMessage={(e) => handleWebViewMessage(e.nativeEvent.data)}
          injectedJavaScriptBeforeContentLoaded={`window.__MCP_LOCALE=${JSON.stringify(mapLocale)};\n${bridge.injectedJavaScript}`}
          style={styles.webview}
          containerStyle={styles.webviewContainer}
          renderLoading={renderLoading}
          startInLoadingState={true}
          onError={handleError}
          onHttpError={handleError}
          // Enable JS and storage
          javaScriptEnabled={true}
          domStorageEnabled={true}
          sharedCookiesEnabled={true}
          // Prevent the WebView from capturing the hardware back button
          allowsBackButtonNavigation={false}
          // Set user agent to identify the mobile host
          userAgent="kdoo-mobile/1.0.0 (MCP-Host)"
          // Android: grant WebView-internal geolocation permission prompt.
          // Without this, navigator.geolocation.getCurrentPosition inside
          // the WebView is silently denied by the system, regardless of
          // app-level ACCESS_FINE_LOCATION. We auto-grant because the app
          // already performs a runtime PermissionsAndroid.request above.
          onGeolocationPermissionsShowPrompt={(event) => {
            event.grant.run();
          }}
        />
      ) : isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator
            size="small"
            color={scheme === 'dark' ? '#9CA3AF' : '#6B7280'}
          />
        </View>
      ) : null}
    </View>
  );
}
);

const styles = StyleSheet.create({
  container: {
    width: '100%',
    // Force a minimum width — the parent ChatBubble uses items-start
    // (alignItems: flex-start), which causes the bubble to shrink to its
    // content's intrinsic width. Without this minWidth, the tool name header
    // (~106px) determines the bubble width, crushing the WebView.
    // 280px ensures the calculator renders at a usable size.
    // On a 360px screen: bubble max=324, px-4=32, border=2, px-1=8 → avail=282.
    minWidth: 280,
    overflow: 'hidden',
    borderRadius: 8,
  },
  webview: {
    flex: 1,
  },
  webviewContainer: {
    flex: 1,
  },
  loadingContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
