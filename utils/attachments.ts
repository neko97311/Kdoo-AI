import { isWeb } from '@/utils/platform';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { File as FsFile } from 'expo-file-system';
import type { Attachment, WsContentBlock } from '@/types';

// ─── Image Picker ──────────────────────────────────────────

/**
 * Request camera/media-library permissions (mobile only).
 * On web, the browser handles permissions natively.
 */
export async function requestImagePickerPermissions(): Promise<boolean> {
  if (isWeb) return true;

  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== 'granted') {
    console.warn('[Attachments] Media library permission denied');
    return false;
  }
  return true;
}

export async function requestCameraPermissions(): Promise<boolean> {
  if (isWeb) return true;

  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status !== 'granted') {
    console.warn('[Attachments] Camera permission denied');
    return false;
  }
  return true;
}

/** Map an image-picker asset to an Attachment (shared by the gallery pickers). */
function imageAssetToAttachment(asset: ImagePicker.ImagePickerAsset): Attachment {
  const uri = asset.uri;
  const mediaType = asset.mimeType || 'image/jpeg';
  // Use asset.fileName if available (real filename), otherwise generate a readable one
  const name = asset.fileName || `image_${Date.now()}.${mediaType.split('/')[1] || 'jpg'}`;

  return {
    id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'image',
    name,
    uri,
    mediaType,
    size: asset.fileSize || undefined,
  };
}

/**
 * Pick an image from the gallery.
 * Returns an Attachment or null if cancelled.
 */
export async function pickImageFromGallery(): Promise<Attachment | null> {
  const ok = await requestImagePickerPermissions();
  if (!ok) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    base64: false, // we'll read manually via FileSystem for reliability
  });

  if (result.canceled || !result.assets?.length) return null;

  return imageAssetToAttachment(result.assets[0]);
}

/**
 * Pick multiple images from the gallery.
 * Returns an array of Attachments; empty array when cancelled or nothing selected.
 */
export async function pickMultipleImagesFromGallery(): Promise<Attachment[]> {
  const ok = await requestImagePickerPermissions();
  if (!ok) return [];

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    quality: 0.8,
    base64: false, // we'll read manually via FileSystem for reliability
  });

  if (result.canceled || !result.assets?.length) return [];

  return result.assets.map(imageAssetToAttachment);
}

/**
 * Take a photo with the camera.
 */
export async function takePhoto(): Promise<Attachment | null> {
  const ok = await requestCameraPermissions();
  if (!ok) return null;

  const result = await ImagePicker.launchCameraAsync({
    quality: 0.8,
    base64: false,
  });

  if (result.canceled || !result.assets?.length) return null;

  const asset = result.assets[0];
  const uri = asset.uri;
  const mediaType = asset.mimeType || 'image/jpeg';
  // Use asset.fileName if available, otherwise generate a readable one
  const name = asset.fileName || `photo_${Date.now()}.${mediaType.split('/')[1] || 'jpg'}`;

  return {
    id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'image',
    name,
    uri,
    mediaType,
    size: asset.fileSize || undefined,
  };
}

// ─── Document Picker ───────────────────────────────────────

/**
 * Pick a document/file.
 * Returns an Attachment or null if cancelled.
 */
export async function pickDocument(): Promise<Attachment | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
  });

  if (result.canceled || !result.assets?.length) return null;

  const asset = result.assets[0];
  return {
    id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'file',
    name: asset.name,
    uri: asset.uri,
    mediaType: asset.mimeType || 'application/octet-stream',
    size: asset.size || undefined,
  };
}

// ─── Base64 Conversion ─────────────────────────────────────

/**
 * Read a file from disk and convert to base64.
 * Returns a data URI string (e.g. "data:image/png;base64,...").
 */
export async function fileToDataUri(uri: string, mediaType: string): Promise<string> {
  // On web, use fetch + blob + FileReader
  if (isWeb) {
    const response = await fetch(uri);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // On mobile, use the new expo-file-system File API
  const file = new FsFile(uri);
  const base64 = await file.base64();
  return `data:${mediaType};base64,${base64}`;
}

// ─── Convert to WsContentBlock ─────────────────────────────

/**
 * Convert an Attachment to a WsContentBlock for sending via WebSocket.
 * Reads the file and converts to base64.
 */
export async function attachmentToContentBlock(
  attachment: Attachment,
): Promise<WsContentBlock> {
  const dataUri = await fileToDataUri(attachment.uri, attachment.mediaType);

  // WS protocol: all files/images use type 'file', mimeType distinguishes images from other files
  return {
    type: 'file',
    data: dataUri,
    mimeType: attachment.mediaType,
    filename: attachment.name,
  };
}

// ─── Attachment Preview Helpers ────────────────────────────

/** Format file size for display */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Get a display icon name for a file type */
export function getFileIconName(mediaType: string): string {
  if (mediaType.startsWith('image/')) return 'image-outline';
  if (mediaType.startsWith('video/')) return 'videocam-outline';
  if (mediaType.startsWith('audio/')) return 'musical-notes-outline';
  if (mediaType.includes('pdf')) return 'document-text-outline';
  if (mediaType.includes('zip') || mediaType.includes('rar') || mediaType.includes('tar'))
    return 'archive-outline';
  if (mediaType.includes('spreadsheet') || mediaType.includes('excel') || mediaType.includes('csv'))
    return 'grid-outline';
  if (mediaType.includes('presentation') || mediaType.includes('powerpoint'))
    return 'easel-outline';
  if (mediaType.includes('word') || mediaType.includes('document'))
    return 'document-text-outline';
  return 'document-outline';
}
