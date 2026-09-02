/**
 * Compose-result callback bridge.
 *
 * The photo-compose edit page collects "text + image attachments" and hands the
 * result back to the chat page through this single, module-level callback. It is
 * the only channel by which the edit page returns its result to ChatInputBar.
 *
 * One-shot semantics: `emitComposeResult` invokes the currently registered
 * handler exactly once and then clears it, so a single compose session can never
 * deliver its result twice. Cancelling the edit page calls
 * `clearComposeResultHandler` to discard the result without invoking anything.
 */
import type { Attachment } from '@/types';

type ComposeResultHandler = (text: string, attachments: Attachment[]) => void;

let composeResultHandler: ComposeResultHandler | null = null;

/**
 * Persistent default sender, registered once by ChatInputBar on mount.
 *
 * `emitComposeResult` is intentionally one-shot (it nulls the active handler so
 * a single session can never deliver twice, guarding against a double-tap on the
 * send button). That one-shot semantics means the active handler is gone after
 * every compose session — which is fine when ChatInputBar opened compose itself
 * (it re-registers right before each of its own pushes), but a ChatBubble that
 * opens /photo-compose directly would otherwise find no live handler.
 *
 * The default sender solves this without weakening the one-shot guarantee: it
 * simply persists the sender so any opener can re-activate it before pushing.
 */
let defaultComposeSender: ComposeResultHandler | null = null;

/** Register the current chat screen's compose sender as the persistent default. */
export function registerComposeSender(handler: ComposeResultHandler): void {
  defaultComposeSender = handler;
}

/** Promote the persistent default sender to the active one-shot slot. Call right
 *  before opening /photo-compose from any entry point (e.g. a ChatBubble image
 *  tap) so `emitComposeResult` has a live handler. No-op until a default exists. */
export function activateComposeSender(): void {
  if (defaultComposeSender) {
    composeResultHandler = defaultComposeSender;
  }
}

/** Register the single compose-result handler, replacing any previous one. */
export function setComposeResultHandler(handler: ComposeResultHandler): void {
  composeResultHandler = handler;
}

/** Invoke the current handler exactly once, then clear it. No-op if none is set. */
export function emitComposeResult(text: string, attachments: Attachment[]): void {
  const handler = composeResultHandler;
  composeResultHandler = null;
  handler?.(text, attachments);
}

/** Remove the handler without invoking it (used when the edit page is cancelled). */
export function clearComposeResultHandler(): void {
  composeResultHandler = null;
}

/** Parse the serialized `initial` route param into a typed Attachment[].
 *
 * Route params arrive as a JSON string (per design §5.4: all Attachment
 * fields are serializable). We defensively filter out anything missing a
 * required `id` or `uri` and return [] on any parse failure so the caller
 * never crashes on a malformed param. */
export function parseInitialAttachments(initial: string | undefined): Attachment[] {
  if (!initial) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(initial);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is Attachment =>
      item != null &&
      typeof item === 'object' &&
      typeof (item as Attachment).id === 'string' &&
      typeof (item as Attachment).uri === 'string',
  );
}
