/**
 * Linking interceptor: prevents expo-router from processing
 * `trackplayer://` notification-click URLs (which causes a 404 flash).
 *
 * When react-native-track-player's notification bar is tapped, Android
 * delivers an intent with `data="trackplayer://notification.click"` to
 * MainActivity. React Native's Linking module translates this into a URL
 * event. Expo Router's internal linking system receives the URL, tries to
 * match it against app routes, fails, and briefly renders the not-found
 * page before the music navigation hook can redirect.
 *
 * This module patches `Linking.getInitialURL` and
 * `Linking.addEventListener` at app startup (before expo-router mounts
 * its navigation container) to filter `trackplayer://` URLs:
 *
 * - `getInitialURL` returns `null` for `trackplayer://` URLs
 * - `addEventListener('url')` routes `trackplayer://` events to a separate
 *   listener channel, invisible to expo-router
 *
 * The music navigation hook consumes the intercepted URLs via
 * `getTrackPlayerInitialURL()` and `addTrackPlayerURLListener()`.
 *
 * @module utils/linking-interceptor
 */

import { Linking } from 'react-native';

const TRACKPLAYER_SCHEME = 'trackplayer://';
const SHAREINTO_HOSTNAME = 'expo-sharing';

// --- Capture original Linking methods at module load time ---
//
// This module is imported BEFORE installLinkingInterceptor() is called
// (ESM hoists all imports, then the module body runs). So these
// references point to the pristine React Native implementations.
const _originalGetInitialURL = Linking.getInitialURL.bind(Linking);
const _originalAddEventListener = Linking.addEventListener.bind(Linking);

let _installed = false;

// --- Separate event channel for trackplayer:// URLs ---
//
// When a `trackplayer://` URL event arrives, it is dispatched to every
// function in this array. Expo Router's own Linking listener never sees
// the event because our patched `addEventListener` swallows it.
const _trackPlayerListeners: Array<(url: string) => void> = [];

// Same private channel for share-into wakeups (hostname = 'expo-sharing').
// Listeners receive no payload — they read the shared content themselves.
const _shareIntoListeners: Array<() => void> = [];

/**
 * Monkey-patch `Linking.getInitialURL` and `Linking.addEventListener` to
 * filter `trackplayer://` URLs. Idempotent — safe to call multiple times.
 *
 * MUST be called before expo-router mounts its navigation container.
 * In practice this means calling it at module scope in the root
 * `_layout.tsx` (after imports resolve, before React renders).
 */
export function installLinkingInterceptor(): void {
  if (_installed) return;
  _installed = true;

  // Patch getInitialURL: return null for trackplayer:// URLs so
  // expo-router sees no deep-link to route (prevents 404 flash).
  // Same for share-into wakeups (hostname = 'expo-sharing').
  Linking.getInitialURL = async (): Promise<string | null> => {
    const url = await _originalGetInitialURL();
    if (!url) return null;
    if (url.startsWith(TRACKPLAYER_SCHEME)) {
      return null;
    }
    if (_isShareIntoUrl(url)) {
      _dispatchShareInto();
      return null;
    }
    return url;
  };

  // Patch addEventListener: wrap each subscriber so trackplayer://
  // events are routed to our private channel, invisible to expo-router.
  Linking.addEventListener = (
    type: 'url',
    handler: (event: { url: string }) => void,
  ) => {
    const wrappedHandler = (event: { url: string }): void => {
      if (event.url.startsWith(TRACKPLAYER_SCHEME)) {
        // Dispatch to our own listeners (clone array to tolerate
        // mutations during iteration — listener may unsubscribe).
        const snapshot = _trackPlayerListeners.slice();
        for (const fn of snapshot) {
          fn(event.url);
        }
        return;
      }
      if (_isShareIntoUrl(event.url)) {
        _dispatchShareInto();
        return;
      }
      // Non-trackplayer URL — forward to the original subscriber.
      handler(event);
    };
    return _originalAddEventListener(type, wrappedHandler);
  };
}

// ─── Public API for the music navigation hook ─────────────────────────

/**
 * Read the app-launch URL if (and only if) it is a `trackplayer://` URL.
 *
 * Uses the ORIGINAL (pre-patch) `getInitialURL` so the filter installed
 * by `installLinkingInterceptor` does not affect this call.
 *
 * Returns `null` when the app was NOT launched from a music notification.
 */
export async function getTrackPlayerInitialURL(): Promise<string | null> {
  const url = await _originalGetInitialURL();
  if (url && url.startsWith(TRACKPLAYER_SCHEME)) {
    return url;
  }
  return null;
}

/**
 * Subscribe to `trackplayer://` URL events that were intercepted from
 * expo-router's Linking listener.
 *
 * @returns An unsubscribe function.
 */
export function addTrackPlayerURLListener(
  fn: (url: string) => void,
): () => void {
  _trackPlayerListeners.push(fn);
  return () => {
    const idx = _trackPlayerListeners.indexOf(fn);
    if (idx >= 0) {
      _trackPlayerListeners.splice(idx, 1);
    }
  };
}

// ─── Share-into (system share sheet → app) ─────────────────────────────

function _isShareIntoUrl(url: string): boolean {
  try {
    return new URL(url).hostname === SHAREINTO_HOSTNAME;
  } catch {
    return false;
  }
}

function _dispatchShareInto(): void {
  const snapshot = _shareIntoListeners.slice();
  for (const fn of snapshot) fn();
}

/**
 * Subscribe to "content shared INTO the app" wakeups. The callback reads
 * the shared content itself (see utils/share-intake-content.ts), so no
 * payload is passed.
 *
 * @returns An unsubscribe function.
 */
export function addShareIntoListener(fn: () => void): () => void {
  _shareIntoListeners.push(fn);
  return () => {
    const idx = _shareIntoListeners.indexOf(fn);
    if (idx >= 0) {
      _shareIntoListeners.splice(idx, 1);
    }
  };
}

/** Test-only: expose the share-into URL matcher. */
export function _isShareIntoUrlForTest(url: string): boolean {
  return _isShareIntoUrl(url);
}
