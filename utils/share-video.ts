import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library/legacy';
import { Platform } from 'react-native';
import { i18n } from '@/i18n';

/**
 * 分享视频 —— 参考 @/utils/share-image 的实现，适配视频。
 *
 * 入参可能是本地 `file://` URI，也可能是带鉴权 query 的远程视频 URL。
 * 本地 URI 直接送入分享面板；远程视频先下载到缓存目录再分享。
 *
 * **Android 兼容性**（与 share-image 相同）：老浏览器（百度/UC）靠
 * content:// URI 的 `_data` 列解析真实文件路径，FileProvider URI 不暴露
 * `_data` 列。所以 Android 上先 `MediaLibrary.createAssetAsync` 把视频复制到
 * DCIM，再分享该 asset 的 MediaStore content URI。expo-sharing 的 content://
 * 支持由 patches/expo-sharing 补丁提供。
 *
 * 临时文件在分享结束后延迟删除（目标 app 可能在分享面板关闭后才读取文件）。
 * 用户在分享面板里点"取消"不算错误（expo-sharing 正常 resolve）。
 * 抛出的业务错误均为 ShareVideoError（message 已本地化，可直接展示）。
 */
export class ShareVideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareVideoError';
  }
}

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function toShareError(error: unknown, fallbackKey: 'shareFailed' | 'downloadFailed'): ShareVideoError {
  const message = error instanceof Error ? error.message : String(error);
  return new ShareVideoError(
    containsChinese(message) ? message : i18n.t(`imagePreview.${fallbackKey}`),
  );
}

function extensionFromUrl(uri: string): string {
  const lastSegment = uri.split(/[?#]/)[0]?.split('/').pop() ?? '';
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(lastSegment);
  return match?.[1]?.toLowerCase() ?? 'mp4';
}

/** 视频 MIME 与 iOS UTI。 */
function mimeFromExtension(ext: string): { mimeType: string; UTI: string } {
  switch (ext) {
    case 'webm':
      return { mimeType: 'video/webm', UTI: 'org.webmproject.webm' };
    case 'mov':
      return { mimeType: 'video/quicktime', UTI: 'com.apple.quicktime-movie' };
    default:
      return { mimeType: 'video/mp4', UTI: 'public.mpeg-4' };
  }
}

async function deleteQuietly(uri: string): Promise<void> {
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

const SHARE_TEMP_FILE_PREFIX = 'kdoo-share-video-';
/** 分享面板可能晚于 promise resolve 才读取文件，延迟删除兜底。 */
const SHARE_TEMP_TTL_MS = 5 * 60 * 1000;

export async function shareVideo(uri: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new ShareVideoError(i18n.t('imagePreview.shareFailed'));
  }

  // 本地文件直接送入分享面板。
  if (uri.startsWith('file://') || uri.startsWith('/')) {
    const ext = extensionFromUrl(uri);
    const { mimeType, UTI } = mimeFromExtension(ext);
    try {
      await Sharing.shareAsync(uri, { mimeType, UTI, dialogTitle: i18n.t('imagePreview.share') });
    } catch (error) {
      throw toShareError(error, 'shareFailed');
    }
    return;
  }

  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    throw new ShareVideoError(i18n.t('imagePreview.shareFailed'));
  }

  const urlExt = extensionFromUrl(uri);
  const destination = `${cacheDirectory}${SHARE_TEMP_FILE_PREFIX}${Date.now()}.${urlExt}`;
  const tempFiles: string[] = [destination];
  let fileToShare = destination;
  // Android 上复制到 DCIM 的 MediaStore asset —— 分享结束后延迟删除。
  let asset: MediaLibrary.Asset | null = null;
  try {
    const downloaded = await FileSystem.downloadAsync(uri, destination);
    const { mimeType, UTI } = mimeFromExtension(extensionFromUrl(downloaded.uri));
    if (Platform.OS === 'android') {
      const permission = await MediaLibrary.requestPermissionsAsync(true);
      if (permission.status !== 'granted') {
        throw new ShareVideoError(i18n.t('imagePreview.permissionDenied'));
      }
      asset = await MediaLibrary.createAssetAsync(downloaded.uri);
      fileToShare = `content://media/external/video/media/${asset.id}`;
    } else {
      fileToShare = downloaded.uri;
    }
    await Sharing.shareAsync(fileToShare, { mimeType, UTI, dialogTitle: i18n.t('imagePreview.share') });
  } catch (error) {
    for (const f of tempFiles) {
      await deleteQuietly(f);
    }
    if (asset) {
      await MediaLibrary.deleteAssetsAsync([asset.id]).catch(() => {});
    }
    throw toShareError(error, 'shareFailed');
  }

  // 延迟删除：目标 app 可能在分享面板关闭后才读取文件。
  setTimeout(() => {
    for (const f of tempFiles) {
      void deleteQuietly(f);
    }
    if (asset) {
      void MediaLibrary.deleteAssetsAsync([asset.id]).catch(() => {});
    }
  }, SHARE_TEMP_TTL_MS);
}
