/**
 * MCP interactive WebView component — Web platform implementation.
 *
 * Renders a native HTML <iframe> that hosts an MCP App (e.g., calculatorTool,
 * googleMapTool). Uses the useMcpBridge hook for JSON-RPC communication:
 *   - Inbound: iframe posts messages via window.parent.postMessage → window 'message' event
 *   - Outbound: host calls iframe.contentWindow.postMessage(msg, '*')
 *
 * This replaces react-native-webview's <WebView> which is unavailable on web.
 *
 * Feature parity with native McpWebView.tsx:
 *   - forwardRef + McpWebViewHandle (switchMode) for map mode chips
 *   - previewMode (hide map UI chrome for compact thumbnails)
 *   - fillContainer (flex:1 for modal layouts)
 *   - onRouteInfo callback (distance/duration/mode from map)
 *   - Map platform message handling (requestLocation, openNavigation)
 *   - Web geolocation fallback (parent navigator.geolocation → ipapi.co)
 *
 * @module components/chat/McpWebView.web
 */

import React, { useRef, useState, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { View, ActivityIndicator, StyleSheet, Linking } from 'react-native';
import { getToken, ensureValidToken, refreshAccessToken } from '@/services/api';
import { useMcpBridge, type WebViewLike } from '@/hooks/useMcpBridge';
import { useResolvedScheme } from '@/hooks/useColors';
import { fetchMcpAppState } from '@/services/session-service';
import { wsService } from '@/services/websocket';
import { useChatStore } from '@/stores/chat';
import type { McpToolCallPayload } from '@/types';
import { i18n } from '@/i18n';
import { useToastStore } from '@/stores/toast';

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

/** Imperative handle exposed via ref. */
export interface McpWebViewHandle {
  /** Switch the map's travel mode and trigger route recalculation. */
  switchMode: (mode: MapMode) => void;
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
}

const DEFAULT_MIN_HEIGHT = 420;
const DEFAULT_MAX_HEIGHT = 800;

/**
 * Inline replacement for the ext-apps SDK ES module import.
 *
 * Web browsers support ES modules natively, but the iframe is loaded via
 * srcdoc which may run in a restricted context. To keep behavior identical
 * to the native version (and avoid module resolution issues), we replace
 * the `import { App } from '...'` line with this inline JSON-RPC stub.
 *
 * The stub exposes __MCP_POST which posts to the parent window on web
 * (vs. window.ReactNativeWebView on native).
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
  if (window.parent && window.parent.postMessage) {
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
// Forward uncaught errors and unhandled promise rejections to the parent
// window so they are visible in the parent's console (iframe console output
// is often suppressed or hard to find in RN/Web dev tools).
window.onerror = function(msg, url, line, col, error) {
  __MCP_POST({ type: 'iframeError', source: 'onerror', message: String(msg), url: url || '', line: line || 0, col: col || 0, stack: error && error.stack ? error.stack : '' });
};
window.addEventListener('unhandledrejection', function(ev) {
  var reason = ev.reason;
  __MCP_POST({ type: 'iframeError', source: 'unhandledrejection', message: reason && reason.message ? reason.message : String(reason), stack: reason && reason.stack ? reason.stack : '' });
});
`;

/**
 * Inject a script into the iframe via its contentWindow.
 * Returns true if the script was sent, false if the iframe isn't ready.
 */
function injectIntoIframe(
  iframe: HTMLIFrameElement | null,
  script: string,
): boolean {
  const win = iframe?.contentWindow;
  if (!win) return false;
  try {
    const s = document.createElement('script');
    s.textContent = script;
    win.document.body
      ? win.document.body.appendChild(s)
      : win.document.documentElement.appendChild(s);
    setTimeout(() => s.remove(), 0);
    return true;
  } catch {
    return false;
  }
}

export const McpWebView = forwardRef(function McpWebView(
  {
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
  }: McpWebViewProps,
  ref: React.ForwardedRef<McpWebViewHandle>,
) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const scheme = useResolvedScheme();
  const [isLoading, setIsLoading] = useState(true);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);

  // ── Create a WebViewLike adapter that wraps the iframe ref ──
  // postMessageToWindow sends a structured-clone message to the iframe's window,
  // which the MCP app receives via window.addEventListener('message', ...).
  const webViewLikeRef = useRef<WebViewLike | null>(null);
  if (webViewLikeRef.current === null) {
    webViewLikeRef.current = {
      postMessageToWindow: (message: unknown) => {
        const win = iframeRef.current?.contentWindow;
        if (win) {
          win.postMessage(message, '*');
        }
      },
    };
  }

  // ── Imperative API: expose switchMode so parent (MapToolRenderer) can
  // trigger travel-mode changes on the live iframe without remounting it.
  useImperativeHandle(
    ref,
    () => ({
      switchMode(mode: MapMode) {
        const script = `(function(){
          if (typeof window.__mcpMapSwitchMode === 'function') {
            window.__mcpMapSwitchMode(${JSON.stringify(mode)});
          }
        })();`;
        injectIntoIframe(iframeRef.current, script);
      },
    }),
    [],
  );

  // ── Track pending tool name for WS result delivery ──
  const pendingToolName = useRef<string>('');

  // ── Bridge hook: manages JSON-RPC communication ──
  const handleToolCall = useCallback(
    (params: McpToolCallPayload) => {
      pendingToolName.current = params.toolName;
      onToolCall?.(params);
    },
    [onToolCall],
  );

  const bridge = useMcpBridge(webViewLikeRef, {
    theme: scheme,
    toolCallId,
    onToolCall: handleToolCall,
    onUpdateModelContext,
  });

  // ── Listen for WS mcp-tool-result / mcp-tool-error events ──
  const { pushToolResult, pushToolCancelled } = bridge;
  useEffect(() => {
    const unsubResult = wsService.on('mcp-tool-result', (event) => {
      const payload = (event as any).payload as
        | { toolCallId?: string; result?: unknown }
        | undefined;
      if (!payload?.toolCallId) return;
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

  // ── Map platform message handler ──
  // Mirrors native McpWebView.handleMapPlatformMessage, but the Web branch is
  // the only one that runs here (Platform.OS === 'web' always on this file).
  // Web geolocation flow:
  //   iframe's navigator.geolocation is blocked by the browser's permissions
  //   policy when the parent page is not a secure context (e.g.
  //   http://192.168.x.x dev server). The HTML's phase 1/2 getCurrentPosition
  //   calls fail, triggering requestLocationFromRN → parent.postMessage.
  //   Here we acquire location from the parent window (works if parent is
  //   HTTPS or localhost) and fall back to IP geolocation. The acquired coords
  //   are dispatched back into the iframe via injectIntoIframe, which the
  //   HTML's message listener picks up as a { type: 'locationResponse',
  //   location: { lat, lng } } event and feeds to onLocationAcquired.
  const handleMapPlatformMessage = useCallback(
    async (parsed: {
      type: string;
      url?: string;
      fallbackUrl?: string;
    }) => {
      if (parsed.type === 'requestLocation') {
        const tryParentGeolocation = (): Promise<{ lat: number; lng: number }> =>
          new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
              reject(new Error('navigator.geolocation unavailable'));
              return;
            }
            navigator.geolocation.getCurrentPosition(
              (pos) =>
                resolve({
                  lat: pos.coords.latitude,
                  lng: pos.coords.longitude,
                }),
              (err) => reject(err),
              {
                timeout: 5000,
                enableHighAccuracy: false,
                maximumAge: 30000,
              },
            );
          });
        const tryIpGeolocation = async (): Promise<{ lat: number; lng: number }> => {
          // Free IP-based geolocation. City-level accuracy (~10km) is
          // sufficient for route distance/time estimation.
          const res = await fetch('https://ipapi.co/json/');
          if (!res.ok) throw new Error(`IP geolocation HTTP ${res.status}`);
          const data = await res.json();
          if (
            typeof data.latitude !== 'number' ||
            typeof data.longitude !== 'number'
          ) {
            throw new Error('IP geolocation: missing coords');
          }
          return { lat: data.latitude, lng: data.longitude };
        };
        try {
          const loc = await tryParentGeolocation().catch(() =>
            tryIpGeolocation(),
          );
          const script = `(function(){
            var payload = { type: 'locationResponse', location: { lat: ${loc.lat}, lng: ${loc.lng} } };
            window.dispatchEvent(new MessageEvent('message', { data: payload }));
            console.log('[Map] Web host dispatched locationResponse:', ${loc.lat}, ${loc.lng});
          })();`;
          injectIntoIframe(iframeRef.current, script);
        } catch (err) {
          console.warn(
            '[McpWebView.web] Web geolocation + IP fallback both failed:',
            err,
          );
        }
        return;
      }

      if (parsed.type === 'openNavigation') {
        const url = parsed.url || parsed.fallbackUrl;
        if (!url) return;
        try {
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch (err) {
          console.warn('[McpWebView.web] Failed to open navigation URL:', err);
          useToastStore
            .getState()
            .showToast({ message: i18n.t('map.openUrlFailed'), variant: 'warning' });
        }
      }
    },
    [],
  );

  // ── Listen for inbound messages from the iframe ──
  // The MCP app inside the iframe calls window.parent.postMessage(msg, '*'),
  // which triggers a 'message' event on our window.
  // NOTE: depend on bridge.handleMessage (a useCallback) instead of bridge object,
  // because the bridge object is a new reference every render.
  const { handleMessage, initialized } = bridge;
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      // Security: only process messages originating from our iframe
      if (event.source !== iframeRef.current?.contentWindow) return;
      let data = event.data;
      if (!data) return;
      // INLINE_APP_STUB's __MCP_POST sends JSON strings (not objects).
      // Bridge's handleMessage also expects a string. Parse here so the
      // non-JSON-RPC interceptors below can inspect the object shape.
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return; }
      }
      if (typeof data !== 'object') return;

      // Intercept non-JSON-RPC messages (map-specific):
      //   - { type: 'iframeError', ... } → console error (uncaught iframe errors)
      //   - { type: 'routeInfo', ... } → forward to onRouteInfo callback
      //   - { type: 'mapDiag', ... } → console log only (execution trace)
      //   - { type: 'requestLocation' } → parent-window geolocation
      //   - { type: 'openNavigation', url, fallbackUrl } → window.open
      // These are dispatched before bridge.handleMessage which would drop them.
      if (!data.jsonrpc) {
        if (data.type === 'iframeError') {
          console.error(
            '[McpWebView.web] Iframe error:',
            data.source || 'unknown',
            data.message || '(no message)',
            data.url ? `at ${data.url}:${data.line}:${data.col}` : '',
            data.stack || '',
          );
          return;
        }
        if (data.type === 'routeInfo') {
          console.log('[McpWebView.web] routeInfo received:', JSON.stringify(data));
          onRouteInfo?.(data as RouteInfo);
          return;
        }
        if (data.type === 'mapDiag') {
          console.log(
            '[mapDiag]',
            data.name,
            data.data ? JSON.stringify(data.data) : '',
          );
          return;
        }
        if (
          data.type === 'requestLocation' ||
          data.type === 'openNavigation'
        ) {
          console.log(`[McpWebView.web] Map action: ${data.type}`);
          handleMapPlatformMessage(data);
          return;
        }
      }

      // handleMessage expects a raw JSON string, so stringify the object
      handleMessage(JSON.stringify(data));
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [handleMessage, handleMapPlatformMessage, onRouteInfo]);

  // ── Push tool input and result to iframe (live updates only) ──
  const initialPushDone = useRef(false);
  useEffect(() => {
    if (!initialized) return;
    if (!initialPushDone.current) {
      initialPushDone.current = true;
      return;
    }
    if (toolInput) {
      bridge.pushToolInput(toolCallId ?? '', toolInput.toolName, toolInput.input);
    }
    if (toolResult) {
      bridge.pushToolResult(toolCallId ?? '', toolResult.toolName, toolResult.result);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolInput, toolResult, initialized]);

  // ── Fetch latest MCP app state from DB (initial hydration) ──
  useEffect(() => {
    if (!initialized || !resourceUri) return;
    const sessionId = useChatStore.getState().currentSessionId;
    if (!sessionId) return;
    let cancelled = false;
    const statePromise = fetchMcpAppState(resourceUri, sessionId, toolCallId);
    const timer = setTimeout(() => {
      statePromise.then((state) => {
        if (cancelled) return;
        const tcId = toolCallId ?? '';
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

  // ── Fetch app HTML via authenticated API call ──
  // Web iframes cannot set custom HTTP headers, so we fetch the HTML
  // ourselves and inject it via srcdoc.
  //
  // Token handling mirrors api.ts request(): ensureValidToken() pre-checks
  // expiry, and on 401 we refresh once and retry.
  //
  // After fetching, per-app CSS overrides are injected:
  //   - <base href="${API_BASE_URL}/"> so relative /npm/ paths resolve
  //   - Map apps: body/html at zero padding/margin, full width/height.
  //   - previewMode: hide all map UI chrome, show only the canvas.
  useEffect(() => {
    if (!resourceUri) return;
    let cancelled = false;
    setIsLoading(true);
    setSrcDoc(null);

    const viewPath = `/api/user/v1/mcp/apps/view?uri=${encodeURIComponent(resourceUri)}`;

    const doFetch = async (isRetry: boolean): Promise<string> => {
      if (!isRetry) {
        await ensureValidToken(viewPath);
      }
      const token = await getToken();
      const res = await fetch(`${API_BASE_URL}${viewPath}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
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
        // Inject <base> so /npm/ and other root-relative paths resolve
        // to the API server rather than the parent page origin.
        let processed = html.replace(
          /<head>/i,
          `<head><base href="${API_BASE_URL}/">`,
        );

        const isMapApp =
          resourceUri?.includes('googlemap') ||
          resourceUri?.includes('map');

        if (isMapApp) {
          // Map needs body/html at zero padding/margin and full height so the
          // map canvas can fill the iframe.
          const mapBaseCss = `body, html { opacity: 1 !important; margin: 0 !important; padding: 0 !important; width: 100% !important; height: 100% !important; overflow: hidden !important; }`;
          // Preview mode ("Inline Map + Route" pattern): hide all UI chrome
          // and show only the map canvas with route polyline + markers.
          const mapPreviewCss = previewMode
            ? ` .map-header, .mode-btn, .info-bar, .status-bar, .navigate-btn { display: none !important; } .map-container { min-height: 0 !important; }`
            : '';
          processed = processed.replace(
            /<\/head>/i,
            `<style>${mapBaseCss}${mapPreviewCss}</style></head>`,
          );
        }

        // Replace relative /npm/ paths with absolute URLs for the same
        // reason as the <base> tag — defensive.
        processed = processed
          .replace(/from\s*["'](\/npm\/[^"']+)["]/g, `from "${API_BASE_URL}$1"`)
          .replace(/src=["'](\/npm\/[^"']+)["]/g, `src="${API_BASE_URL}$1"`)
          .replace(/href=["'](\/npm\/[^"']+)["]/g, `href="${API_BASE_URL}$1"`);

        // Replace the ext-apps SDK ES module import with an inline JSON-RPC
        // stub. This matches the native version's behavior and avoids any
        // module resolution issues under srcdoc.
        processed = processed.replace(
          /import\s*\{\s*App\s*\}\s*from\s*["'][^"']*ext-apps[^"']*["'];?/,
          INLINE_APP_STUB,
        );

        setSrcDoc(processed);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[McpWebView.web] Failed to fetch app HTML:', err);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceUri, previewMode]);

  return (
    <View
      style={[
        styles.container,
        fillContainer
          ? { flex: 1, minHeight: 0, borderRadius: 0, minWidth: 0 }
          : { height },
        {
          backgroundColor: scheme === 'dark' ? '#0f1117' : '#FFFFFF',
        },
      ]}
    >
      {isLoading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator
            size="small"
            color={scheme === 'dark' ? '#9CA3AF' : '#6B7280'}
          />
        </View>
      )}
      {srcDoc &&
        React.createElement('iframe', {
          ref: iframeRef,
          srcDoc,
          onLoad: () => setIsLoading(false),
          style: {
            width: '100%',
            height: '100%',
            border: 'none',
            overflow: 'auto',
          },
          // allow-same-origin lets the iframe's geolocation API be gated by
          // the parent page's Permissions Policy instead of being blocked
          // outright. allow-scripts is required for the map SDK to run.
          // geolocation permission must be explicitly listed in `allow`.
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups',
          allow: 'clipboard-write; fullscreen; geolocation',
          title: `MCP App: ${resourceUri}`,
        })}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    width: '100%',
    overflow: 'hidden',
    borderRadius: 8,
  },
  loadingContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
});
