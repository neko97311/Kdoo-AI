import { isWeb } from '@/utils/platform';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File as FsFile, UploadType } from 'expo-file-system';
import type { Attachment, WsContentBlock } from '@/types';

const AUTH_STORAGE_KEY = 'auth_storage';

/**
 * OSS upload endpoint.
 * POST multipart/form-data with field 'file'.
 * Max file size: 50 MB.
 */
const UPLOAD_ENDPOINT = '/api/user/v1/oss/upload';

async function getToken(): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return parsed.token || null;
    }
  } catch {}
  return null;
}

/**
 * Upload a file via the OSS service.
 *
 * Platform-specific upload strategy:
 *   - Mobile (iOS/Android): expo-file-system's native File.upload() handles
 *     multipart natively at the OS level, bypassing RN's broken FormData.
 *   - Web (browser): Standard fetch + FormData with File/Blob.
 *
 * @param uri       Local file URI
 * @param mediaType MIME type (e.g. 'image/png', 'application/pdf')
 * @param filename  Original filename
 * @returns         The uploaded file's URL path
 *
 * Expected response format:
 *   { code: "0000", message: "File uploaded successfully", data: { url: "/api/user/v1/oss/download/<fileId>.jpg", filename: "...", mimeType: "...", size: 123456 } }
 */
export async function uploadFile(
  uri: string,
  mediaType: string,
  filename: string,
): Promise<string> {
  const token = await getToken();

  const baseUrl =
    process.env.EXPO_PUBLIC_API_URL || 'https://api.example.com';
  const url = `${baseUrl}${UPLOAD_ENDPOINT}`;

  console.log('[Upload] Uploading file:', filename, mediaType);

  if (isWeb) {
    // Web: standard FormData + fetch
    const formData = new FormData();
    const response = await fetch(uri);
    const blob = await response.blob();
    const file = new File([blob], filename, { type: mediaType });
    formData.append('file', file);

    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload failed (${res.status}): ${text}`);
    }

    return parseUploadResponse(await res.json());
  } else {
    // Mobile: use expo-file-system's native multipart upload.
    // React Native's FormData polyfill is broken in the new architecture
    // (SDK 56+): { uri, type, name } → "Unsupported FormDataPart implementation".
    // File.upload() handles multipart natively at the OS level.
    //
    // ImagePicker on Android returns content:// URIs which FsFile.copySync
    // cannot handle (scoped storage restriction). Skip the copy and upload
    // directly from the source URI — the server gets the filename from the
    // multipart field name / mime type headers.
    const uploadHeaders: Record<string, string> = {};
    if (token) {
      uploadHeaders['Authorization'] = `Bearer ${token}`;
    }

    const srcFile = new FsFile(uri);

    const uploadResult = await srcFile.upload(url, {
      httpMethod: 'POST',
      uploadType: UploadType.MULTIPART,
      fieldName: 'file',
      mimeType: mediaType,
      headers: uploadHeaders,
    });

    if (uploadResult.status < 200 || uploadResult.status >= 300) {
      throw new Error(
        `Upload failed (${uploadResult.status}): ${uploadResult.body}`,
      );
    }

    const result = JSON.parse(uploadResult.body);
    return parseUploadResponse(result);
  }
}

function parseUploadResponse(result: any): string {
  // Handle standard response format: { code: "0000", data: { url: "..." } }
  if (result.code === '0000' && result.data) {
    return result.data.url || result.data;
  }

  // Fallback: try direct fields
  if (result.url) return result.url;
  if (result.data?.url) return result.data.url;

  console.warn('[Upload] Unexpected response format:', JSON.stringify(result).slice(0, 200));
  throw new Error('Upload failed: unexpected response format');
}

/**
 * Convert an Attachment to a WsContentBlock by uploading the file first,
 * then using the returned URL instead of base64 data.
 *
 * Falls back to base64 if the upload fails (network error, not auth).
 */
export async function attachmentToContentBlockWithUpload(
  attachment: Attachment,
): Promise<WsContentBlock> {
  // 远程 URL(http/https)已是服务端可访问的 OSS 资源(聊天消息图片,
  // 经 authImageSource 加过 token),无需也不应再走本地上传 —— 移动端
  // FsFile.upload() 无法处理 http URI,Web 端则会多一次跨域下载+转存。
  // 直接用该 URL 生成与上传成功路径完全一致的 file 块(file:// 附件仍走
  // 下方原有上传逻辑,保持不变)。渲染侧 case 'file' 的图片分支会照常吃它。
  if (/^https?:\/\//i.test(attachment.uri)) {
    return {
      type: 'file',
      data: attachment.uri,
      mimeType: attachment.mediaType,
      filename: attachment.name,
    };
  }

  try {
    const url = await uploadFile(attachment.uri, attachment.mediaType, attachment.name);

    // WS protocol: all files/images use type 'file', mimeType distinguishes images from other files
    return {
      type: 'file',
      data: url,
      mimeType: attachment.mediaType,
      filename: attachment.name,
    };
  } catch (err: any) {
    // Upload failed — fall back to base64 data URI
    console.warn('[Upload] Upload failed, falling back to base64:', err.message);
    const { attachmentToContentBlock } = await import('@/utils/attachments');
    return attachmentToContentBlock(attachment);
  }
}
