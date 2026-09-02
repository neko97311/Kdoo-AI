/**
 * Chat scroll-to-bottom request bridge.
 *
 * Module-level one-shot-ish handler channel used by full-screen chat modals
 * (MapChatInput in the map/nearby/my-location renderers) to ask the chat
 * message list to scroll to the bottom after they send a message.
 *
 * Why this exists: those modals call `useChatStore.sendMessage()` directly,
 * which bypasses ChatView's `handleSend` (the code path that normally sets
 * `wasNearBottom = true` and fires the post-send scroll burst). Without this
 * bridge the list stays where it was when the modal was opened.
 *
 * ChatView registers a handler once on mount; MapChatInput fires it after a
 * successful send. The handler is persistent (not one-shot) because map
 * sending can happen repeatedly across the session.
 *
 * @module utils/chat-scroll
 */
type ScrollToBottomHandler = () => void;

let scrollToBottomHandler: ScrollToBottomHandler | null = null;

/** Register (or replace) the chat list's scroll-to-bottom handler. Returns a
 *  cleanup function that clears it — call it on unmount. */
export function registerChatScrollToBottom(handler: ScrollToBottomHandler): () => void {
  scrollToBottomHandler = handler;
  return () => {
    if (scrollToBottomHandler === handler) {
      scrollToBottomHandler = null;
    }
  };
}

/** Ask the chat list to scroll to the bottom (no-op if no handler is registered). */
export function requestChatScrollToBottom(): void {
  scrollToBottomHandler?.();
}
