import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { useShareIntakeStore } from '@/stores/share-intake';
import { useShareIntoUiStore } from '@/stores/share-into-ui';
import type { ShareIntoDraft } from '@/types';
import { logger } from '@/utils/logger';
import {
  resolveIncomingShareDraft,
  clearIncomingSharePayload,
} from '@/utils/share-intake-content';

let _presenting = false;

/**
 * Entry point for a share-into wake-up. Resolves the shared payloads and
 * presents the right UI instead of sending silently:
 * - image share  → image is attached to the chat input bar, user types & sends
 * - text/URL     → bottom sheet opened with the text pre-filled
 *
 * Logged out → stash the draft; flushed by `sendPendingShareContent` after login.
 */
export async function presentIncomingShare(): Promise<void> {
  if (_presenting) return;
  _presenting = true;
  try {
    const draft = await resolveIncomingShareDraft();
    if (!draft) return;

    if (!useAuthStore.getState().isAuthenticated) {
      useShareIntakeStore.getState().setPendingContent(draft);
      clearIncomingSharePayload();
      return;
    }

    await showDraft(draft);
    clearIncomingSharePayload();
  } finally {
    _presenting = false;
  }
}

/** Flush a draft stashed while logged out. Idempotent (no-op when empty). */
export async function sendPendingShareContent(): Promise<void> {
  const draft = useShareIntakeStore.getState().consumeContent();
  if (!draft) return;
  await showDraft(draft);
}

async function showDraft(draft: ShareIntoDraft): Promise<void> {
  const ui = useShareIntoUiStore.getState();
  if (draft.image) {
    // Ensure a session exists so the input-bar send has a target.
    await ensureSession();
    ui.setPendingImage({
      id: `share-${Date.now()}`,
      type: 'image',
      name: draft.image.name ?? 'shared-image',
      uri: draft.image.uri,
      mediaType: draft.image.mediaType,
    });
  } else if (draft.text) {
    ui.openShareModal(draft.text);
  }
}

/** Send the (possibly edited) text from the share bottom sheet. */
export async function sendShareModalText(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const sessionId = await ensureSession();
  if (!sessionId) return;
  useChatStore.getState().sendMessage(sessionId, trimmed);
}

/**
 * Returns the current session id, creating a default one when missing.
 * createSessionAsync sets currentSessionId itself.
 */
async function ensureSession(): Promise<string | null> {
  const chat = useChatStore.getState();
  if (chat.currentSessionId) return chat.currentSessionId;
  const created = await chat.createSessionAsync({ agentId: 'default' });
  if (!created) {
    logger.warn('ShareInto', 'createSessionAsync failed');
  }
  return created;
}
