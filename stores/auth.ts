import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatSetting, UserProfile, LoginRequest, RegisterRequest } from '@/types';
import {
  login as loginApi,
  logout as logoutApi,
  register as registerApi,
} from '@/services/email-auth';
import { resetSessionExpiredGuard, setSessionExpiredHandler, setLoggedOutFlag } from '@/services/api';
import {
  googleAppLogin,
} from '@/services/google-auth';
import {
  configureGoogleSignIn,
  signInWithGoogle,
  signOutGoogle,
} from '@/services/google-signin';
import {
  signInWithApple,
} from '@/services/apple-signin';
import {
  appleAppLogin,
} from '@/services/apple-auth';
import { getProfile, deleteAccount as deleteAccountApi } from '@/services/user';
import { unregisterDevice } from '@/services/device';
import { PUSH_TOKEN_CACHE_KEY } from '@/services/notifications';
import { PENDING_NAVIGATION_STORAGE_KEY } from '@/services/notification-navigation';
import { encode as toBase64 } from 'base-64';
import { mmkv } from '@/lib/mmkv';
import { clearAllUserData } from '@/lib/db';
// Circular import note: chat.ts imports useAuthStore from this file, but
// useChatStore is only referenced inside the logout() function body (runtime),
// never at module evaluation time. ES module circular deps resolve safely here.
import { useChatStore } from '@/stores/chat';

const AUTH_STORAGE_KEY = 'auth_storage';
const AUTH_MMKV_KEY = 'auth_state_mirror';

/**
 * AsyncStorage key for the last-opened session ID. Shared between
 * auth.ts (restores it in onLoginSuccess BEFORE flipping auth state)
 * and _layout.tsx (saves it on session change).
 *
 * Restoring currentSessionId before isAuthenticated=true ensures the
 * _layout gate opens instantly on re-login — no Loading frame, no
 * ChatHome flash.
 */
export const LAST_SESSION_KEY = 'last_session_id';

async function onLoginSuccess(
  set: (partial: Partial<AuthStore>) => void,
  token: string,
  refreshToken: string
): Promise<void> {
  await AsyncStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ token, refreshToken })
  );
  // MMKV mirror: synchronously readable on cold start so
  // auth.initialize() can set isInitialized=true in the same
  // JS tick, eliminating the AsyncStorage read delay (~10-100ms).
  mmkv.set(AUTH_MMKV_KEY, JSON.stringify({ token, refreshToken }));

  // ── Restore last session BEFORE flipping auth state ──────────
  // This is the KEY to eliminating Loading + ChatHome flash on
  // re-login. When isAuthenticated flips to true, _layout's gate
  // checks `currentSessionId` — if it's already set, the gate
  // opens instantly (no Loading frame, no ChatHome flash).
  //
  // On logout, chat store's currentSessionId is reset to null and
  // MMKV is cleared. On re-login, we restore it here from
  // AsyncStorage (which is NOT cleared on logout) so the gate
  // sees a valid session ID immediately.
  try {
    const savedSessionId = await AsyncStorage.getItem(LAST_SESSION_KEY);
    if (savedSessionId) {
      useChatStore.getState().setCurrentSession(savedSessionId);
      console.log('[Auth] pre-restored sessionId before auth flip:', savedSessionId);
    }
  } catch {
    // Ignore — gate effect will handle session restore as fallback
  }

  set({ token, refreshToken, isAuthenticated: true, isLoading: false });
  resetSessionExpiredGuard();
  setLoggedOutFlag(false);

  try {
    const user = await getProfile();
    await AsyncStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ user, token, refreshToken })
    );
    // Keep MMKV mirror in sync after profile fetch
    mmkv.set(AUTH_MMKV_KEY, JSON.stringify({ user, token, refreshToken }));
    set({ user });
  } catch (e) {
    console.warn('[Auth] Failed to fetch profile after login:', e);
  }
}

interface AuthStore {
  user: UserProfile | null;
  token: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Whether the initial app startup check (AsyncStorage restore) has completed */
  isInitialized: boolean;

  initialize: () => Promise<void>;
  login: (credentials: LoginRequest) => Promise<void>;
  register: (data: RegisterRequest) => Promise<void>;
  googleLogin: () => Promise<void>;
  appleLogin: () => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Permanently delete the account server-side, then run the same local
   * cleanup as logout(). Throws if server-side deletion fails — the local
   * session stays intact in that case so the user can retry.
   */
  deleteAccount: () => Promise<void>;
  fetchProfile: () => Promise<void>;
  /**
   * Patch chat settings on the local user object without re-fetching the
   * entire profile. Use this after a successful `updateChatSettings` API
   * call to keep UI state in sync without paying for a second network
   * round-trip (which can trap a loading Modal open if it stalls).
   *
   * If `user` is null (e.g. caller invoked before login completed), this
   * is a no-op — caller should fall back to `fetchProfile()` in that case.
   */
  setChatSetting: (patch: Partial<ChatSetting>) => void;
}

// ── Eager MMKV read at module load time (synchronous) ───────────
// If MMKV has a valid auth mirror, the store starts in the
// authenticated state with isInitialized=true — no async
// initialize() needed for the first render. This eliminates the
// Loading frame on cold start (the #1 UX issue).
//
// initialize() still runs in useEffect to cross-validate against
// AsyncStorage (source of truth) and handle the no-MMKV case.
function getEagerAuthState(): Pick<AuthStore, 'user' | 'token' | 'refreshToken' | 'isAuthenticated' | 'isLoading' | 'isInitialized'> {
  // Optimistic unauthenticated state — used when MMKV has no mirror.
  // Gate opens immediately (isInitialized=true) → login page renders
  // without waiting for AsyncStorage (~246ms native bridge call).
  // initialize() validates against AsyncStorage in the background;
  // if a token is found (rare: MMKV cleared but AsyncStorage intact),
  // it flips isAuthenticated → gate reopens to main app.
  const unauthenticated = {
    user: null,
    token: null,
    refreshToken: null,
    isAuthenticated: false,
    isLoading: false,
    isInitialized: true,
  };
  try {
    const raw = mmkv.getString(AUTH_MMKV_KEY);
    if (!raw) return unauthenticated;
    const { user, token, refreshToken } = JSON.parse(raw);
    if (!token) return unauthenticated;
    return {
      user: user ?? null,
      token,
      refreshToken: refreshToken ?? null,
      isAuthenticated: true,
      isLoading: false,
      isInitialized: true,
    };
  } catch {
    // Corrupt MMKV — optimistic unauthenticated; initialize() validates.
    return unauthenticated;
  }
}

/**
 * Shared local cleanup for logout() and deleteAccount(): clears auth
 * storage, flips auth state (which triggers navigation to login), then
 * wipes all user-scoped caches in the background.
 */
async function performLocalSignOutCleanup(
  set: (partial: Partial<AuthStore>) => void,
  userId: string | undefined
): Promise<void> {
  // ── Critical: clear auth storage BEFORE flipping state ───────
  // The API layer (services/api.ts) reads tokens from AsyncStorage
  // (AUTH_STORAGE_KEY), not from the zustand store. If this removal
  // is fire-and-forget, it can race with a subsequent login's
  // setItem → the delayed removeItem wipes the fresh token → 401
  // → "Session Expired" toast. Await it here so the new login's
  // setItem always runs after the removal.
  await AsyncStorage.removeItem(AUTH_STORAGE_KEY);

  // Await LAST_SESSION_KEY removal too — if it survives a fast
  // account switch, _layout.tsx restores account A's sessionId into
  // account B → "Session not found or access denied" on next send.
  await AsyncStorage.removeItem(LAST_SESSION_KEY);

  // ── Flip auth state IMMEDIATELY ──────────────────────────────
  // Navigation to login fires here. Remaining cleanup below is
  // fire-and-forget.
  set({
    user: null,
    token: null,
    refreshToken: null,
    isAuthenticated: false,
    isLoading: false,
  });

  // ── Fire-and-forget cleanup (runs in background) ─────────────
  signOutGoogle().catch(() => { /* ignore */ });

  (async () => {
    try {
      const pushToken = await AsyncStorage.getItem(PUSH_TOKEN_CACHE_KEY);
      if (pushToken) unregisterDevice(pushToken);
    } catch { /* ignore */ }
  })();

  // Clean up user-scoped AsyncStorage keys so a different account
  // logging in on the same device never sees the previous user's data.
  // LAST_SESSION_KEY is already removed+awaited above (before state flip).
  //   - PENDING_NAVIGATION: otherwise a pending push-navigation from
  //     account A fires after account B logs in → navigates to a
  //     session that doesn't belong to account B.
  AsyncStorage.removeItem(PUSH_TOKEN_CACHE_KEY).catch(() => {});
  AsyncStorage.removeItem(PENDING_NAVIGATION_STORAGE_KEY).catch(() => {});

  // ── Cancel in-flight WebSocket stream BEFORE clearing state ──
  // Without this, an active stream survives logout. The server
  // eventually rejects it ("Session not found or access denied")
  // because the auth token is gone — error fires AFTER the new
  // account logs in, polluting the new session's UI.
  useChatStore.getState().disconnectWebSocket();
  useChatStore.setState({ isStreaming: false });

  // Login isolation: clear persisted chat data (MMKV) and reset in-memory
  // chat store state so a different user logging in on the same device
  // never sees the previous user's sessions/messages.
  mmkv.clearAll();
  useChatStore.setState({
    sessions: [],
    messages: {},
    messageCursors: {},
    currentSessionId: null,
  });

  // Voice store: lazy import + reset (first-call bundle runs in background)
  import('@/stores/voice')
    .then(({ resetVoiceState }) => resetVoiceState())
    .catch((e) => console.warn('[Auth] Failed to reset voice store on sign-out:', e));

  // ── Audio cleanup: TTS read-aloud + background music ─────────
  // Without this the notification-bar music keeps playing with stale
  // data and TTS may finish its buffered chunks after sign-out.
  // Lazy imports mirror the voice-store pattern above (keeps the auth
  // module free of audio deps at load time). Release the music duck
  // flag FIRST so stopTtsPlayback's teardown doesn't call play() on
  // the queue that stopAndClearQueue is about to reset.
  import('@/utils/audio-coordination')
    .then(({ releaseMusicDuck }) => releaseMusicDuck())
    .catch(() => { /* ignore */ });
  import('@/hooks/useTrackPlayer')
    .then(({ stopAndClearQueue }) => stopAndClearQueue())
    .catch((e) => console.warn('[Auth] Failed to clear music queue on sign-out:', e));
  import('@/stores/tts')
    .then(({ useTtsStore }) => useTtsStore.getState().stopTtsPlayback())
    .catch((e) => console.warn('[Auth] Failed to stop TTS on sign-out:', e));

  // SQLite: wipe user-scoped cache (lazy import, fire-and-forget)
  if (userId) {
    clearAllUserData(userId).catch((e) => {
      console.warn('[Auth] Failed to clear SQLite data on sign-out:', e);
    });
  }
}

let initializeCalled = false;

const eagerState = getEagerAuthState();
if (eagerState.isAuthenticated) {
  console.log('[Auth] eager init from MMKV — authenticated, no Loading frame');
} else {
  console.log('[Auth] eager init — optimistically unauthenticated, no Loading frame');
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: eagerState?.user ?? null,
  token: eagerState?.token ?? null,
  refreshToken: eagerState?.refreshToken ?? null,
  isAuthenticated: eagerState?.isAuthenticated ?? false,
  isLoading: eagerState?.isLoading ?? true,
  isInitialized: eagerState?.isInitialized ?? false,

  initialize: async () => {
    // Idempotent guard: prevent multiple invocations (React Strict Mode
    // double-mount, component re-mounts). Uses a module-level flag
    // instead of checking isInitialized because eager init now sets
    // isInitialized=true optimistically — we still need to validate
    // against AsyncStorage (source of truth) on the first real call.
    if (initializeCalled) {
      console.log('[Auth] initialize skipped (already called)');
      return;
    }
    initializeCalled = true;

    const t0 = Date.now();
    console.log('[Auth] initialize start');

    // ── Fast path: MMKV synchronous read ──────────────────────────
    // Cold start reads auth state from MMKV (sync) instead of
    // AsyncStorage (async). This eliminates ~10-100ms of Loading
    // on every cold start. AsyncStorage is still the source of
    // truth — we cross-validate asynchronously below.
    const mmkvRaw = mmkv.getString(AUTH_MMKV_KEY);
    if (mmkvRaw) {
      try {
        const { user, token, refreshToken } = JSON.parse(mmkvRaw);
        set({ user, token, refreshToken, isAuthenticated: true, isLoading: false, isInitialized: true });
        console.log(`[Auth] initialize done (MMKV) @ ${Date.now() - t0}ms, userId:`, user?.id);
      } catch {
        // Corrupt MMKV — fall through to AsyncStorage
      }
    }

    // ── Async validation against AsyncStorage (source of truth) ──
    try {
      const stored = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
      if (stored) {
        const { user, token, refreshToken } = JSON.parse(stored);
        // If MMKV fast path didn't fire (no mirror), set state now
        if (!mmkvRaw) {
          set({ user, token, refreshToken, isAuthenticated: true, isLoading: false, isInitialized: true });
          console.log(`[Auth] initialize done (AsyncStorage restored) @ ${Date.now() - t0}ms`);
        } else {
          // MMKV already set state — only patch if AsyncStorage has
          // a richer profile (e.g. MMKV mirror was written before
          // getProfile completed).
          if (user && !useAuthStore.getState().user) {
            set({ user });
          }
        }
      } else {
        // No stored auth → not logged in
        if (!mmkvRaw) {
          set({ isLoading: false, isInitialized: true });
          console.log(`[Auth] initialize done (no stored) @ ${Date.now() - t0}ms`);
        } else {
          // MMKV says logged in but AsyncStorage disagrees → trust
          // AsyncStorage (source of truth), clear stale MMKV mirror.
          mmkv.delete(AUTH_MMKV_KEY);
          set({ user: null, token: null, refreshToken: null, isAuthenticated: false, isLoading: false, isInitialized: true });
          console.log(`[Auth] initialize: MMKV stale, cleared, now logged out @ ${Date.now() - t0}ms`);
        }
      }
    } catch {
      if (!mmkvRaw) {
        set({ isLoading: false, isInitialized: true });
        console.log(`[Auth] initialize done (error) @ ${Date.now() - t0}ms`);
      }
    }
  },

  login: async (credentials: LoginRequest) => {
    set({ isLoading: true });
    try {
      const encoded: LoginRequest = {
        ...credentials,
        password: credentials.password ? toBase64(credentials.password) : '',
      };
      const res = await loginApi(encoded);

      // Defensive: network/timeout errors return undefined from the API
      // layer (after a toast). Without this guard, the destructure below
      // throws "Cannot read property 'tokens' of undefined", masking the
      // real cause. ApiError from business/HTTP failures is already thrown
      // by loginApi and never reaches here.
      if (!res?.tokens) {
        throw new Error('Login failed. Please check your network and try again.');
      }
      const { tokens } = res;
      const token = tokens.accessToken;
      const refreshToken = tokens.refreshToken;

      await onLoginSuccess(set, token, refreshToken);
    } catch (e: any) {
      set({ isLoading: false });
      throw e;
    }
  },

  register: async (data: RegisterRequest) => {
    set({ isLoading: true });
    try {
      const encoded: RegisterRequest = {
        ...data,
        password: toBase64(data.password),
      };
      const res = await registerApi(encoded);

      if (!res?.tokens) {
        throw new Error('Registration failed. Please check your network and try again.');
      }
      const { tokens } = res;
      const token = tokens.accessToken;
      const refreshToken = tokens.refreshToken;

      await onLoginSuccess(set, token, refreshToken);
    } catch (e: any) {
      set({ isLoading: false });
      throw e;
    }
  },

  googleLogin: async () => {
    set({ isLoading: true });
    try {
      await configureGoogleSignIn();
      console.log('[Auth] googleLogin: configure done');

      const idToken = await signInWithGoogle();
      if (!idToken) {
        console.log('[Auth] googleLogin: user cancelled or no idToken');
        set({ isLoading: false });
        return;
      }
      console.log('[Auth] googleLogin: got idToken, calling backend...');

      const loginRes = await googleAppLogin({ idToken });
      console.log('[Auth] googleLogin: backend login success');

      if (!loginRes?.tokens) {
        throw new Error('Google login failed. Please check your network and try again.');
      }
      const { tokens } = loginRes;
      const token = tokens.accessToken;
      const refreshToken = tokens.refreshToken;

      await onLoginSuccess(set, token, refreshToken);
    } catch (e: any) {
      set({ isLoading: false });
      throw e;
    }
  },

  appleLogin: async () => {
    set({ isLoading: true });
    try {
      const payload = await signInWithApple();
      if (!payload) {
        set({ isLoading: false });
        return;
      }

      const loginRes = await appleAppLogin({
        identityToken: payload.identityToken,
        authorizationCode: payload.authorizationCode,
        user: payload.user,
        email: payload.email,
        givenName: payload.fullName?.givenName ?? null,
        familyName: payload.fullName?.familyName ?? null,
        rawNonce: payload.rawNonce,
      });

      if (!loginRes?.tokens) {
        throw new Error('Apple login failed. Please check your network and try again.');
      }
      const { tokens } = loginRes;
      const token = tokens.accessToken;
      const refreshToken = tokens.refreshToken;

      await onLoginSuccess(set, token, refreshToken);
    } catch (e: any) {
      set({ isLoading: false });
      throw e;
    }
  },

  logout: async () => {
    // Mark logged-out BEFORE any async work so in-flight/queued requests
    // that return 401 after token clearing do NOT trigger the
    // "Session Expired" toast. Reset to false on next successful login.
    setLoggedOutFlag(true);

    // Capture userId BEFORE clearing state — clearAllUserData needs it
    // and we null out `user` immediately after the API returns.
    const userId = useAuthStore.getState().user?.id;

    try {
      await logoutApi();
    } catch {
      // Ignore logout API errors — always clear local state
    }

    await performLocalSignOutCleanup(set, userId);
  },

  deleteAccount: async () => {
    // Same flag as logout: suppress the "Session Expired" toast for any
    // request that 401s after the token is cleared below.
    setLoggedOutFlag(true);

    const userId = useAuthStore.getState().user?.id;

    // Server-side deletion must succeed BEFORE local cleanup — if it
    // fails (network/API), the user keeps a working session and can retry.
    const res = await deleteAccountApi();
    if (!res?.deleted) {
      setLoggedOutFlag(false);
      throw new Error('ACCOUNT_DELETE_FAILED');
    }

    await performLocalSignOutCleanup(set, userId);
  },

  fetchProfile: async () => {
    try {
      const user = await getProfile();
      const { token, refreshToken } = useAuthStore.getState();
      const payload = JSON.stringify({ user, token, refreshToken });
      await AsyncStorage.setItem(AUTH_STORAGE_KEY, payload);
      // Keep MMKV mirror in sync so cold start reflects the latest profile.
      mmkv.set(AUTH_MMKV_KEY, payload);
      set({ user });
    } catch (e) {
      console.warn('[Auth] Failed to fetch profile:', e);
    }
  },

  setChatSetting: (patch) => {
    const { user, token, refreshToken } = useAuthStore.getState();
    if (!user?.chatSetting) return;

    const updatedUser: UserProfile = {
      ...user,
      chatSetting: { ...user.chatSetting, ...patch },
    };

    set({ user: updatedUser });

    // Persist to both AsyncStorage (source of truth) and MMKV (fast cold-start
    // mirror). Without the MMKV sync, cold start reads stale chatSetting from
    // the mirror — e.g. autoPlay shows the old icon until AsyncStorage loads.
    const payload = JSON.stringify({ user: updatedUser, token, refreshToken });
    AsyncStorage.setItem(AUTH_STORAGE_KEY, payload).catch((e) => {
      console.warn('[Auth] Failed to persist chat setting:', e);
    });
    mmkv.set(AUTH_MMKV_KEY, payload);
  },
}));

setSessionExpiredHandler(() => {
  useAuthStore.setState({
    user: null,
    token: null,
    refreshToken: null,
    isAuthenticated: false,
    isLoading: false,
  });
  // Clear MMKV auth mirror so next cold start doesn't restore
  // expired credentials.
  mmkv.delete(AUTH_MMKV_KEY);

  // ── Same local cleanup as logout() ────────────────────────────
  // Session expired = token invalidated server-side. The user will
  // re-login, potentially with a DIFFERENT account. We must clear all
  // user-scoped cached data so the next login never sees stale data
  // from the expired session's account.
  //
  // We intentionally do NOT call logoutApi() / unregisterDevice() here
  // — the token is already invalid, those calls would just 401 again.
  // We also skip clearAllUserData(SQLite) because userId is already
  // null after the setState above (captured before this callback).
  //
  // CRITICAL: clear the AsyncStorage source-of-truth too. If we leave
  // AUTH_STORAGE_KEY behind, the next cold start's initialize() will
  // rehydrate the expired token/user from AsyncStorage and flip
  // isAuthenticated=true, bypassing this cleanup entirely.
  AsyncStorage.removeItem(AUTH_STORAGE_KEY).catch(() => {});
  AsyncStorage.removeItem(LAST_SESSION_KEY).catch(() => {});
  AsyncStorage.removeItem(PENDING_NAVIGATION_STORAGE_KEY).catch(() => {});

  // Wipe chat store persisted state + in-memory state so a different
  // account logging in after session expiry never sees the previous
  // user's sessions/messages.
  useChatStore.getState().disconnectWebSocket();
  useChatStore.setState({ isStreaming: false });
  mmkv.clearAll();
  useChatStore.setState({
    sessions: [],
    messages: {},
    messageCursors: {},
    currentSessionId: null,
  });

  // ── Audio cleanup (same as logout) ──────────────────────────────
  // Session expiry is a forced sign-out — background music and TTS
  // read-aloud must stop too. Lazy imports keep this callback's static
  // dependency graph free of audio modules.
  import('@/utils/audio-coordination')
    .then(({ releaseMusicDuck }) => releaseMusicDuck())
    .catch(() => { /* ignore */ });
  import('@/hooks/useTrackPlayer')
    .then(({ stopAndClearQueue }) => stopAndClearQueue())
    .catch((e) => console.warn('[Auth] Failed to clear music queue on session expiry:', e));
  import('@/stores/tts')
    .then(({ useTtsStore }) => useTtsStore.getState().stopTtsPlayback())
    .catch((e) => console.warn('[Auth] Failed to stop TTS on session expiry:', e));
});
