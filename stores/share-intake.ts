import { create } from 'zustand';
import type { ShareIntoDraft } from '@/types';

/**
 * Transient state for the share-link intake flow.
 *
 * When the app is woken via `kdoomobile://share/{id}` (or the equivalent
 * Universal Link) and the user is not yet logged in, the share intake
 * page writes the token here before redirecting to the login screen.
 * The root layout watches this store: once `isAuthenticated` flips to
 * `true`, it consumes the pending token, forks the share via the API,
 * and routes the user to the new session.
 *
 * Also holds share-into content (system share sheet → app) that arrived
 * while logged out; it is consumed after login and sent to the chat.
 *
 * Not persisted: if the OS kills the app between "redirect to login"
 * and "login completes", the share link is lost. The user will have to
 * re-tap the share link from their browser, which is the standard
 * deep-link semantics for unauthenticated hand-off.
 */
export interface ShareIntakeState {
  /** Share token (≡ the `id` from `createSessionShare`) to fork after login. */
  pendingToken: string | null;
  setPending: (token: string) => void;
  consume: () => string | null;
  /** 系统分享进来的待发送内容（未登录时暂存，登录后消费）。 */
  pendingContent: ShareIntoDraft | null;
  setPendingContent: (c: ShareIntoDraft) => void;
  consumeContent: () => ShareIntoDraft | null;
}

export const useShareIntakeStore = create<ShareIntakeState>((set, get) => ({
  pendingToken: null,
  setPending: (token) => set({ pendingToken: token }),
  /**
   * Atomically read-and-clear the pending token. Returns `null` if
   * there is no pending intake. Idempotent — safe to call multiple
   * times (the second call gets `null`).
   */
  consume: () => {
    const token = get().pendingToken;
    if (token) set({ pendingToken: null });
    return token;
  },
  pendingContent: null,
  setPendingContent: (c) => set({ pendingContent: c }),
  /**
   * Atomically read-and-clear the pending share-into content. Idempotent.
   */
  consumeContent: () => {
    const c = get().pendingContent;
    if (c) set({ pendingContent: null });
    return c;
  },
}));
