import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import { i18n } from '@/i18n';

/**
 * 保存到相册的业务错误 —— message 已是完整的本地化句子，
 * UI 层可直接展示（不要再加"保存失败:"之类的前缀）。
 * UI 层用 instanceof 区分"已知错误"与未知异常。
 */
export class SaveImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveImageError';
  }
}

// ─── Helpers ───────────────────────────────────────────────

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/**
 * 把底层错误转成可直接展示的 SaveImageError。
 * 原始错误信息本身是中文（如系统本地化后的提示）时原样保留，
 * 否则收敛为 i18n 键对应的本地化文案。
 */
function toSaveError(error: unknown, fallbackKey: 'saveFailed' | 'downloadFailed'): SaveImageError {
  const message = error instanceof Error ? error.message : String(error);
  return new SaveImageError(
    containsChinese(message) ? message : i18n.t(`imagePreview.${fallbackKey}`),
  );
}

/** 从远程 URL 的路径部分取扩展名（去掉 query/hash），异常时兜底 jpg。 */
function extensionFromUrl(uri: string): string {
  const lastSegment = uri.split(/[?#]/)[0]?.split('/').pop() ?? '';
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(lastSegment);
  return match?.[1]?.toLowerCase() ?? 'jpg';
}

// ─── Save to album ─────────────────────────────────────────

/**
 * 把图片保存到系统相册。
 *
 * 入参可能是本地 `file://` URI（拍照/相册选择），也可能是带鉴权 query
 * 的 http(s) URL（聊天消息图片，已由 authImageSource 解析过 token）。
 * 本地 URI 直接入库；远程 URL 先下载到缓存目录再入库，`finally` 里清理临时文件。
 *
 * 纯工具函数 —— 不触发触感反馈，UI 层自行处理成功/失败反馈。
 * 抛出的业务错误均为 SaveImageError（message 已本地化，可直接展示）。
 */
export async function saveImageToAlbum(uri: string): Promise<void> {
  // writeOnly=true: iOS 只请求"添加照片"权限(NSPhotoLibraryAddUsageDescription)。
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (permission.status !== 'granted') {
    throw new SaveImageError(i18n.t('imagePreview.permissionDenied'));
  }

  // 本地文件直接入库，无需下载。
  if (uri.startsWith('file://') || uri.startsWith('/')) {
    try {
      await MediaLibrary.saveToLibraryAsync(uri);
    } catch (error) {
      throw toSaveError(error, 'saveFailed');
    }
    return;
  }

  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    throw new SaveImageError(i18n.t('imagePreview.saveFailed'));
  }

  const destination = `${cacheDirectory}kdoo-img-${Date.now()}.${extensionFromUrl(uri)}`;
  let stage: 'download' | 'save' = 'download';
  try {
    const downloaded = await FileSystem.downloadAsync(uri, destination);
    stage = 'save';
    await MediaLibrary.saveToLibraryAsync(downloaded.uri);
  } catch (error) {
    throw toSaveError(error, stage === 'download' ? 'downloadFailed' : 'saveFailed');
  } finally {
    // 临时文件清理属于"收尾的收尾"：相册副本已入库，删除失败不应让保存报错。
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
  }
}
