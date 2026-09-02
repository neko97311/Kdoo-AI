import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import { getWsBaseUrl } from './session-service';
import { handleSessionExpired, refreshTokenIfNearExpiry } from './api';
import { logger } from '@/utils/logger';
import type { WsAttachPayload, WsChatPayload, WsServerEvent } from '@/types';

const LOG_SCOPE = 'ws';

const AUTH_STORAGE_KEY = 'auth_storage';

type EventHandler = (event: WsServerEvent) => void;

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 1000;

class WebSocketService {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private _isConnected = false;
  private appStateSubscription: { remove: () => void } | null = null;

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Listen for app foreground/background transitions.
   * On foreground: immediately reconnect if disconnected (skip backoff delay).
   */
  private setupAppStateListener(): void {
    if (this.appStateSubscription) return; // already listening
    this.appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        // App came to foreground — reconnect immediately if needed
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          // Cancel any pending backoff timer
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.reconnectAttempts = 0;
          this.connect();
        }
      }
    });
  }

  /**
   * Connect to WebSocket.
   * The auth token is sent via Cookie header (`user_token`) so the server
   * can extract it from the initial HTTP upgrade request.
   * On React Native, we pass headers via the 3rd constructor argument.
   * On Web, we set document.cookie (same-origin only).
   */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.shouldReconnect = true;

    // Proactive refresh: if the JWT is near expiry, swap it for a fresh one
    // before the server rejects us. This is a pure optimization — it never
    // gates the connection. Auth itself is always the server's decision: the
    // handshake carries whatever token we have (or none), and a server-side
    // rejection arrives as an UNAUTHORIZED frame that triggers handleSessionExpired.
    try {
      await refreshTokenIfNearExpiry();
    } catch (e) {
      console.warn('[WS] Token refresh pre-flight failed:', e);
    }

    if (!this.shouldReconnect) return;

    // Read auth token from storage
    let token: string | null = null;
    try {
      const stored = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        token = parsed.token || null;
      }
    } catch (e) {
      console.warn('[WS] Failed to read auth token:', e);
    }

    // Build URL — append token as query param so server can authenticate
    // the WS upgrade request (headers/cookies may not work on all platforms)
    let url = `${getWsBaseUrl()}/api/user/v1/workspace/gateway/ws`;
    if (token) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}user_token=${encodeURIComponent(token)}`;
    }

    try {
      if (token) {
        // Web: set cookie so the browser includes it in the WS upgrade request
        if (typeof document !== 'undefined') {
          document.cookie = `user_token=${token}; path=/;`;
        }
        // Mobile: React Native WebSocket supports headers in the 3rd argument
        // Server reads the JWT from the `user_token` cookie in the upgrade request
        this.ws = new (WebSocket as any)(url, ['access_token', token], {
          headers: { Cookie: `user_token=${token}` },
        }) as WebSocket;
      } else {
        this.ws = new WebSocket(url);
      }
    } catch (e) {
      logger.error(LOG_SCOPE, 'Failed to create WebSocket', { error: e instanceof Error ? e.message : String(e) });
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this._isConnected = true;
      this.reconnectAttempts = 0;
      this.setupAppStateListener();
      this.emit({ type: '__connected__' } as unknown as WsServerEvent);
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsServerEvent;

        // Detect WS auth failure — server sends {"type":"error","error":"UNAUTHORIZED"}
        // Handle the same way as API 401: clear session, redirect to login
        if (data.type === 'error' && (data as any).error === 'UNAUTHORIZED') {
          // Mark the trigger source so handleSessionExpired()'s stack capture
          // and any postmortem log reader can tell "WS kicked me out" from
          // "an API 401 kicked me out". Pairs with the warn in api.ts.
          logger.warn(LOG_SCOPE, 'Unauthorized — session expired (WS)');
          this.shouldReconnect = false;
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.disconnect();
          handleSessionExpired();
          return;
        }

        this.emit(data);
      } catch (e) {
        console.warn('[WS] Failed to parse message:', event.data, e);
      }
    };

    this.ws.onclose = (event) => {
      this._isConnected = false;
      this.ws = null;
      this.emit({ type: '__disconnected__' } as unknown as WsServerEvent);
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (_error) => {
      // WS error events fire when connection drops (e.g. app goes to background
      // for camera). This is expected — onclose will handle reconnection.
      // Use console.warn to avoid React Native LogBox red screen.
      console.warn('[WS] Connection error — will reconnect via onclose');
    };
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this._isConnected = false;
  }

  /**
   * Force-close the current WebSocket and immediately initiate a fresh
   * connection. Used by the stream-watchdog timeout path (chat.ts): when
   * no WS activity has been seen for 90s we assume the connection (or the
   * server-side stream) is dead. The caller (chat.ts) sends a `cancel`
   * frame BEFORE calling this so the server gets a best-effort stop
   * signal for the dying stream; dropping the socket here then ensures
   * any in-flight frames on the old TCP byte stream are discarded — the
   * new socket is a fresh stream with no possibility of stale tokens
   * leaking into the new stream's handlers.
   *
   * We set shouldReconnect=false BEFORE closing so the onclose handler
   * does NOT trigger scheduleReconnect (we are reconnecting synchronously
   * here, exponential backoff would just delay the new connection).
   * connect() re-arms shouldReconnect=true for the new socket.
   */
  reconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
    if (this.ws) {
      try {
        this.ws.close(4001, 'Client forced reconnect');
      } catch (e) {
        logger.warn(LOG_SCOPE, 'ws.close threw during reconnect', { error: e instanceof Error ? e.message : String(e) });
      }
      this.ws = null;
    }
    this._isConnected = false;
    // Initiate the new connection — fire-and-forget. Caller (watchdog)
    // proceeds to clear local stream state in parallel; the next
    // sendMessage will go through sendChat's own ready-check.
    this.connect().catch((e) => {
      logger.error(LOG_SCOPE, 'Reconnect failed', { error: e instanceof Error ? e.message : String(e) });
    });
  }

  /**
   * Send a chat message via WebSocket.
   *
   * If the connection is open, sends immediately.
   * If disconnected, attempts ONE reconnect before sending.
   * Returns true if the message was sent, false otherwise.
   */
  async sendChat(payload: WsChatPayload): Promise<boolean> {
    // Fast path: already connected
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }

    // Reconnect path: WS is down — attempt one reconnect
    console.log('[WS] sendChat: WS not connected, attempting reconnect');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;

    try {
      await this.connect();
    } catch {
      console.warn('[WS] sendChat: connect() threw');
      return false;
    }

    // connect() resolves after WS creation, but onopen hasn't fired yet.
    // Poll readyState until OPEN or timeout.
    const ready = await this.waitForReady(5000);
    if (ready && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      console.log('[WS] sendChat: sent after reconnect');
      return true;
    }

    console.warn('[WS] sendChat: reconnect failed — WS not ready');
    return false;
  }

  /**
   * Wait for the WebSocket to reach OPEN state.
   * Polls readyState every 100ms, resolves false on timeout or CLOSED.
   */
  private waitForReady(timeoutMs: number): Promise<boolean> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(true);
    if (!this.ws) return Promise.resolve(false);

    return new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) { settled = true; clearInterval(interval); resolve(false); }
      }, timeoutMs);

      const interval = setInterval(() => {
        if (settled) return;
        const state = this.ws?.readyState;
        if (state === WebSocket.OPEN) {
          settled = true;
          clearTimeout(timer);
          clearInterval(interval);
          resolve(true);
        } else if (state === WebSocket.CLOSED || !this.ws) {
          settled = true;
          clearTimeout(timer);
          clearInterval(interval);
          resolve(false);
        }
      }, 100);
    });
  }

  /**
   * Send an attach request to resume a streaming session after reconnect.
   *
   * The server replays buffered chunks from lastSequenceId onward and
   * responds with one of: attach-ack / attach-finished / attach-stale / attach-error.
   * The chat store registers handlers for those event types and processes
   * the replayed chunks (marked with replay:true) to fill in any gaps.
   *
   * Must only be called when WS is OPEN. Returns true if sent, false otherwise.
   */
  sendAttach(sessionId: string, lastSequenceId: number): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const payload: WsAttachPayload = { type: 'attach', sessionId, lastSequenceId };
    this.ws.send(JSON.stringify(payload));
    console.log(`[WS] sendAttach: sessionId=${sessionId.slice(0, 8)}, lastSeq=${lastSequenceId}`);
    return true;
  }

  /**
   * Cancel streaming for a session
   */
  cancelStream(sessionId: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: 'cancel', sessionId }));
    return true;
  }

  /**
   * Respond to tool approval request
   */
  respondToToolApproval(toolCallId: string, approved: boolean, runId: string, sessionId: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({
      type: approved ? 'approve-tool' : 'decline-tool',
      sessionId,
      runId,
      toolCallId,
      approved,
    }));
    return true;
  }

  /**
   * Send an MCP tool call from the host to the server.
   * Called when the MCP App (inside WebView) requests a tools/call via JSON-RPC.
   * The server proxies the call and responds via mcp-tool-result/mcp-tool-error WS events.
   */
  sendMcpToolCall(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    responseId: string | number,
  ): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({
      type: 'mcp-tool-call',
      sessionId,
      payload: {
        toolName,
        args,
        ...(toolCallId ? { toolCallId } : {}),
      },
    }));
    return true;
  }

  /**
   * Register event handler
   */
  on(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(eventType)?.delete(handler);
    };
  }

  /**
   * Remove event handler
   */
  off(eventType: string, handler: EventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  /**
   * Emit event to all registered handlers
   */
  private emit(event: WsServerEvent): void {
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(event);
        } catch (e) {
          logger.error(LOG_SCOPE, 'Handler error', { eventType: event.type, error: e instanceof Error ? e.message : String(e) });
        }
      });
    }

    // Also notify wildcard handlers
    const wildcardHandlers = this.handlers.get('*');
    if (wildcardHandlers) {
      wildcardHandlers.forEach((handler) => {
        try {
          handler(event);
        } catch (e) {
          logger.error(LOG_SCOPE, 'Wildcard handler error', { error: e instanceof Error ? e.message : String(e) });
        }
      });
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[WS] Max reconnect attempts reached');
      this.emit({ type: '__reconnect_failed__' } as unknown as WsServerEvent);
      return;
    }

    const delay = RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }
}

// Singleton instance
export const wsService = new WebSocketService();
