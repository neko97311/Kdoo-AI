import { useCallback } from 'react';
import { Share } from 'react-native';
import { createSessionShare } from '@/services/session-service';
import { useToastStore } from '@/stores/toast';
import { logger } from '@/utils/logger';
import { useI18n } from '@/hooks/useI18n';

/**
 * Share-flow hook shared by ChatDrawer's session action sheet and
 * ChatHeader's share button (same pattern as webview.tsx handleSystemShare):
 * create the share link on the server, then hand it to the system share
 * sheet. API failure surfaces a toast; dismissing the share sheet is a no-op.
 */
export function useSessionShare() {
  const { t, locale } = useI18n();

  return useCallback(
    async (sessionId: string, title?: string) => {
      let shareUrl: string;
      try {
        shareUrl = await createSessionShare(sessionId, title, locale);
      } catch (e) {
        logger.warn('useSessionShare', 'createSessionShare failed', {
          sessionId,
          error: e instanceof Error ? e.message : String(e),
        });
        useToastStore.getState().showToast({
          message: t('chatDrawer.shareFailed'),
          variant: 'warning',
        });
        return;
      }
      try {
        await Share.share({ message: shareUrl, url: shareUrl, title });
      } catch {
        // user cancelled the system share sheet - no-op
      }
    },
    [t, locale],
  );
}
