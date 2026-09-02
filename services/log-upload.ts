/**
 * Client log archive export and upload service.
 *
 * Reads the persisted JSONL log file, collects device/app metadata,
 * packs them into a zip archive, and uploads to the backend.
 *
 * @module services/log-upload
 */

import {
  cacheDirectory,
  getInfoAsync,
  readAsStringAsync,
  deleteAsync,
} from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import JSZip from 'jszip';

import { api } from '@/services/api';
import { getEntries, LOG_FILE_PATH, type LogEntry, type LogLevel } from '@/utils/logger';

export interface UploadResult {
  uploadId: string;
  filename: string;
  fileSize: number;
  logCount: number;
  createdAt: string;
}

export type UploadPhase = 'reading' | 'packaging' | 'uploading' | 'done' | 'error';

export interface UploadProgress {
  phase: UploadPhase;
  message: string;
}

const API_PATH = '/api/user/v1/client-logs/upload';

function safeJsonlSnapshot(): string {
  const entries = getEntries();
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

async function buildDeviceInfo(): Promise<Record<string, unknown>> {
  return {
    platform: Platform.OS,
    osVersion: Device.osVersion ?? 'unknown',
    modelName: Device.modelName ?? 'unknown',
    brand: Device.brand ?? 'unknown',
    deviceName: Device.deviceName ?? 'unknown',
    isDevice: Device.isDevice,
    appVersion: Constants.expoConfig?.version ?? 'unknown',
    buildVersion: Platform.select({
      ios: Constants.expoConfig?.ios?.buildNumber,
      android: Constants.expoConfig?.android?.versionCode?.toString(),
      default: undefined,
    }) ?? 'unknown',
    applicationId: Platform.select({
      ios: Constants.expoConfig?.ios?.bundleIdentifier,
      android: Constants.expoConfig?.android?.package,
      default: undefined,
    }) ?? 'unknown',
    sessionId: `rn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    capturedAt: new Date().toISOString(),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  // expo-file-system File.write() doesn't accept raw bytes, so we have to
  // route the binary zip through base64.
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunk, bytes.length)),
    );
  }
  return globalThis.btoa(binary);
}

export async function exportLogArchive(
  onProgress?: (p: UploadProgress) => void,
): Promise<{
  zipUri: string;
  zipSize: number;
  logCount: number;
  zipFile: File;
  entries: readonly LogEntry[];
  deviceInfo: Record<string, unknown>;
}> {
  onProgress?.({ phase: 'reading', message: 'Reading local logs...' });

  let logText = '';
  try {
    logText = await readAsStringAsync(LOG_FILE_PATH, { encoding: 'utf8' });
  } catch {
    logText = safeJsonlSnapshot();
  }

  const logCount = logText ? logText.split('\n').filter(Boolean).length : 0;
  const entries = getEntries();

  onProgress?.({ phase: 'packaging', message: 'Packaging zip...' });

  const deviceInfo = await buildDeviceInfo();
  const zip = new JSZip();
  zip.file('logs.jsonl', logText || '');
  zip.file('device.json', JSON.stringify(deviceInfo, null, 2));

  const zipBytes = await zip.generateAsync({ type: 'uint8array' });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `kdoo-log-${timestamp}.zip`;

  // Use the new expo-file-system File API so the instance exposes `.bytes()`,
  // which Expo's fetch FormData pipeline accepts via duck typing (`'bytes' in entry`).
  // The old { uri, name, type } shape used by react-native core throws
  // "Unsupported FormDataPart implementation"; Blob is also rejected on RN
  // ("Creating blobs from ArrayBuffer / ArrayBufferView are not supported").
  const zipFile = new File(Paths.cache, filename);
  zipFile.write(bytesToBase64(zipBytes), { encoding: 'base64' });

  // Fall back to legacy cacheDirectory for cleanup (the new API's URI may differ in scheme).
  const info = await getInfoAsync(zipFile.uri);
  const zipSize = info.exists && 'size' in info ? info.size ?? 0 : 0;

  return { zipUri: zipFile.uri, zipSize, logCount, zipFile, entries, deviceInfo };
}

export async function uploadLogArchive(
  onProgress?: (p: UploadProgress) => void,
): Promise<UploadResult> {
  const { zipUri, zipFile, logCount, entries, deviceInfo } = await exportLogArchive(onProgress);

  onProgress?.({ phase: 'uploading', message: 'Uploading...' });

  const filename = zipUri.split('/').pop() ?? 'logs.zip';
  // Backend reads these as separate multipart fields; without them the server
  // stores logCount = 0 / logLevel = null and deviceInfo = {}, losing diagnostic
  // context. The zip payload already embeds these for archival but the server
  // indexes them from the flat fields for query and admin display.
  const logLevel = computeHighestLevel(entries);
  const result = await api.postMultipart<UploadResult>(
    API_PATH,
    zipFile,
    { filename, logCount: String(logCount), logLevel, device: JSON.stringify(deviceInfo) },
  );

  onProgress?.({ phase: 'done', message: 'Upload complete' });

  try {
    await deleteAsync(zipUri, { idempotent: true });
  } catch {
    // ignore
  }

  return result;
}

function computeHighestLevel(entries: readonly LogEntry[]): string {
  const order: LogLevel[] = ['error', 'warn', 'info', 'debug'];
  for (const level of order) {
    if (entries.some((e) => e.level === level)) return level;
  }
  return 'info';
}
