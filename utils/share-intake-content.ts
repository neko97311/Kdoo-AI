import * as Sharing from 'expo-sharing';
import type { ShareIntoDraft } from '@/types';
import { logger } from '@/utils/logger';

/**
 * Read and resolve the content shared into the app from the system share
 * sheet, normalizing ALL payloads into a {@link ShareIntoDraft}.
 *
 * A single share can carry several payloads at once (e.g. a news article
 * arrives as image + text + url). Priority:
 * 1. a text/html payload (webpage/article link) wins → text share (modal)
 * 2. else the first image becomes `draft.image` (input-bar attachment)
 * 3. remaining text values are joined into `draft.text`
 *
 * Returns `null` when nothing usable was shared.
 */
export async function resolveIncomingShareDraft(): Promise<ShareIntoDraft | null> {
  try {
    logger.info('ShareInto', 'raw shared payloads', {
      count: Sharing.getSharedPayloads().length,
      payloads: Sharing.getSharedPayloads().map((p) => ({
        value: p.value,
        shareType: p.shareType,
        mimeType: p.mimeType,
      })),
    });

    const resolved = await Sharing.getResolvedSharedPayloadsAsync();
    logger.info('ShareInto', 'resolved shared payloads', {
      count: resolved.length,
      payloads: resolved.map((p) => ({
        shareType: p.shareType,
        value: p.value,
        contentType: p.contentType,
        contentUri: p.contentUri,
        contentMimeType: p.contentMimeType,
        originalName: p.originalName,
        contentSize: p.contentSize,
      })),
    });

    let image: ShareIntoDraft['image'] = null;
    let htmlText: string | null = null;
    const textLines: string[] = [];

    for (const p of resolved) {
      if (p.contentType === 'image') {
        if (!image) {
          image = {
            uri: p.contentUri ?? p.value,
            mediaType: p.contentMimeType ?? 'image/*',
            name: p.originalName ?? undefined,
          };
        }
        continue;
      }
      const raw = p.value.trim();
      if (!raw) continue;
      // text/html (webpage/article share, e.g. Toutiao's image+text+link
      // combo) takes priority: the whole share becomes a TEXT share with
      // the link pre-filled, instead of the image-attachment flow.
      const isHtmlShare =
        p.contentType === 'website' ||
        p.shareType === 'url' ||
        (p.contentMimeType ?? '').includes('text/html');
      if (isHtmlShare) {
        if (!htmlText) htmlText = raw;
        continue;
      }
      textLines.push(raw);
    }

    const draft: ShareIntoDraft = htmlText
      ? {
          // text/html link first, any plain text appended after it,
          // separated by whitespace.
          text:
            textLines.length > 0 ? `${htmlText}\n${textLines.join('\n')}` : htmlText,
          image: null,
        }
      : {
          text: textLines.length > 0 ? textLines.join('\n') : null,
          image,
        };
    logger.info('ShareInto', 'resolved share draft', { draft });
    if (!draft.text && !draft.image) return null;
    return draft;
  } catch (e) {
    logger.warn('ShareInto', 'resolveIncomingShareDraft failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Clear any residual share payload so a future share can be detected. */
export function clearIncomingSharePayload(): void {
  try {
    Sharing.clearSharedPayloads();
  } catch (e) {
    logger.warn('ShareInto', 'clearIncomingSharePayload failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
