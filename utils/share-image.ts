import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library/legacy';
import { Platform } from 'react-native';
import { i18n } from '@/i18n';

/**
 * 分享图片的业务错误 —— message 已是完整的本地化句子，
 * UI 层可直接展示（不要再加"分享失败:"之类的前缀）。
 * UI 层用 instanceof 区分"已知错误"与未知异常。
 */
export class ShareImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareImageError';
  }
}

// ─── Helpers ───────────────────────────────────────────────

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/**
 * 把底层错误转成可直接展示的 ShareImageError。
 * 原始错误信息本身是中文（如系统本地化后的提示）时原样保留，
 * 否则收敛为 i18n 键对应的本地化文案。
 */
function toShareError(error: unknown, fallbackKey: 'shareFailed' | 'downloadFailed'): ShareImageError {
  const message = error instanceof Error ? error.message : String(error);
  return new ShareImageError(
    containsChinese(message) ? message : i18n.t(`imagePreview.${fallbackKey}`),
  );
}

/** 从远程 URL 的路径部分取扩展名（去掉 query/hash），异常时兜底 jpg。 */
function extensionFromUrl(uri: string): string {
  const lastSegment = uri.split(/[?#]/)[0]?.split('/').pop() ?? '';
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(lastSegment);
  return match?.[1]?.toLowerCase() ?? 'jpg';
}

/** 按扩展名推断 MIME 类型与 iOS UTI，未知扩展名一律按 jpeg 处理。 */
function mimeFromExtension(ext: string): { mimeType: string; UTI: string } {
  switch (ext) {
    case 'png':
      return { mimeType: 'image/png', UTI: 'public.png' };
    case 'gif':
      return { mimeType: 'image/gif', UTI: 'com.compuserve.gif' };
    case 'webp':
      return { mimeType: 'image/webp', UTI: 'org.webmproject.webp' };
    case 'bmp':
      return { mimeType: 'image/bmp', UTI: 'com.microsoft.bmp' };
    case 'avif':
      return { mimeType: 'image/avif', UTI: 'public.avif' };
    default:
      return { mimeType: 'image/jpeg', UTI: 'public.jpeg' };
  }
}

/**
 * 读文件头 12 字节匹配魔数签名，返回真实扩展名。
 * 比 URL 扩展名可靠 —— 聊天图片 URL 常无扩展名或被 query 截断，
 * 仅靠扩展名猜 mimeType 会让严格校验的接收方（如百度浏览器）拒收。
 * 任何异常或签名不匹配都返回 null，调用方兜底走 extensionFromUrl。
 */
async function detectExtFromHeader(uri: string): Promise<string | null> {
  try {
    const b64 = await FileSystem.readAsStringAsync(uri, {
      length: 12,
      position: 0,
      encoding: FileSystem.EncodingType.Base64,
    });
    const bin = atob(b64);
    const b = (i: number) => bin.charCodeAt(i);
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'png';
    // JPEG: FF D8 FF
    if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpg';
    // GIF: 47 49 46 38 (GIF8)
    if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return 'gif';
    // BMP: 42 4D (BM)
    if (b(0) === 0x42 && b(1) === 0x4d) return 'bmp';
    // WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50 (RIFF....WEBP)
    if (
      b(0) === 0x52 &&
      b(1) === 0x49 &&
      b(2) === 0x46 &&
      b(3) === 0x46 &&
      b(8) === 0x57 &&
      b(9) === 0x45 &&
      b(10) === 0x42 &&
      b(11) === 0x50
    ) {
      return 'webp';
    }
    return null;
  } catch {
    return null;
  }
}

// ─── 临时文件管理 ────────────────────────────────────────────

/** 分享临时文件前缀；文件名中内嵌创建时间戳（Date.now()），清理时反解。 */
const SHARE_TEMP_FILE_PREFIX = 'kdoo-share-';

/**
 * 分享临时文件保留时长。
 *
 * Android 上分享面板的 promise 在用户选中目标 app 的瞬间就 resolve ——
 * 不等目标 app 读完文件。冷启动慢的目标（如百度浏览器）会晚几秒才去
 * 读 content:// 文件，立即删除会让它读到已被删除的文件（微信秒读所以不受影响）。
 * 因此成功分享后延迟删除，并在下次分享时清理残留的过期文件
 * （兜底 app 中途关闭、延迟任务没跑到的情况）。
 */
const SHARE_TEMP_TTL_MS = 5 * 60 * 1000;

async function deleteQuietly(uri: string): Promise<void> {
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

/** 清理缓存目录里过期的 kdoo-share-* 临时文件；尽力而为，不抛错。 */
async function cleanupExpiredShareTempFiles(): Promise<void> {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) return;
  try {
    const names = await FileSystem.readDirectoryAsync(cacheDirectory);
    const pattern = new RegExp(`^${SHARE_TEMP_FILE_PREFIX}(\\d+)\\.`);
    for (const name of names) {
      const match = pattern.exec(name);
      if (!match || Date.now() - Number(match[1]) <= SHARE_TEMP_TTL_MS) continue;
      await deleteQuietly(cacheDirectory + name);
    }
  } catch {
    // 清理失败不影响分享主流程
  }
}

// ─── Share ─────────────────────────────────────────────────

/**
 * 调起系统分享面板分享图片。
 *
 * 入参可能是本地 `file://` URI（拍照/相册选择），也可能是带鉴权 query
 * 的 http(s) URL（聊天消息图片，已由 authImageSource 解析过 token）。
 * 本地 URI 直接送入分享面板；远程 URL 先下载到缓存目录再分享。
 *
 * **Android 兼容性**：老浏览器（百度/UC）靠 content:// URI 的 `_data` 列解析
 * 真实文件路径。FileProvider URI 不暴露 `_data` 列 → 它们拿不到路径 → 显示空白；
 * MediaStore URI（`content://media/external/images/media/{id}`）的 `_data` 列
 * 暴露 `/storage/emulated/0/DCIM/...` 公共路径，老浏览器能读，微信等现代 app
 * 走 openInputStream 同样支持。所以 Android 上先 `MediaLibrary.createAssetAsync`
 * 把图复制到 DCIM，再分享该 asset 的 MediaStore content URI。
 * expo-sharing 原生只收 file:// scheme，content:// 支持由
 * patches/expo-sharing@57.0.8.patch 提供（pnpm-workspace.yaml patchedDependencies）。
 * 副作用：图会短暂进相册，SHARE_TEMP_TTL_MS（5 分钟）后自动删除该 asset。
 * deleteAssetsAsync 原生对"自己创建的 asset"本可静默直删，但 expo-media-library
 * 的前置权限检查误判会弹系统删除确认框 —— 该误判已由
 * patches/expo-media-library@56.0.10.patch 修复（先静默删、失败才回退确认框）。
 * 需 MediaLibrary 权限（跟保存到相册相同），未授权抛 ShareImageError。
 *
 * 临时文件在分享结束后**延迟**删除 —— 目标 app 可能在分享面板关闭后
 * 才读取文件，详见 SHARE_TEMP_TTL_MS。
 *
 * 用户在分享面板里点"取消"不算错误 —— expo-sharing 在这种情况下正常
 * resolve（无返回值），本函数也正常 resolve，UI 层无需做任何反馈。
 *
 * 纯工具函数 —— 不触发触感反馈，UI 层自行处理成功/失败反馈。
 * 抛出的业务错误均为 ShareImageError（message 已本地化，可直接展示）。
 */
export async function shareImage(uri: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new ShareImageError(i18n.t('imagePreview.shareFailed'));
  }

  // 本地文件直接送入分享面板，无需下载。
  if (uri.startsWith('file://') || uri.startsWith('/')) {
    // 读文件头确定真实类型，URL 扩展名仅作兜底 ——
    // 严格校验的接收方（如百度浏览器）会因 mimeType 与文件头不符而拒收。
    const detectedExt = await detectExtFromHeader(uri);
    const realExt = detectedExt ?? extensionFromUrl(uri);
    const { mimeType, UTI } = mimeFromExtension(realExt);
    try {
      await Sharing.shareAsync(uri, {
        mimeType,
        UTI,
        dialogTitle: i18n.t('imagePreview.share'),
      });
    } catch (error) {
      throw toShareError(error, 'shareFailed');
    }
    return;
  }

  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    throw new ShareImageError(i18n.t('imagePreview.shareFailed'));
  }

  // 顺手清理上次遗留的过期临时文件（fire-and-forget，不阻塞分享）。
  void cleanupExpiredShareTempFiles();

  const urlExt = extensionFromUrl(uri);
  const destination = `${cacheDirectory}${SHARE_TEMP_FILE_PREFIX}${Date.now()}.${urlExt}`;
  let stage: 'download' | 'createAsset' | 'share' = 'download';
  // 临时文件可能因重命名产生多个路径，统一收集清理。
  const tempFiles: string[] = [destination];
  let fileToShare = destination;
  // Android 上复制到 DCIM 的 MediaStore asset —— 分享结束后延迟 5 分钟删除（见文末 setTimeout）。
  let asset: MediaLibrary.Asset | null = null;
  try {
    const downloaded = await FileSystem.downloadAsync(uri, destination);
    // 下载后读文件头确定真实类型，URL 扩展名仅作兜底。
    const detectedExt = await detectExtFromHeader(downloaded.uri);
    const realExt = detectedExt ?? urlExt;
    const { mimeType, UTI } = mimeFromExtension(realExt);
    // 真实扩展名与下载时用的不同 → 重命名让文件名扩展名与 mimeType 一致，
    // 避免接收方同时校验文件名扩展名和 mimeType 时因不一致而拒收。
    if (detectedExt && realExt !== urlExt) {
      const renamed = `${cacheDirectory}${SHARE_TEMP_FILE_PREFIX}${Date.now()}.${realExt}`;
      await FileSystem.moveAsync({ from: downloaded.uri, to: renamed });
      fileToShare = renamed;
      tempFiles.push(renamed);
    } else {
      fileToShare = downloaded.uri;
    }
    // Android 上复制到 DCIM（公共目录），分享该 asset 的 **MediaStore content URI**
    //（content://media/external/images/media/{id}）：它的 `_data` 列暴露真实路径
    // /storage/emulated/0/DCIM/...，用 _data 列解析 URI 的老浏览器（百度/UC）能读到；
    // 微信等现代 app 用 openInputStream(contentUri)，MediaStore 同样支持。
    // ⚠️ 不能分享 asset.uri（file://...）—— expo-sharing 会把它转成 FileProvider URI，
    // FileProvider 不暴露 _data 列，老浏览器解析不出路径 → 显示空白。
    // expo-sharing 原生只收 file:// scheme，content:// 支持由 patches/ 的补丁提供。
    if (Platform.OS === 'android') {
      stage = 'createAsset';
      const permission = await MediaLibrary.requestPermissionsAsync(true);
      if (permission.status !== 'granted') {
        throw new ShareImageError(i18n.t('imagePreview.permissionDenied'));
      }
      asset = await MediaLibrary.createAssetAsync(fileToShare);
      fileToShare = `content://media/external/images/media/${asset.id}`;
    }
    stage = 'share';
    await Sharing.shareAsync(fileToShare, {
      mimeType,
      UTI,
      dialogTitle: i18n.t('imagePreview.share'),
    });
  } catch (error) {
    // TODO(临时诊断，分享稳定后删除)：expo kotlin 层异常不打 logcat，这里输出便于定位。
    console.error('[share-image] share failed at stage=', stage, error);
    // 失败：目标 app 没启动，临时缓存文件和 MediaStore asset 都可立即删除。
    for (const f of tempFiles) {
      await deleteQuietly(f);
    }
    if (asset) {
      await MediaLibrary.deleteAssetsAsync([asset.id]).catch(() => {});
    }
    throw toShareError(error, stage === 'download' ? 'downloadFailed' : 'shareFailed');
  }

  // ⚠️ 不能立即删：Android 上 choose 面板的 promise 在用户选中目标 app 的瞬间
  // 就 resolve，冷启动慢的目标（如百度浏览器）可能还在读文件。延迟删除，
  // 过期后再由 cleanupExpiredShareTempFiles 兜底清理缓存文件。
  // DCIM 里的 MediaStore asset 同样延迟删（此时目标已读完）。
  setTimeout(() => {
    for (const f of tempFiles) {
      void deleteQuietly(f);
    }
    if (asset) {
      void MediaLibrary.deleteAssetsAsync([asset.id]).catch(() => {});
    }
  }, SHARE_TEMP_TTL_MS);
}
