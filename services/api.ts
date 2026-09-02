import AsyncStorage from '@react-native-async-storage/async-storage';
import { decode as fromBase64 } from 'base-64';

import { buildServerHeaders } from '@/services/http-headers';
import { i18n } from '@/i18n';
import { logger } from '@/utils/logger';
import { useToastStore } from '@/stores/toast';

export const BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'https://api.example.com';

/** Scope tag for all logger entries emitted from this module. */
const LOG_SCOPE = 'api';

// ── Public error type ──
//
// Business errors (response.code !== '0000') and HTTP 4xx/5xx (non-401)
// surface as `ApiError` so callers can map `code`/`message` to UI feedback
// (form field error, submit banner). Network/timeout errors are still
// swallowed as `undefined` after a throttled toast — they have no useful
// per-call payload.
//
// Callers should use `instanceof ApiError` to distinguish recoverable
// business errors from unexpected runtime failures.
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    // Restore prototype chain across transpilers (TS -> ES5 target loses it)
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

// ── Network error toast (throttled) ──
// Avoids toast spam when many requests fail in quick succession (e.g. app
// cold-start firing 5+ calls while offline). Same-shape network errors within
// this window are suppressed; only the first surfaces to the user.
const NETWORK_TOAST_THROTTLE_MS = 5000;
let lastNetworkToastAt = 0;

function notifyNetworkError(): void {
  const now = Date.now();
  if (now - lastNetworkToastAt < NETWORK_TOAST_THROTTLE_MS) return;
  lastNetworkToastAt = now;
  useToastStore.getState().showToast({
    message: i18n.t('common.networkError'),
    variant: 'warning',
  });
}

// ── Logging helpers ──

/** ISO-8601 timestamp for log correlation across API/WS/UI events */
const ts = () => new Date().toISOString();

// ── Constants ──

const AUTH_STORAGE_KEY = 'auth_storage';
const REFRESH_THRESHOLD = 3600;
const REFRESH_ENDPOINT = '/api/user/v1/auth/refresh';

/**
 * Routes that should NOT trigger automatic token refresh / `ensureValidToken`.
 *
 * Skipping is required for two reasons:
 *  1. Login / register / social / verification endpoints are themselves
 *     token-issuing — there is no valid token yet (or the existing one is
 *     stale and the user is about to replace it). Any pre-flight refresh
 *     would either no-op, race with the login response, or hit the refresh
 *     endpoint with an expired refresh token the server has already
 *     invalidated (e.g. after a backend key-rotation).
 *  2. `auth/refresh` would cause an infinite refresh loop.
 *
 * `logout` is included because the user expects logout to always succeed
 * even when the access/refresh tokens are already invalid server-side.
 * `auth/check` is included because it is the cold-start validity probe —
 * running `ensureValidToken` before it would mask the very expiry we want
 * to detect.
 */
const AUTH_ROUTES = [
  '/api/user/v1/auth/refresh',
  '/api/user/v1/auth/login',
  '/api/user/v1/auth/register',
  '/api/user/v1/auth/forgot-password',
  '/api/user/v1/auth/reset-password',
  '/api/user/v1/auth/logout',
  '/api/user/v1/auth/check',
  '/api/user/v1/verification/send',
  '/api/user/v1/verification/verify',
  '/api/user/v1/google/login/app-login',
  '/api/user/v1/apple/login/app-login',
];

/**
 * Public routes that don't require (and shouldn't send) an access token.
 * Skips `ensureValidToken` and omits the Authorization header.
 * Use for endpoints explicitly intended to be anonymous — e.g. the public
 * app version check fired on cold start, which must never trigger a token
 * refresh as a side effect.
 */
const PUBLIC_ROUTES = [
  '/api/app/v1/version',
];

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface RequestOptions {
  headers?: Record<string, string>;
  body?: unknown;
  params?: Record<string, string>;
  /** Request timeout in ms. Default 10000 (10s). Set to 0 to disable. */
  timeoutMs?: number;
  /** Internal: marks that a request has already been retried after refresh */
  _retried?: boolean;
}

// ── Session expired handling (breaks circular dependency with stores/auth) ──

let sessionExpiredHandling = false;
let sessionExpiredCallback: (() => void) | null = null;

/**
 * Logout flag — set to true by auth store's logout(), reset to false on
 * successful login. When true, the API layer suppresses all session-expired
 * side effects (toast, token refresh attempts) because the missing
 * token is expected, not an expiry.
 *
 * This prevents the "Session Expired" toast from firing right after the
 * user intentionally logs out (e.g. switching accounts), where in-flight
 * or post-logout requests hit 401 with no refresh token available.
 */
let loggedOut = false;

export function setSessionExpiredHandler(fn: () => void): void {
  sessionExpiredCallback = fn;
}

export function resetSessionExpiredGuard(): void {
  sessionExpiredHandling = false;
}

/**
 * Mark the auth state as logged-out so the API layer can distinguish
 * "user intentionally logged out" (no popup) from "session expired
 * server-side" (popup). Call with `false` on successful login.
 */
export function setLoggedOutFlag(value: boolean): void {
  loggedOut = value;
}

export async function handleSessionExpired(): Promise<void> {
  // User logged out intentionally — never show the session-expired popup.
  if (loggedOut) return;
  if (sessionExpiredHandling) return;

  // Capture the immediate caller so logs distinguish "API 401" vs "WS
  // UNAUTHORIZED frame" vs "refresh failure". Stack is captured before
  // sessionExpiredHandling flips so the first frame is the real caller, not
  // this function. Truncated to 3 frames to keep the JSONL entry small.
  const stack = new Error().stack ?? '';
  const triggerFrames = stack
    .split('\n')
    .slice(2, 5)
    .map((line) => line.trim())
    .filter(Boolean);
  logger.warn(LOG_SCOPE, 'Session expired — triggering login flow', {
    trigger: triggerFrames.join(' | ') || 'unknown',
  });

  sessionExpiredHandling = true;

  await AsyncStorage.removeItem(AUTH_STORAGE_KEY);
  try {
    sessionExpiredCallback?.();
  } catch (e) {
    logger.error(LOG_SCOPE, 'Session expired callback threw', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  useToastStore.getState().showToast({
    message: i18n.t('common.sessionExpired'),
    variant: 'warning',
    durationMs: 4000,
  });
}

// ── JWT utilities ──

/** Custom error to signal token expiry (HTTP 401 or AUTHENTICATION_ERROR) */
class TokenExpiredError extends Error {
  constructor() {
    super('Token expired');
    this.name = 'TokenExpiredError';
  }
}

/** Check if a path is an auth route that should skip auto-refresh */
function isAuthRoute(path: string): boolean {
  // 边界匹配：仅精确命中或命中带 `/` 的合法子路径。
  // 不能裸用 startsWith(route) —— 否则 /api/user/v1/auth/login-methods
  // 会被 /api/user/v1/auth/login 误判为 auth route，跳过 token 刷新与
  // 过期重试，导致 token 失效时查询静默返回空列表（见 login-methods.tsx）。
  return AUTH_ROUTES.some(
    route => path === route || path.startsWith(`${route}/`)
  );
}

/** Check if a path is a public route that should skip token attach + refresh */
function isPublicRoute(path: string): boolean {
  // 与 isAuthRoute 同理：仅精确命中或命中带 `/` 的合法子路径，
  // 避免前缀误将 /api/app/v1/version-xxx 判为公共路由。
  return PUBLIC_ROUTES.some(
    route => path === route || path.startsWith(`${route}/`)
  );
}

/** Decode JWT payload (base64url → JSON), no signature verification needed on client */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // JWT uses base64url encoding — convert to standard base64
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // Add padding
    while (b64.length % 4) b64 += '=';
    const json = fromBase64(b64);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Calculate remaining lifetime of an access token in seconds */
function getTokenRemainingTime(token: string): number {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return 0;
  return (payload.exp as number) - Math.floor(Date.now() / 1000);
}

// ── Token storage helpers ──

interface StoredAuth {
  token?: string;
  refreshToken?: string;
  user?: unknown;
}

/** Read both tokens from AsyncStorage */
async function getStoredTokens(): Promise<{ accessToken: string | null; refreshToken: string | null }> {
  const stored = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
  if (stored) {
    const parsed: StoredAuth = JSON.parse(stored);
    return {
      accessToken: parsed.token ?? null,
      refreshToken: parsed.refreshToken ?? null,
    };
  }
  return { accessToken: null, refreshToken: null };
}

/** Save new tokens to AsyncStorage, preserving existing user data */
async function saveTokens(accessToken: string, refreshToken: string): Promise<void> {
  const stored = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
  const parsed: StoredAuth = stored ? JSON.parse(stored) : {};
  parsed.token = accessToken;
  parsed.refreshToken = refreshToken;
  await AsyncStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(parsed));
}

/** Read access token for Authorization header */
export async function getToken(): Promise<string | null> {
  const { accessToken } = await getStoredTokens();
  return accessToken;
}

// ── Token refresh (with concurrent deduplication) ──

let refreshPromise: Promise<boolean> | null = null;

/** Actual refresh implementation — calls refresh endpoint with raw fetch */
async function doRefresh(): Promise<boolean> {
  // User logged out — no point attempting a refresh, and we must NOT
  // trigger handleSessionExpired (which would pop the toast).
  if (loggedOut) {
    logger.debug('API', `[${ts()}] Skip token refresh — user logged out`);
    return false;
  }

  const { refreshToken } = await getStoredTokens();
  if (!refreshToken) {
    await handleSessionExpired();
    return false;
  }

  try {
    const response = await fetch(`${BASE_URL}${REFRESH_ENDPOINT}`, {
      method: 'POST',
      headers: buildServerHeaders(null, {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }),
      body: JSON.stringify({ refreshToken }),
    });

    const text = await response.text();
    const json = JSON.parse(text);

    if (json.code === '0000' && json.data?.tokens) {
      const { accessToken, refreshToken: newRefreshToken } = json.data.tokens;
      await saveTokens(accessToken, newRefreshToken);
      logger.info('API', `[${ts()}] Token refresh successful`);
      return true;
    }

    // Refresh failed (code 3000 = refresh token invalid/expired, or other error)
    logger.warn('API', `[${ts()}] Token refresh failed`, { code: json.code, message: json.message });
    await handleSessionExpired();
    return false;
  } catch (e) {
    logger.warn('API', `[${ts()}] Token refresh network error`, e);
    await handleSessionExpired();
    return false;
  }
}

/**
 * Refresh the access token. If a refresh is already in progress,
 * returns the same promise (concurrent deduplication).
 */
export function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = doRefresh().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

// ── Pre-request token check ──

/**
 * Refresh the access token if it is missing or expires within
 * REFRESH_THRESHOLD. Returns true if a refresh was performed (or was
 * already in flight), false if the current token is still healthy.
 *
 * This is the underlying primitive used by `ensureValidToken` (API path)
 * and by the WebSocket pre-flight in `services/websocket.ts`. Callers that
 * need route-aware skipping (e.g. auth endpoints) should use
 * `ensureValidToken` instead.
 */
export async function refreshTokenIfNearExpiry(): Promise<boolean> {
  const { accessToken } = await getStoredTokens();
  if (!accessToken) return false;

  const remaining = getTokenRemainingTime(accessToken);
  if (remaining > REFRESH_THRESHOLD) return false;

  logger.debug('API', `[${ts()}] Token expiring soon, refreshing`);
  // NOTE: refreshAccessToken() already handles failures internally by calling
  // handleSessionExpired() (which clears AsyncStorage and pops the toast) and
  // returning false. We deliberately discard that signal here and always return
  // true, because both current callers (ensureValidToken, websocket pre-flight)
  // are fire-and-forget: they trust handleSessionExpired to surface the failure
  // to the user and AsyncStorage to reflect the cleared session. If a future
  // caller needs to distinguish "refresh attempted" from "refresh succeeded",
  // it should call refreshAccessToken() directly instead.
  await refreshAccessToken();
  return true;
}

/**
 * Check token validity before sending a request.
 * If the token expires within REFRESH_THRESHOLD, refresh it first.
 * Skipped for auth routes (login, register, refresh).
 */
export async function ensureValidToken(path: string): Promise<void> {
  if (isAuthRoute(path)) return;
  if (isPublicRoute(path)) return;

  await refreshTokenIfNearExpiry();
}

// ── Core request function ──

function buildCurl(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown
): string {
  const headerParts = Object.entries(headers)
    .map(([k, v]) => `  -H '${k}: ${v}'`)
    .join(' \\\n');
  const bodyPart = body ? ` \\\n  --data '${JSON.stringify(body)}'` : '';
  return `curl -X ${method} '${url}' \\\n${headerParts}${bodyPart}`;
}

/**
 * Execute a single HTTP request (no retry logic).
 * Throws TokenExpiredError on 401 or AUTHENTICATION_ERROR.
 */
async function executeRequest<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const token = isPublicRoute(path) ? null : await getToken();

  const headers = buildServerHeaders(token, {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...options.headers,
  });

  // Build URL with query params
  let url = `${BASE_URL}${path}`;
  if (options.params && Object.keys(options.params).length > 0) {
    const searchParams = new URLSearchParams(options.params);
    url += `?${searchParams.toString()}`;
  }

  logger.info('API', `[${ts()}] REQ ${method} ${url}`);

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 10000;
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (e: any) {
    // 三类 fetch 失败要分开处理，否则会把"请求被取消"误报成网络错误。
    //
    // 关键事实：controller 是本函数局部变量，只有上面的 timeout timer 能
    // 调 controller.abort()。框架/native 层（导航离开页面时取消 in-flight
    // 请求）拿不到这个 signal，只能让 fetch promise reject，error.message
    // 形如 "fetch failed: Fetch request has been canceled"，但 controller.
    // signal.aborted 仍是 false。
    //
    // 所以：
    //   aborted === true         → 我们的 timer 触发了 abort（请求超时）
    //   aborted === false + canceled message → 框架/native 取消（非错误）
    //   其他                     → 真网络错误
    //
    // RN/undici 的 abort error 的 e.name 不是 'AbortError'，所以旧代码的
    // `e?.name === 'AbortError'` 判断在 RN 上永远不成立，导致超时和取消都
    // 被误归到 "Network error" 分支 + 弹网络错误 toast。
    const elapsedMs = Date.now() - startedAt;
    const aborted = controller.signal.aborted;
    const errorMsg = e?.message ?? String(e);
    const diag = {
      elapsedMs,
      aborted,
      errorName: e?.name,
      errorMsg,
    };

    if (aborted) {
      // 我们的 AbortController 触发了 abort —— 即 timeout（默认 10s）。
      logger.warn(LOG_SCOPE, 'Request timeout', {
        method,
        url,
        timeoutMs,
        ...diag,
      });
      notifyNetworkError();
      return undefined as unknown as T;
    }

    if (/cancel/i.test(errorMsg) || e?.name === 'AbortError') {
      // 非 our-timer 的取消 —— 框架/native 层在导航离开等场景取消 in-flight
      // 请求。这不是网络故障，静默处理，不弹网络错误 toast，避免误导用户。
      logger.info(LOG_SCOPE, 'Request canceled', {
        method,
        url,
        ...diag,
      });
      return undefined as unknown as T;
    }

    logger.error(LOG_SCOPE, 'Network error', {
      method,
      url,
      ...diag,
    });
    notifyNetworkError();
    return undefined as unknown as T;
  } finally {
    if (timer) clearTimeout(timer);
  }

  logger.info('API', `[${ts()}] RES ${method} ${url} ${response.status}`);

  // HTTP 401 — token expired
  if (response.status === 401) {
    logger.warn('API', `[${ts()}] 401 Token expired → will retry after refresh ${method} ${url}`);
    logger.debug('API', `[${ts()}] CURL for debugging:\n`, buildCurl(method, url, headers, options.body));
    throw new TokenExpiredError();
  }

  if (!response.ok) {
    const text = await response.text();
    logger.error(LOG_SCOPE, 'HTTP error', {
      method,
      url,
      status: response.status,
      statusText: response.statusText,
      body: text.slice(0, 500),
    });

    // Parse server error body and surface as ApiError so callers can map
    // code/message to UI. Falls back to HTTP status text when body is not
    // JSON or missing `message`/`code` fields.
    let serverMessage = response.statusText || `HTTP ${response.status}`;
    let serverCode = `HTTP_${response.status}`;
    try {
      const errorJson = JSON.parse(text);
      if (errorJson && typeof errorJson === 'object') {
        if (typeof errorJson.message === 'string' && errorJson.message) {
          serverMessage = errorJson.message;
        }
        if (typeof errorJson.code === 'string' && errorJson.code) {
          serverCode = errorJson.code;
        }
        if (errorJson.message) {
          logger.error(LOG_SCOPE, 'Server error message', {
            method,
            url,
            status: response.status,
            message: errorJson.message,
            code: errorJson.code ?? null,
          });
        }
      }
    } catch (parseError) {
      if (!(parseError instanceof SyntaxError)) {
        logger.error(LOG_SCOPE, 'Unexpected parse error on non-ok response', {
          method,
          url,
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
      }
    }

    throw new ApiError(serverCode, serverMessage, response.status);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    logger.info('API', `[${ts()}] OK (204) ${method} ${url}`);
    return undefined as unknown as T;
  }

  const text = await response.text();

  // Handle empty body (200 OK with no content)
  if (!text.trim()) {
    return undefined as unknown as T;
  }

  try {
    const json = JSON.parse(text);
    logger.info('API', `[${ts()}] OK ${method} ${url}`, text.slice(0, 200));

    if (json.code === '0000' && json.data !== undefined) {
      return json.data as T;
    }

    if (json.code && json.code !== '0000') {
      // Authentication errors from backend (200 + error code)
      if (json.type === 'AUTHENTICATION_ERROR') {
        logger.warn('API', `[${ts()}] AUTHENTICATION_ERROR ${method} ${url}`);
        logger.debug('API', `[${ts()}] CURL for debugging:\n`, buildCurl(method, url, headers, options.body));
        throw new TokenExpiredError();
      }
      logger.error(LOG_SCOPE, 'Business error code', {
        method,
        url,
        code: json.code,
        message: json.message ?? null,
        type: json.type ?? null,
      });
      // Surface business error to caller so forms can display the message.
      // message falls back to a generic string if backend omits it.
      const bizMessage =
        typeof json.message === 'string' && json.message
          ? json.message
          : `Error ${json.code}`;
      throw new ApiError(json.code, bizMessage, response.status);
    }

    return json as T;
  } catch (e: any) {
    if (e instanceof SyntaxError) {
      logger.error(LOG_SCOPE, 'Unexpected response (non-JSON or malformed)', {
        method,
        url,
        status: response.status,
        firstCharCode: text.charCodeAt(0),
        rawHead: text.slice(0, 200),
        fullBodyLen: text.length,
      });
      return undefined as unknown as T;
    }
    // TokenExpiredError propagates upward to drive the refresh+retry flow.
    // ApiError propagates upward so callers (forms) can surface the message.
    if (e instanceof TokenExpiredError) throw e;
    if (e instanceof ApiError) throw e;
    // Any other internal error is logged and swallowed as undefined so the
    // caller never sees a thrown exception from the API layer.
    logger.error(LOG_SCOPE, 'Unexpected error during response parsing', {
      method,
      url,
      error: e?.message ?? String(e),
    });
    return undefined as unknown as T;
  }
}

/**
 * Unified API request function.
 * Handles:
 * - Pre-request token check (ensureValidToken)
 * - Auto-attach Bearer token
 * - URL query params
 * - Unwrap `{ code: "0000", data: T }` response format
 * - 401 / AUTHENTICATION_ERROR → refresh token and retry once
 */

async function request<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  try {
    await ensureValidToken(path);
    return await executeRequest<T>(method, path, options);
  } catch (error) {
    if (
      error instanceof TokenExpiredError &&
      !isAuthRoute(path) &&
      !options._retried
    ) {
      logger.info('API', `[${ts()}] Retrying after token refresh: ${method} ${path}`);
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        return await executeRequest<T>(method, path, { ...options, _retried: true });
      }
    }
    if (error instanceof TokenExpiredError) return undefined as unknown as T;
    // ApiError (business / HTTP 4xx-5xx) propagates so forms can display
    // the message. Only network/timeout/parse errors are swallowed above.
    if (error instanceof ApiError) throw error;
    // executeRequest already converts all user-facing errors to logged
    // undefined returns, so reaching here is unexpected — log and swallow
    // the final safety net so no error escapes the API layer.
    logger.error(LOG_SCOPE, 'Unexpected error escaped executeRequest', {
      method,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined as unknown as T;
  }
}

export interface MultipartFile {
  uri: string;
  name: string;
  type: string;
}

export interface MultipartOptions {
  headers?: Record<string, string>;
  _retried?: boolean;
}

async function postMultipart<T>(
  path: string,
  // Expo's fetch FormData pipeline accepts anything whose `'bytes' in entry`
  // is true, plus the legacy { uri, name, type } shape that react-native core
  // used to accept. We accept a wide union so callers can pick the cheapest
  // representation for their data source.
  file: { bytes(): Promise<Uint8Array> } | Blob | MultipartFile,
  fields: Record<string, string> = {},
  options: MultipartOptions = {},
): Promise<T> {
  try {
    await ensureValidToken(path);

    const token = isPublicRoute(path) ? null : await getToken();
    const headers = buildServerHeaders(token, options.headers);

    const formData = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      formData.append(k, v);
    }
    formData.append('file', file as any);

    const url = `${BASE_URL}${path}`;
    logger.info('API', `[${ts()}] REQ MULTIPART POST ${url}`);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: formData,
      });
    } catch (e: any) {
      logger.error(LOG_SCOPE, 'Multipart network error', {
        url,
        error: e?.message ?? String(e),
      });
      notifyNetworkError();
      return undefined as unknown as T;
    }

    logger.info('API', `[${ts()}] RES MULTIPART ${url} ${response.status}`);

    if (response.status === 401) {
      throw new TokenExpiredError();
    }

    if (!response.ok) {
      const text = await response.text();
      logger.error(LOG_SCOPE, 'Multipart HTTP error', {
        url,
        status: response.status,
        statusText: response.statusText,
        body: text.slice(0, 500),
      });
      // Surface HTTP error as ApiError; parse body for server message/code.
      let serverMessage = response.statusText || `HTTP ${response.status}`;
      let serverCode = `HTTP_${response.status}`;
      try {
        const errorJson = JSON.parse(text);
        if (errorJson && typeof errorJson === 'object') {
          if (typeof errorJson.message === 'string' && errorJson.message) {
            serverMessage = errorJson.message;
          }
          if (typeof errorJson.code === 'string' && errorJson.code) {
            serverCode = errorJson.code;
          }
        }
      } catch {
        // Non-JSON body — fall back to status text
      }
      throw new ApiError(serverCode, serverMessage, response.status);
    }

    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch (e) {
      if (e instanceof SyntaxError) {
        logger.error(LOG_SCOPE, 'Multipart unexpected response (non-JSON or malformed)', {
          url,
          status: response.status,
          firstCharCode: text.charCodeAt(0),
          rawHead: text.slice(0, 200),
          fullBodyLen: text.length,
        });
        return undefined as unknown as T;
      }
      logger.error(LOG_SCOPE, 'Multipart unexpected parse error', {
        url,
        error: e instanceof Error ? e.message : String(e),
      });
      return undefined as unknown as T;
    }

    if (json.code && json.code !== '0000') {
      logger.error(LOG_SCOPE, 'Multipart business error code', {
        url,
        code: json.code,
        message: json.message ?? null,
      });
      const bizMessage =
        typeof json.message === 'string' && json.message
          ? json.message
          : `Error ${json.code}`;
      throw new ApiError(json.code, bizMessage, response.status);
    }

    return (json.data ?? json) as T;
  } catch (error) {
    if (error instanceof TokenExpiredError && !options._retried) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        return postMultipart<T>(path, file, fields, { ...options, _retried: true });
      }
      return undefined as unknown as T;
    }
    // TokenExpiredError that has already been retried propagates as undefined.
    if (error instanceof TokenExpiredError) {
      return undefined as unknown as T;
    }
    // ApiError (business / HTTP 4xx-5xx) propagates to callers for UI feedback.
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error(LOG_SCOPE, 'Multipart unexpected error', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined as unknown as T;
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, options),
  postMultipart: <T>(
    path: string,
    file: { bytes(): Promise<Uint8Array> } | Blob | MultipartFile,
    fields?: Record<string, string>,
  ) => postMultipart<T>(path, file, fields),
  raw: {
    get: <T>(path: string, options?: RequestOptions): Promise<T> =>
      request<T>('GET', path, options).then((r) => r as unknown as T),
    post: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
      request<T>('POST', path, { ...options, body }).then((r) => r as unknown as T),
    put: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
      request<T>('PUT', path, { ...options, body }).then((r) => r as unknown as T),
    delete: <T>(path: string, options?: RequestOptions): Promise<T> =>
      request<T>('DELETE', path, options).then((r) => r as unknown as T),
  },
};
