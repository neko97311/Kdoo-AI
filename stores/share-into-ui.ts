import { create } from 'zustand';
import type { Attachment } from '@/types';

/**
 * Session-scoped UI state for the share-into interaction.
 *
 * - `modalText` drives the bottom sheet (text/URL shares): non-null opens it,
 *   pre-filled with the shared text; the user edits then taps Share.
 * - `pendingImage` is a one-shot image attachment consumed by ChatInputBar so
 *   an image share shows up in the input bar waiting for the user's text.
 */
export interface ShareIntoUiState {
  modalText: string | null;
  openShareModal: (text: string) => void;
  closeShareModal: () => void;

  pendingImage: Attachment | null;
  setPendingImage: (a: Attachment) => void;
  consumePendingImage: () => Attachment | null;
}

export const useShareIntoUiStore = create<ShareIntoUiState>((set, get) => ({
  modalText: null,
  openShareModal: (text) => set({ modalText: text }),
  closeShareModal: () => set({ modalText: null }),

  pendingImage: null,
  setPendingImage: (a) => set({ pendingImage: a }),
  consumePendingImage: () => {
    const a = get().pendingImage;
    if (a) set({ pendingImage: null });
    return a;
  },
}));
