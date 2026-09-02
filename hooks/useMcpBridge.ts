/**
 * MCP Apps Bridge for React Native WebView communication.
 *
 * Implements the MCP Apps protocol (JSON-RPC over postMessage) from the
 * perspective of the RN host. Handles bidirectional communication with
 * MCP App WebViews: initialization, tool call proxying, size changes,
 * model context updates, and lifecycle events.
 *
 * In the web version (useMcpAppBridge), communication uses:
 *   - Inbound: window.addEventListener('message', ...)
 *   - Outbound: iframe.contentWindow.postMessage(...)
 *
 * In React Native, communication uses:
 *   - Inbound: WebView onMessage prop (event.nativeEvent.data)
 *   - Outbound: webViewRef.injectJavaScript(script)
 *
 * The WebView injects a polyfill that converts window.parent.postMessage
 * calls into ReactNativeWebView.postMessage calls.
 *
 * Reference: https://modelcontextprotocol.io/extensions/apps/overview
 *
 * @module hooks/useMcpBridge
 */

import { useState, useCallback, useMemo, useRef } from 'react';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  McpUiHostCapabilities,
  McpToolCallPayload,
} from '@/types';

/** Minimal transport interface for the WebView ref.
 *
 * On React Native, the react-native-webview ref provides `injectJavaScript`.
 * On Web, the iframe adapter provides `postMessageToWindow`.
 * Either one is sufficient — `postToWebView` checks both. */
export interface WebViewLike {
  /** Native: inject and execute a JS string inside the WebView */
  injectJavaScript?: (script: string) => void;
  /** Web: post a structured-clone message to the iframe's contentWindow */
  postMessageToWindow?: (message: unknown) => void;
}

export interface UseMcpBridgeOptions {
  /** Current color scheme — sent to the app during initialization */
  theme: 'dark' | 'light';
  /** Stable toolCallId from the message store.
   *  When the app calls tools/call without a toolCallId, this value is used
   *  instead of generating a random one. This keeps WS round-trips and DB
   *  state saves aligned with the message store's toolCallId. */
  toolCallId?: string;
  /** Fired when the app requests a server-side tool call */
  onToolCall?: (params: McpToolCallPayload) => void;
  /** Fired when the app updates model context */
  onUpdateModelContext?: (context: unknown) => void;
  /** Fired when the app sends a conversation message */
  onSendMessage?: (message: unknown) => void;
  /** Fired when the app requests opening a URL */
  onOpenLink?: (url: string) => void;
  /** Fired when the app requests a file download */
  onDownloadFile?: (params: { uri: string; filename?: string }) => void;
}

export interface UseMcpBridgeReturn {
  /** Whether the app completed the ui/initialize handshake */
  initialized: boolean;
  /** Current app size as reported by ui/size_changed */
  appSize: { width: number; height: number } | null;
  /** Connected resource URI (the ui:// URI from the tool output) */
  connectedResourceUri: string | null;
  /** Handle a raw message string from WebView onMessage */
  handleMessage: (rawData: string) => void;
  /** Push tool input (streaming or complete) to the app */
  pushToolInput: (toolCallId: string, toolName: string, input: unknown) => void;
  /** Push tool result to the app */
  pushToolResult: (toolCallId: string, toolName: string, result: unknown) => void;
  /** Respond to a pending tools/call request from the app */
  sendToolResponse: (responseId: string | number, result: unknown) => void;
  /** Resolve a pending tools/call by toolCallId (replies JSON-RPC response to iframe) */
  resolveToolCall: (toolCallId: string, result: unknown) => void;
  /** Reject a pending tools/call by toolCallId (replies JSON-RPC error to iframe) */
  rejectToolCall: (toolCallId: string, errorMessage: string) => void;
  /** Notify the app that a tool call was cancelled or errored */
  pushToolCancelled: (toolCallId: string, reason?: string) => void;
  /** Notify the app of a host context change (e.g., theme) */
  pushHostContextChanged: (context: Record<string, unknown>) => void;
  /** Inject this script before content loads — polyfills window.parent.postMessage */
  injectedJavaScript: string;
}

/** The polyfill script injected into the WebView before content loads. */
const BRIDGE_POLYFILL = `
(function() {
  // Polyfill: intercept window.parent.postMessage and redirect to ReactNativeWebView
  var rnPostMessage = window.ReactNativeWebView && window.ReactNativeWebView.postMessage;
  if (rnPostMessage) {
    // Ensure window.parent exists (some apps access it without checking)
    if (!window.parent || window.parent === window) {
      window.parent = {};
    }
    // Replace postMessage on window.parent so the MCP app SDK can talk to us
    window.parent.postMessage = function(message, targetOrigin) {
      try {
        rnPostMessage(typeof message === 'string' ? message : JSON.stringify(message));
      } catch (e) {
        console.error('[McpBridge Polyfill] Failed to postMessage:', e);
      }
    };
    // Also replace window.postMessage for apps that use it directly
    window.postMessage = function(message, targetOrigin) {
      try {
        rnPostMessage(typeof message === 'string' ? message : JSON.stringify(message));
      } catch (e) {
        console.error('[McpBridge Polyfill] Failed to postMessage:', e);
      }
    };
  }
})();
true;
`;

/**
 * MCP Apps Bridge for React Native WebView.
 *
 * Usage:
 * ```tsx
 * const webViewRef = useRef<WebView>(null);
 * const bridge = useMcpBridge(webViewRef, {
 *   theme: isDark ? 'dark' : 'light',
 *   onToolCall: (params) => { ... },
 * });
 *
 * <WebView
 *   ref={webViewRef}
 *   onMessage={(e) => bridge.handleMessage(e.nativeEvent.data)}
 *   injectedJavaScriptBeforeContentLoaded={bridge.injectedJavaScript}
 * />
 * ```
 */
export function useMcpBridge(
  webViewRef: React.RefObject<WebViewLike | null>,
  options: UseMcpBridgeOptions,
): UseMcpBridgeReturn {
  const [initialized, setInitialized] = useState(false);
  const [appSize, setAppSize] = useState<{ width: number; height: number } | null>(null);
  const [connectedResourceUri, setConnectedResourceUri] = useState<string | null>(null);

  // Map of pending tools/call requests from the app: toolCallId → JSON-RPC id
  // When the server responds via WS mcp-tool-result, we use this to reply to the iframe.
  const responseIdMap = useRef<Map<string, string | number>>(new Map());

  // ---- host capabilities ----
  const hostCapabilities = useMemo<McpUiHostCapabilities>(() => ({
    tools: { call: true },
    messages: true,
    context: { update: true },
    links: { open: false },
    files: { download: false },
    display: { resize: true, mode: false },
    theme: options.theme,
  }), [options.theme]);

  // ---- postMessage to WebView ----
  const postToWebView = useCallback((message: JsonRpcMessage): void => {
    const ref = webViewRef.current;
    if (!ref) {
      console.warn('[useMcpBridge] WebView ref not available, dropping message');
      return;
    }

    // Web iframe transport: post structured-clone message directly
    if (typeof ref.postMessageToWindow === 'function') {
      try {
        ref.postMessageToWindow(message);
      } catch (err) {
        console.warn('[useMcpBridge] postMessageToWindow failed:', err);
      }
      return;
    }

    // Native WebView transport: inject JS that dispatches a MessageEvent
    if (typeof ref.injectJavaScript === 'function') {
      const json = JSON.stringify(message);
      const script = `(function(){window.dispatchEvent(new MessageEvent('message',{data:${json}}));})();true;`;
      try {
        ref.injectJavaScript(script);
      } catch (err) {
        console.warn('[useMcpBridge] injectJavaScript failed:', err);
      }
      return;
    }

    console.warn('[useMcpBridge] No transport method available on ref');
  }, [webViewRef]);

  const sendResponse = useCallback((id: string | number, result: unknown): void => {
    const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    postToWebView(msg);
  }, [postToWebView]);

  const sendError = useCallback((id: string | number, code: number, message: string, data?: unknown): void => {
    const msg: JsonRpcResponse = { jsonrpc: '2.0', id, error: { code, message, data } };
    postToWebView(msg);
  }, [postToWebView]);

  const sendNotification = useCallback((method: string, params?: Record<string, unknown>): void => {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    postToWebView(msg);
  }, [postToWebView]);

  // ---- inbound: handle JSON-RPC requests from the app ----
  const handleRequest = useCallback((msg: JsonRpcRequest): void => {
    const { id, method, params } = msg;

    switch (method) {
      // ---- initialization handshake ----
      case 'ui/initialize': {
        setInitialized(true);
        if (params?.resourceUri && typeof params.resourceUri === 'string') {
          setConnectedResourceUri(params.resourceUri);
        }
        sendResponse(id ?? 0, {
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'kdoo-mobile', version: '1.0.0' },
          hostCapabilities,
          hostContext: { theme: options.theme },
        });
        // Follow up with ui/initialized notification
        sendNotification('ui/initialized');
        break;
      }

      // ---- tool call proxying (app → server) ----
      case 'tools/call': {
        const toolName = (params?.name ?? params?.toolName ?? '') as string;
        // Guard: if no toolName, immediately respond with error.
        // Without a response, the app SDK will retry indefinitely.
        if (!toolName) {
          sendError(id ?? 0, -32602, 'Invalid params: toolName is required');
          break;
        }
        const args = (params?.arguments ?? params?.args ?? {}) as Record<string, unknown>;
        const meta = (params?._meta ?? {}) as Record<string, unknown>;
        // Use the message store's stable toolCallId so WS round-trips and DB
        // state saves are aligned with the message. Without this, generateId()
        // creates a random ID that doesn't match the DB record on refresh.
        const toolCallId = (params?.toolCallId ?? meta.toolCallId ?? options.toolCallId ?? generateId()) as string;
        // Immediately respond with a minimal valid result to prevent the app
        // SDK's internal timeout (-32001). The actual result will be delivered
        // via pushToolResult notification when the server responds via WS.
        if (id !== undefined && id !== null) {
          sendResponse(id, {
            content: [{ type: 'text', text: '' }],
          });
        }
        options.onToolCall?.({ toolCallId, toolName, args, responseId: id ?? 0 });
        break;
      }

      // ---- size changes ----
      case 'ui/size_changed': {
        const width = (params?.width as number) ?? 0;
        const height = (params?.height as number) ?? 0;
        console.log(`[useMcpBridge] ui/size_changed width=${width} height=${height} resourceUri=${options.toolCallId ?? ''}`);
        setAppSize({ width, height });
        if (id !== undefined && id !== null) {
          sendResponse(id, {});
        }
        break;
      }

      // ---- model context updates ----
      case 'ui/update_model_context': {
        options.onUpdateModelContext?.(params?.context);
        if (id !== undefined && id !== null) {
          sendResponse(id, {});
        }
        break;
      }

      // ---- message to conversation ----
      case 'ui/message': {
        options.onSendMessage?.(params?.message ?? params);
        if (id !== undefined && id !== null) {
          sendResponse(id, {});
        }
        break;
      }

      // ---- open link ----
      case 'ui/open_link': {
        options.onOpenLink?.((params?.url ?? '') as string);
        if (id !== undefined && id !== null) {
          sendResponse(id, {});
        }
        break;
      }

      // ---- file download ----
      case 'ui/download_file': {
        options.onDownloadFile?.({
          uri: (params?.uri ?? '') as string,
          filename: params?.filename as string | undefined,
        });
        if (id !== undefined && id !== null) {
          sendResponse(id, {});
        }
        break;
      }

      // ---- display mode ----
      case 'ui/request_display_mode': {
        if (id !== undefined && id !== null) {
          sendResponse(id, { mode: 'inline' });
        }
        break;
      }

      // ---- resource teardown ----
      case 'ui/request_teardown':
      case 'ui/resource_teardown': {
        setInitialized(false);
        setConnectedResourceUri(null);
        if (id !== undefined && id !== null) {
          sendResponse(id, {});
        }
        break;
      }

      default:
        if (id !== undefined && id !== null) {
          sendError(id, -32601, `Method not found: ${method}`);
        }
        break;
    }
  }, [hostCapabilities, options, sendResponse, sendError, sendNotification]);

  const handleNotification = useCallback((msg: JsonRpcNotification): void => {
    switch (msg.method) {
      case 'ui/sandbox_resource_ready':
        if (msg.params?.resourceUri && typeof msg.params.resourceUri === 'string') {
          setConnectedResourceUri(msg.params.resourceUri);
        }
        break;
      case 'ui/sandbox_proxy_ready':
      case 'ui/initialized':
        setInitialized(true);
        break;
      default:
        break;
    }
  }, []);

  // ---- main message handler (called from WebView onMessage) ----
  const handleMessage = useCallback((rawData: string): void => {
    if (!rawData) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return; // Not JSON, silently ignore
    }

    const msg = parsed as JsonRpcMessage;
    if (!msg || msg.jsonrpc !== '2.0') return;

    // Route: request (has id) vs notification (no id)
    if ('id' in msg && msg.id !== undefined) {
      handleRequest(msg as JsonRpcRequest);
    } else if ('method' in msg && typeof msg.method === 'string') {
      handleNotification(msg as JsonRpcNotification);
    }
  }, [handleRequest, handleNotification]);

  // ---- outbound: push methods ----
  const pushToolInput = useCallback((toolCallId: string, toolName: string, input: unknown): void => {
    sendNotification('ui/notifications/tool-input', {
      toolCallId,
      toolName,
      arguments: input,
    });
  }, [sendNotification]);

  const pushToolResult = useCallback((toolCallId: string, toolName: string, result: unknown): void => {
    // The SDK's ui/notifications/tool-result expects params to be a
    // CallToolResult DIRECTLY ({ content, structuredContent, isError }),
    // NOT wrapped in { toolCallId, toolName, result }.
    // The schema uses z.core.$loose so extra keys are kept, but
    // structuredContent/content would be missing from the parsed params.
    // (toolCallId/toolName are accepted as args for API symmetry with
    // pushToolInput but are NOT included in the notification params.)
    const params = (result && typeof result === 'object' && !Array.isArray(result))
      ? result as Record<string, unknown>
      : { content: [{ type: 'text', text: String(result ?? '') }] };
    sendNotification('ui/notifications/tool-result', params);
  }, [sendNotification]);

  const sendToolResponse = useCallback((responseId: string | number, result: unknown): void => {
    sendResponse(responseId, result);
  }, [sendResponse]);

  /**
   * Resolve a pending tools/call request from the app.
   * Called when the server responds via WS mcp-tool-result.
   * Sends the JSON-RPC response to the iframe so the app SDK stops waiting.
   */
  const resolveToolCall = useCallback((toolCallId: string, result: unknown): void => {
    const responseId = responseIdMap.current.get(toolCallId);
    if (responseId !== undefined) {
      responseIdMap.current.delete(toolCallId);
      sendResponse(responseId, result);
    }
  }, [sendResponse]);

  /**
   * Reject a pending tools/call request from the app.
   * Called when the server responds via WS mcp-tool-error.
   */
  const rejectToolCall = useCallback((toolCallId: string, errorMessage: string): void => {
    const responseId = responseIdMap.current.get(toolCallId);
    if (responseId !== undefined) {
      responseIdMap.current.delete(toolCallId);
      sendError(responseId, -32000, errorMessage);
    }
  }, [sendError]);

  const pushToolCancelled = useCallback((toolCallId: string, reason?: string): void => {
    sendNotification('ui/notifications/tool-cancelled', {
      toolCallId,
      reason,
    });
  }, [sendNotification]);

  const pushHostContextChanged = useCallback((context: Record<string, unknown>): void => {
    sendNotification('ui/host_context_changed', { context });
  }, [sendNotification]);

  return {
    initialized,
    appSize,
    connectedResourceUri,
    handleMessage,
    pushToolInput,
    pushToolResult,
    sendToolResponse,
    resolveToolCall,
    rejectToolCall,
    pushToolCancelled,
    pushHostContextChanged,
    injectedJavaScript: BRIDGE_POLYFILL,
  };
}

/** Generate a pseudo-random UUID (RN-compatible, no crypto dependency) */
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
