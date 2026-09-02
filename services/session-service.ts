import { api, BASE_URL } from './api';
import type { ApiSession, ApiAgent, ApiMessage, PaginatedData, Agent, MessagesResponse, McpAppState } from '@/types';
import type { ChatSession } from '@/types';

/**
 * Load sessions from API and convert to ChatSession[]
 */
export async function loadSessionsFromApi(): Promise<ChatSession[]> {
  const data = await api.get<PaginatedData<ApiSession>>('/api/user/v1/sessions?pageSize=100');
  const items = data?.items ?? [];
  return items.map(apiSessionToChatSession);
}

/**
 * Create a new session via API
 */
export async function createSessionApi(params: { agentId: string; name?: string }): Promise<ChatSession> {
  const data = await api.post<ApiSession>('/api/user/v1/sessions', params);
  return apiSessionToChatSession(data);
}

/**
 * Update a session via API
 */
export async function updateSessionApi(
  sessionId: string,
  params: { name?: string; agentId?: string; isPinned?: boolean }
): Promise<ChatSession> {
  const data = await api.put<ApiSession>(`/api/user/v1/sessions/${sessionId}`, params);
  return apiSessionToChatSession(data);
}

/**
 * Delete a session via API
 */
export async function deleteSessionApi(sessionId: string): Promise<void> {
  await api.delete(`/api/user/v1/sessions/${sessionId}`);
}

/** Response of the share-creation endpoint. */
interface CreateSessionShareResponse {
  /** Share token — used to build the share page URL `/share/{shareToken}` */
  shareToken?: string;
  /** Full share URL; takes precedence over `shareToken` when the backend returns it */
  url?: string;
}

/**
 * Create a share link for a session.
 *
 * Backend route: POST /api/user/v1/sessions/:id/shares
 * Body: { title?: string (≤200), locale?: string } — the shared
 * conversation's display title and the request's current language
 * (so the public share page can render in the sharer's locale).
 * The public share page is served at `{origin}/share/{shareToken}`.
 *
 * @returns The full share URL.
 * @throws When the request fails or the response carries neither url nor shareToken.
 */
export async function createSessionShare(
  sessionId: string,
  title?: string,
  locale?: string,
): Promise<string> {
  const data = await api.post<CreateSessionShareResponse>(
    `/api/user/v1/sessions/${sessionId}/shares`,
    {
      ...(title ? { title: title.slice(0, 200) } : {}),
      ...(locale ? { locale } : {}),
    },
  );
  if (data?.url) return data.url;
  if (data?.shareToken) return `${BASE_URL}/share/${data.shareToken}`;
  throw new Error('createSessionShare: response missing url/shareToken');
}

/**
 * Response of the share-fork endpoint.
 *
 * NOTE: the backend returns a different shape than `ApiSession` — only
 * `sessionId` and `sessionKey` (no `name`, no `updatedAt`, no `id`).
 * We construct a synthetic `ChatSession` with sensible defaults because
 * callers need a session object they can `addSession()` into the store.
 */
interface ForkSessionResponse {
  /** The new forked session's id (UUID). */
  sessionId: string;
  /** Opaque session key used for subsequent API calls on the forked session. */
  sessionKey: string;
}

/**
 * Response of the share-detail endpoint (public, no auth required).
 *
 * Used by the deep-link intake to render the share's title / agent before
 * the user forks it. The schema mirrors the `data` object returned by
 * `GET /api/share/{token}`.
 */
export interface ApiShareMeta {
  /** Internal id of the share record (different from shareToken). */
  id: string;
  /** Token embedded in the share URL. */
  shareToken: string;
  /** Display title of the original shared session. */
  title: string;
  /** Agent id the original session was created with. */
  agentId: string;
  /** Share status (e.g. ACTIVE / REVOKED). */
  status: string;
  /** ISO timestamp of when the share was created. */
  createdAt: string;
  /** Number of times the share page has been viewed. */
  viewCount: number;
  /** Number of times the share has been forked into a new session. */
  forkCount: number;
}

/**
 * Fetch the public metadata for a share token.
 *
 * Backend route: GET /api/share/{token}
 *   Returns `{ code, message, data: ApiShareMeta, timestamp }`.
 *   No auth required — this is what the share page loads in the browser
 *   before the user clicks "Open in app".
 *
 * Used by the deep-link intake to copy the original session's title
 * onto the forked session (the fork endpoint doesn't echo the title
 * back, so we have to look it up here).
 *
 * @throws When the request fails or the response is malformed.
 */
export async function getShareMetaApi(token: string): Promise<ApiShareMeta> {
  const data = await api.get<ApiShareMeta>(
    `/api/share/${encodeURIComponent(token)}`,
  );
  if (!data || !data.shareToken || !data.title) {
    throw new Error(`getShareMetaApi: malformed response for token=${token}`);
  }
  return data;
}

/**
 * Fork a shared conversation into the current user's account as a new
 * session. Used by the `/share/[id]` deep-link intake page after a
 * browser → app handoff.
 *
 * Backend route: POST /api/share/:token/fork
 *   :token — the share id emitted by `createSessionShare` (the same
 *            value embedded in the `kdoomobile://share/{id}` link).
 *   body   — { title?: string (≤200) } optional new session title.
 *
 * The backend's response carries `{ sessionId, sessionKey }` — not a
 * full `ApiSession` — so we synthesise a `ChatSession` here. `id`
 * comes from `sessionId`; the backend does not provide a title or
 * `updatedAt`, so we use the caller-supplied `title`, then fall back
 * to fetching the original share's title via `GET /api/share/:token`,
 * then fall back to `'New chat'`. `updatedAt` is set to `new Date()`
 * since the backend does not echo it back.
 *
 * @returns The newly forked session as a `ChatSession` ready to be
 *          added to the chat store via `addSession()`.
 * @throws When the fork request fails (e.g. share not found / forbidden).
 *         The share-metadata prefetch is best-effort: if it fails (network
 *         error, share already revoked, etc.) we still attempt the fork
 *         with the generic fallback title.
 */
export async function forkShareApi(
  token: string,
  title?: string,
): Promise<ChatSession> {
  // Resolve the title in three steps: explicit > original share title > generic.
  let resolvedTitle: string | undefined = title;
  if (!resolvedTitle) {
    try {
      const meta = await getShareMetaApi(token);
      resolvedTitle = meta.title;
    } catch {
      // Best-effort: fall through to the generic default.
      resolvedTitle = undefined;
    }
  }

  const data = await api.post<ForkSessionResponse>(
    `/api/share/${encodeURIComponent(token)}/fork`,
    resolvedTitle ? { title: resolvedTitle.slice(0, 200) } : {},
  );
  return {
    id: data.sessionId,
    title: resolvedTitle || 'New chat',
    updatedAt: new Date(),
    isPinned: false,
  };
}

/**
 * Load agents from API
 */
export async function loadAgentsFromApi(): Promise<Agent[]> {
  const data = await api.get<ApiAgent[]>('/api/user/v1/agents?containSystem=false');
  return (data ?? []).map(apiAgentToAgent);
}

/**
 * Load messages for a session
 */
export async function getSessionMessages(
  sessionId: string,
  cursor?: string
): Promise<MessagesResponse> {
  let path = `/api/user/v1/sessions/${sessionId}/messages?pageSize=50`;
  if (cursor) {
    path += `&cursor=${encodeURIComponent(cursor)}`;
  }
  return api.get<MessagesResponse>(path);
}

/**
 * Get the WebSocket base URL from the API URL
 */
export function getWsBaseUrl(): string {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL || 'https://api.example.com';
  return apiUrl.replace(/^http/, 'ws');
}

/**
 * Compute calculator result from raw input state.
 * Mirrors the backend calculator-mcp.ts execute() logic.
 */
function computeCalculatorState(
  num1: number,
  num2: number,
  operation: string,
): { result: number; symbol: string } | null {
  switch (operation) {
    case 'add':
      return { result: num1 + num2, symbol: '+' };
    case 'subtract':
      return { result: num1 - num2, symbol: '-' };
    case 'multiply':
      return { result: num1 * num2, symbol: '\u00d7' };
    case 'divide':
      if (num2 === 0) return null;
      return { result: num1 / num2, symbol: '\u00f7' };
    default:
      return null;
  }
}

/**
 * Fetch MCP app state for hydration (initial tool input/result from DB).
 * Called when restoring an MCP interactive tool from message history.
 *
 * The backend stores raw calculator input as { num1, num2, operation }.
 * We compute the result on the client side and construct the full
 * McpAppState { toolInput, toolResult } expected by the bridge.
 */
export async function fetchMcpAppState(
  uri: string,
  sessionId: string,
  toolCallId?: string,
): Promise<McpAppState | null> {
  try {
    const params: Record<string, string> = { uri, sessionId };
    if (toolCallId) params.toolCallId = toolCallId;
    const response = await api.get<{ uri: string; state: Record<string, unknown> | null }>(
      '/api/user/v1/mcp/apps/state',
      { params },
    );
    const raw = response?.state;
    if (!raw) return null;

    // Calculator raw state: { num1, num2, operation }
    if (typeof raw.num1 === 'number' && typeof raw.num2 === 'number' && typeof raw.operation === 'string') {
      const computed = computeCalculatorState(raw.num1, raw.num2, raw.operation);
      if (!computed) return null;
      const toolName = 'calculatorWithUI';
      return {
        toolInput: { toolName, input: { num1: raw.num1, num2: raw.num2, operation: raw.operation } },
        toolResult: {
          toolName,
          result: {
            content: [
              {
                type: 'text',
                text: `${raw.num1} ${computed.symbol} ${raw.num2} = ${computed.result}`,
              },
            ],
            structuredContent: {
              result: computed.result,
              expression: `${raw.num1} ${computed.symbol} ${raw.num2} = ${computed.result}`,
              resourceUri: uri,
            },
          },
        },
      };
    }

    // Already in McpAppState format (future-proof fallback)
    if (raw.toolInput || raw.toolResult) {
      return raw as unknown as McpAppState;
    }

    return null;
  } catch (e: any) {
    console.warn('[MCP] Failed to fetch app state:', e?.message);
    return null;
  }
}

// ── Map origin cache types ──
// Extended payload persisted under resourceId "ui://googlemap/origin".
// Coordinate-only origins remain valid; address and nearbyResult are
// optional enrichments used to skip redundant Google API calls.

/** A single cached POI from nearby search. */
export interface CachedPoi {
  lat: number;
  lng: number;
  name?: string;
  address?: string;
  /** Legacy distance label (kept for compatibility). */
  distance?: number;
  rating?: number | null;
  /** Photo thumbnail URL (Google getUrl / AMap image). */
  photo?: string | null;
  /** Human-readable category label (e.g. "Restaurant"). */
  category?: string;
  /** Google price level 1-4 (optional). */
  priceLevel?: number | null;
  /** Open-now status (true/false/null=unknown). */
  openNow?: boolean | null;
  /** Distance from the anchor in meters (computed client-side). */
  distanceMeters?: number | null;
}

/** Cached nearby-search result. `pois` holds the full result set. */
export interface CachedNearbyResult {
  count: number;
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
  pois: CachedPoi[];
  /** Diagnostics-only timestamp of when the search ran (permanent cache). */
  searchedAt: number;
}

/** Persisted map origin with optional cached address and nearby results. */
export interface MapOriginState {
  lat: number;
  lng: number;
  address?: string;
  /** Diagnostics-only timestamp of when address was resolved (permanent cache). */
  resolvedAt?: number;
  nearbyResult?: CachedNearbyResult;
}

// Cache policy: PERMANENT (no TTL).
//
// "My Location" is treated as a pinned anchor (home/office) — once captured
// it should NOT refresh on subsequent opens. Reopening the message must read
// from DB and skip Google Geocoder / Places calls entirely.
//
// To force a refresh: clear the chat session's stored origin (DB row).
//
// The legacy TTL constants (24h / 7d) are intentionally removed per user
// decision. The `resolvedAt` / `searchedAt` fields are still written for
// diagnostics/auditing but are no longer consulted by the freshness checks.

/** Returns true if the cached address is present. Permanent cache. */
export function isAddressFresh(state: MapOriginState): boolean {
  return !!state.address;
}

/** Returns true if the cached nearby result is present. Permanent cache. */
export function isNearbyFresh(state: MapOriginState): boolean {
  return !!state.nearbyResult && Array.isArray(state.nearbyResult.pois);
}

/**
 * Fetch the persisted map origin for a specific (sessionId, toolCallId).
 *
 * Uses the generic MCP app state API — identical to how the calculator
 * reads its state. The origin is stored under resourceId
 * "ui://googlemap/origin" with the REAL sessionId and toolCallId from
 * the AI tool call (not synthesized user/default keys).
 *
 * Returns the full cached state including optional address and
 * nearbyResult fields so callers can short-circuit Google API calls.
 *
 * Backend route: GET /api/user/v1/mcp/apps/state?uri=ui://googlemap/origin&...
 */
export async function fetchMapOrigin(
  sessionId: string,
  toolCallId: string,
): Promise<MapOriginState | null> {
  try {
    const response = await api.get<{ uri: string; state: Record<string, unknown> | null }>(
      '/api/user/v1/mcp/apps/state',
      { params: { uri: 'ui://googlemap/origin', sessionId, toolCallId } },
    );
    const raw = response?.state;
    if (!raw) return null;
    if (typeof raw.lat !== 'number' || typeof raw.lng !== 'number') return null;
    const result: MapOriginState = { lat: raw.lat, lng: raw.lng };
    if (typeof raw.address === 'string' && raw.address) result.address = raw.address;
    if (typeof raw.resolvedAt === 'number') result.resolvedAt = raw.resolvedAt;
    if (raw.nearbyResult && typeof raw.nearbyResult === 'object') {
      const nr = raw.nearbyResult as Record<string, unknown>;
      if (typeof nr.searchedAt === 'number' && Array.isArray(nr.pois)) {
        result.nearbyResult = {
          count: typeof nr.count === 'number' ? nr.count : (nr.pois as unknown[]).length,
          firstPoi:
            nr.firstPoi && typeof nr.firstPoi === 'object'
              ? (nr.firstPoi as { lat: number; lng: number; name?: string })
              : undefined,
          pois: (nr.pois as CachedPoi[]).filter(
            (p) => typeof p?.lat === 'number' && typeof p?.lng === 'number',
          ),
          searchedAt: nr.searchedAt,
        };
      }
    }
    return result;
  } catch (e: any) {
    console.warn('[MCP] Failed to fetch map origin:', e?.message);
    return null;
  }
}

/**
 * Persist the map origin for a specific (sessionId, toolCallId).
 *
 * Uses the generic MCP app state PUT endpoint — the same API surface
 * as all other MCP app state writes.
 *
 * Accepts either a plain { lat, lng } (legacy callers) or the full
 * MapOriginState with cached address / nearbyResult. The PUT body is
 * always the full state object so subsequent reads can hit the cache.
 *
 * Backend route: PUT /api/user/v1/mcp/apps/state
 */
export async function saveMapOrigin(
  sessionId: string,
  toolCallId: string,
  origin: MapOriginState | { lat: number; lng: number },
): Promise<boolean> {
  try {
    await api.put('/api/user/v1/mcp/apps/state', {
      uri: 'ui://googlemap/origin',
      sessionId,
      toolCallId,
      state: origin,
    });
    return true;
  } catch (e: any) {
    console.warn('[MCP] Failed to save map origin:', e?.message);
    return false;
  }
}

/**
 * Convert ApiSession to ChatSession
 */
function apiSessionToChatSession(apiSession: ApiSession): ChatSession {
  return {
    id: apiSession.id,
    title: apiSession.name || 'New chat',
    updatedAt: new Date(apiSession.updatedAt),
    isPinned: apiSession.isPinned ?? false,
  };
}

/**
 * Convert ApiAgent to Agent
 */
function apiAgentToAgent(apiAgent: ApiAgent): Agent {
  return {
    id: apiAgent.id,
    name: apiAgent.name,
    description: apiAgent.description,
  };
}
