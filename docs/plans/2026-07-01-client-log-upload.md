# Client Log Upload — 设计与实施计划

> **For Claude:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 RN 客户端添加日志共通工具和上传入口；在 api_gateways 后端添加接收、存储、查询、下载接口；在管理后台添加列表/详情/下载/删除 UI。

**Architecture:** 三层改造 — (1) RN 端 `utils/logger.ts` 提供轻量日志 API，写入 `expo-file-system` 环形缓冲；(2) `services/log-upload.ts` 把日志+设备信息打包成 zip 上传；(3) `app/debug.tsx` 顶部新增 [上传应用日志] 主行动按钮 + 模态进度面板。后端：Prisma 新增 `ClientLogUpload` 模型，Nitro API 接收 zip 存到 `storageRoot/oss/client-logs/`，提供用户端和管理端两套接口。管理后台：新建 `/admin/client-logs` 路由 + `index.vue` + `[id].vue`。

**Tech Stack:** React Native 0.85, Expo SDK 56, expo-file-system, expo-application, expo-device, jszip (新增依赖), TypeScript 6.0; api_gateways: Nuxt 3, Nitro, Prisma 7 + MySQL, Zod, Vue 3 + Vuetify.

---

## Part 1 — RN 客户端 (kdoo-client)

### Task 1.1: 安装 jszip 依赖

**Files:**
- Modify: `package.json`

**Step 1: 安装依赖**

```bash
cd /Users/admin/sourcecode/6.ai/kdoo-client
pnpm --filter app add jszip
pnpm install
```

**Step 2: 验证 package.json 中有 `"jszip": "^3.10.1"` (或类似版本)**

**Step 3: Commit**

```
chore(kdoo-client): add jszip for log archive
```

---

### Task 1.2: 创建日志共通工具 utils/logger.ts

**Files:**
- Create: `utils/logger.ts`

**Step 1: 创建文件**

```ts
/**
 * Lightweight client-side logger with file persistence.
 *
 * Provides level-based logging (debug/info/warn/error) that mirrors entries
 * to an in-memory ring buffer and a JSONL file under expo-file-system.
 *
 * The buffer is capped at MAX_BUFFER_ENTRIES; oldest entries are dropped.
 * Other modules can read entries via getEntries() for archive/upload flows.
 *
 * Captures unhandled JS errors and promise rejections via ErrorUtils hooks
 * so they land in the same buffer for later upload.
 *
 * @module utils/logger
 */

import * as FileSystem from 'expo-file-system';

const LOG_DIR = `${FileSystem.documentDirectory ?? ''}logs`;
const LOG_FILE = `${LOG_DIR}/kdoo-logs.jsonl`;

const MAX_BUFFER_ENTRIES = 1000;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

const buffer: LogEntry[] = [];

let writeQueue: Promise<void> = Promise.resolve();

function persist(entry: LogEntry): void {
  writeQueue = writeQueue.then(async () => {
    try {
      const dirInfo = await FileSystem.getInfoAsync(LOG_DIR);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(LOG_DIR, { intermediates: true });
      }
      const line = JSON.stringify(entry) + '\n';
      const fileInfo = await FileSystem.getInfoAsync(LOG_FILE);
      if (!fileInfo.exists) {
        await FileSystem.writeAsStringAsync(LOG_FILE, line, { encoding: 'utf8' });
      } else {
        await FileSystem.writeAsStringAsync(LOG_FILE, line, { encoding: 'utf8', append: true });
      }
    } catch {
      // Silent — file persistence is best-effort
    }
  });
}

function record(level: LogLevel, scope: string, message: string, data?: unknown): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    data,
  };

  buffer.push(entry);
  if (buffer.length > MAX_BUFFER_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_BUFFER_ENTRIES);
  }

  persist(entry);

  const consoleFn =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(`[${scope}]`, message, data ?? '');
}

export const logger = {
  debug: (scope: string, message: string, data?: unknown) =>
    record('debug', scope, message, data),
  info: (scope: string, message: string, data?: unknown) =>
    record('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown) =>
    record('warn', scope, message, data),
  error: (scope: string, message: string, data?: unknown) =>
    record('error', scope, message, data),
};

export function getEntries(): readonly LogEntry[] {
  return buffer;
}

export async function clearEntries(): Promise<void> {
  buffer.length = 0;
  await writeQueue;
  try {
    await FileSystem.deleteAsync(LOG_FILE, { idempotent: true });
  } catch {
    // ignore
  }
}

export const LOG_FILE_PATH = LOG_FILE;

// ── Global error capture ──

let hooksInstalled = false;

export function installGlobalErrorHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  const errorUtils = (globalThis as any).ErrorUtils;
  if (errorUtils?.setGlobalHandler) {
    const previous = errorUtils.getGlobalHandler?.();
    errorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
      logger.error('global', error?.message ?? 'Unhandled error', {
        stack: error?.stack,
        isFatal: !!isFatal,
      });
      previous?.(error, isFatal);
    });
  }

  const tracking = (globalThis as any).HermesInternal?.enablePromiseRejectionTracker;
  if (typeof tracking === 'function') {
    tracking({
      allRejections: true,
      onUnhandled: (id: number, error: unknown) => {
        logger.error('promise', `Unhandled rejection #${id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }
}
```

**Step 2: Type check**

```bash
cd /Users/admin/sourcecode/6.ai/kdoo-client/projects/app
pnpm typecheck
```

**Step 3: Commit**

```
feat(kdoo-client): add logger util with file persistence
```

---

### Task 1.3: 在 app/_layout.tsx 装载全局错误钩子

**Files:**
- Modify: `app/_layout.tsx`

**Step 1:** 在 layout 中调用 `installGlobalErrorHooks()`，确保尽早启动：

```tsx
import { installGlobalErrorHooks } from '@/utils/logger';

// At module level or inside the root component's first effect
installGlobalErrorHooks();
```

(具体插入点根据现有 _layout.tsx 结构决定 — 找首个 useEffect 之前调用一次)

**Step 2: Type check**

```bash
pnpm typecheck
```

**Step 3: Commit**

```
feat(kdoo-client): wire logger global error hooks
```

---

### Task 1.4: 扩展 services/api.ts 支持 multipart 上传

**Files:**
- Modify: `services/api.ts`

**Step 1: 在 `api` 对象导出前添加 `postMultipart` 方法**

找到文件底部 `export const api = { ... }` 块，在 `delete` 之后追加：

```ts
async postMultipart<T>(
  path: string,
  file: { uri: string; name: string; type: string },
  fields: Record<string, string> = {},
  options: { headers?: Record<string, string>; _retried?: boolean } = {},
): Promise<T> {
  try {
    await ensureValidToken(path);

    const token = isPublicRoute(path) ? null : await getToken();
    const headers = buildServerHeaders(token, options.headers);

    const formData = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      formData.append(k, v);
    }
    // React Native FormData accepts { uri, name, type } shape
    formData.append('file', file as any);

    let url = `${BASE_URL}${path}`;
    console.log(`[API][${ts()}] REQ MULTIPART POST`, url);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    });

    console.log(`[API][${ts()}] RES MULTIPART`, url, response.status);

    if (response.status === 401) {
      throw new TokenExpiredError();
    }

    if (!response.ok) {
      const text = await response.text();
      console.warn(`[API][${ts()}] ERR MULTIPART`, url, response.status, text);
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    const json = JSON.parse(text);

    if (json.code && json.code !== '0000') {
      throw new Error(json.message || `Error code: ${json.code}`);
    }

    return (json.data ?? json) as T;
  } catch (error) {
    if (error instanceof TokenExpiredError && !options._retried) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        return this.postMultipart<T>(path, file, fields, { ...options, _retried: true });
      }
      return undefined as unknown as T;
    }
    throw error;
  }
},
```

并将整个 `api` 对象改为 `api.postMultipart = postMultipart;` 的合并写法（或保留现有形式，在 `delete` 后插入）。

注意：`FormData` 在 RN 中支持 `{ uri, name, type }` 格式直接 append；`buildServerHeaders` 不要带 `Content-Type` 让 fetch 自动加 multipart boundary。

**Step 2: Type check**

```bash
pnpm typecheck
```

**Step 3: Commit**

```
feat(kdoo-client): add api.postMultipart for file uploads
```

---

### Task 1.5: 创建 services/log-upload.ts

**Files:**
- Create: `services/log-upload.ts`

**Step 1: 创建文件**

```ts
/**
 * Client log archive export and upload service.
 *
 * Reads the persisted JSONL log file, collects device/app metadata,
 * packs them into a zip archive, and uploads to the backend.
 *
 * @module services/log-upload
 */

import * as FileSystem from 'expo-file-system';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import JSZip from 'jszip';

import { api } from '@/services/api';
import { getEntries, LOG_FILE_PATH } from '@/utils/logger';

export interface UploadResult {
  uploadId: string;
  filename: string;
  logCount: number;
}

export interface UploadProgress {
  phase: 'reading' | 'packaging' | 'uploading' | 'done' | 'error';
  message: string;
}

const API_PATH = '/api/user/v1/client-logs/upload';

function safeJsonlSnapshot(): string {
  const entries = getEntries();
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

async function buildDeviceInfo(): Promise<Record<string, unknown>> {
  return {
    platform: Device.osName ?? 'unknown',
    osVersion: Device.osVersion ?? 'unknown',
    modelName: Device.modelName ?? 'unknown',
    brand: Device.brand ?? 'unknown',
    deviceName: Device.deviceName ?? 'unknown',
    isDevice: Device.isDevice,
    appVersion: Application.nativeApplicationVersion ?? 'unknown',
    buildVersion: Application.nativeBuildVersion ?? 'unknown',
    applicationId: Application.applicationId ?? 'unknown',
    sessionId: `rn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    capturedAt: new Date().toISOString(),
  };
}

export async function exportLogArchive(
  onProgress?: (p: UploadProgress) => void,
): Promise<{ zipUri: string; zipSize: number; logCount: number }> {
  onProgress?.({ phase: 'reading', message: 'Reading local logs...' });

  let logText = '';
  try {
    logText = await FileSystem.readAsStringAsync(LOG_FILE_PATH, { encoding: 'utf8' });
  } catch {
    logText = safeJsonlSnapshot();
  }

  const logCount = logText ? logText.split('\n').filter(Boolean).length : 0;

  onProgress?.({ phase: 'packaging', message: 'Packaging zip...' });

  const zip = new JSZip();
  zip.file('logs.jsonl', logText || '');
  zip.file('device.json', JSON.stringify(await buildDeviceInfo(), null, 2));

  const base64 = await zip.generateAsync({ type: 'base64' });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipPath = `${FileSystem.cacheDirectory ?? ''}kdoo-log-${timestamp}.zip`;
  await FileSystem.writeAsStringAsync(zipPath, base64, { encoding: 'base64' });
  const info = await FileSystem.getInfoAsync(zipPath);
  const zipSize = info.exists && 'size' in info ? info.size ?? 0 : 0;

  return { zipUri: zipPath, zipSize, logCount };
}

export async function uploadLogArchive(
  onProgress?: (p: UploadProgress) => void,
): Promise<UploadResult> {
  const { zipUri, logCount } = await exportLogArchive(onProgress);

  onProgress?.({ phase: 'uploading', message: 'Uploading...' });

  const filename = zipUri.split('/').pop() ?? 'logs.zip';
  const result = await api.postMultipart<UploadResult>(API_PATH, {
    uri: zipUri,
    name: filename,
    type: 'application/zip',
  });

  onProgress?.({ phase: 'done', message: 'Upload complete' });

  // Best-effort cleanup of cache file
  try {
    await FileSystem.deleteAsync(zipUri, { idempotent: true });
  } catch {
    // ignore
  }

  return result;
}
```

**Step 2: Type check**

```bash
pnpm typecheck
```

**Step 3: Commit**

```
feat(kdoo-client): add log archive export and upload service
```

---

### Task 1.6: 在 debug.tsx 顶部添加 [上传应用日志] 主行动按钮 + 模态进度面板

**Files:**
- Modify: `app/debug.tsx`

**Step 1: 添加导入**

在文件顶部 import 区追加：

```tsx
import { uploadLogArchive, type UploadProgress } from '@/services/log-upload';
```

并添加 `Modal` 到 react-native import：

```tsx
import { Modal } from 'react-native';
```

**Step 2: 在组件顶部添加 state**

在现有 `useState` 之后追加：

```tsx
const [uploadState, setUploadState] = useState<
  { open: boolean; progress: UploadProgress | null; error: string | null }
>({ open: false, progress: null, error: null });
```

**Step 3: 添加 handler**

在现有 handler 区附近：

```tsx
const handleUploadLogs = async () => {
  setUploadState({ open: true, progress: { phase: 'reading', message: 'Starting...' }, error: null });
  try {
    await uploadLogArchive((p) => setUploadState((s) => ({ ...s, progress: p })));
    setUploadState((s) => ({ ...s, progress: { phase: 'done', message: 'Upload complete' } }));
    setTimeout(() => setUploadState({ open: false, progress: null, error: null }), 1500);
  } catch (e: any) {
    setUploadState((s) => ({
      ...s,
      progress: null,
      error: e?.message ?? 'Upload failed',
    }));
  }
};
```

**Step 4: 在 "Open Dev Menu" 按钮区块之后插入新的主行动按钮区块**（在 `</View>` 之后，"App Info Section" 之前）

```tsx
{/* Upload Client Logs — primary action */}
<View className="mt-4 px-5">
  <Pressable
    className="w-full flex-row items-center justify-center gap-2 p-4 rounded-xl bg-emerald-600"
    onPress={handleUploadLogs}
  >
    <Ionicons name="cloud-upload" size={20} color="#fff" />
    <Text className="text-white font-semibold text-base">
      {t('debug.uploadLogs')}
    </Text>
  </Pressable>
  <Text className="mt-2 text-xs text-center text-[#464554] dark:text-[#9a99a9]">
    {t('debug.uploadLogsHint')}
  </Text>
</View>
```

**Step 5: 在 `ScrollView` 之前（在最外层 `View` 末尾、`<ScrollView>` 闭合标签之外但内层 `</View>` 之前的位置）添加模态框**

找一个合适位置（外层 `View` 内部，`ScrollView` 之后）插入：

```tsx
<Modal
  visible={uploadState.open}
  transparent
  animationType="fade"
  onRequestClose={() => setUploadState({ open: false, progress: null, error: null })}
>
  <View className="flex-1 items-center justify-center bg-black/50">
    <View className="w-80 bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 border border-[#c7c4d7] dark:border-[#2a2b2f]">
      {uploadState.error ? (
        <>
          <Ionicons name="alert-circle" size={48} color="#dc2626" style={{ alignSelf: 'center' }} />
          <Text className="text-center mt-4 text-base font-semibold text-[#191c1e] dark:text-[#e6e8ea]">
            {t('debug.uploadFailed')}
          </Text>
          <Text className="text-center mt-2 text-xs text-[#464554] dark:text-[#9a99a9]">
            {uploadState.error}
          </Text>
          <Pressable
            className="mt-4 p-3 rounded-xl bg-[#0b6bcb]"
            onPress={() => setUploadState({ open: false, progress: null, error: null })}
          >
            <Text className="text-white text-center font-semibold">OK</Text>
          </Pressable>
        </>
      ) : (
        <>
          {uploadState.progress?.phase !== 'done' && (
            <ActivityIndicator size="large" color="#0b6bcb" style={{ alignSelf: 'center' }} />
          )}
          {uploadState.progress?.phase === 'done' && (
            <Ionicons name="checkmark-circle" size={48} color="#10b981" style={{ alignSelf: 'center' }} />
          )}
          <Text className="text-center mt-4 text-base font-medium text-[#191c1e] dark:text-[#e6e8ea]">
            {uploadState.progress?.message ?? t('debug.uploadLogs')}
          </Text>
          {uploadState.progress?.phase === 'done' && (
            <Text className="text-center mt-2 text-xs text-green-600">
              {t('debug.uploadSuccess')}
            </Text>
          )}
        </>
      )}
    </View>
  </View>
</Modal>
```

**Step 6: 添加 i18n 键**

修改 i18n 文件，在 `debug` 命名空间下添加：

```json
"uploadLogs": "上传应用日志",
"uploadLogsHint": "将本地日志打包上传到服务器（仅用于排查问题）",
"uploadFailed": "上传失败",
"uploadSuccess": "上传成功"
```

(en/zh/pt 三个语言文件同步添加，按现有 AGENTS.md 规范)

**Step 7: Type check**

```bash
pnpm typecheck
```

**Step 8: Commit**

```
feat(kdoo-client): add upload-logs button and progress modal to debug page
```

---

## Part 2 — 后端 api_gateways

### Task 2.1: 新增 Prisma 模型 ClientLogUpload

**Files:**
- Modify: `plugins/database/prisma/schema.prisma`

**Step 1:** 在 schema.prisma 末尾追加 model：

```prisma
model ClientLogUpload {
  id              String    @id @default(cuid())
  userId          String    @db.VarChar(25) @map("user_id")
  deviceInfo      Json      @map("device_info")
  ipAddress       String?   @db.VarChar(64) @map("ip_address")
  fileName        String    @db.VarChar(255) @map("file_name")
  filePath        String    @db.VarChar(512) @map("file_path")
  fileSize        Int       @map("file_size")
  logCount        Int       @default(0) @map("log_count")
  logLevel        String?   @db.VarChar(16) @map("log_level")
  timeRangeStart  DateTime? @map("time_range_start")
  timeRangeEnd    DateTime? @map("time_range_end")
  creatorId       String?   @db.VarChar(25) @map("creator_id")
  creatorName     String?   @map("creator_name")
  updaterId       String?   @db.VarChar(25) @map("updater_id")
  updaterName     String?   @map("updater_name")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  deletedAt       DateTime? @map("deleted_at")

  @@index([userId])
  @@index([createdAt])
  @@map("client_log_uploads")
}
```

**Step 2: 生成 Prisma client + 创建 migration**

```bash
cd /Users/admin/sourcecode/6.ai/api_gateways
pnpm prisma:generate
pnpm prisma:migrate --name add_client_log_uploads
```

**Step 3: Commit**

```
feat(api_gateways): add ClientLogUpload prisma model
```

---

### Task 2.2: 创建 DAO

**Files:**
- Create: `plugins/claw-admin-api/src/runtime/server/dao/admin/client-log.dao.ts`

**Step 1: 创建文件**

```ts
import { PrismaClient, type ClientLogUpload } from '@your-org/nuxt-database/prisma/client';

export class ClientLogDao {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<ClientLogUpload | null> {
    return this.prisma.clientLogUpload.findUnique({ where: { id } });
  }

  async findMany(options?: {
    skip?: number;
    take?: number;
    where?: Record<string, any>;
    orderBy?: Record<string, any>;
  }): Promise<ClientLogUpload[]> {
    return this.prisma.clientLogUpload.findMany({
      where: { deletedAt: null, ...(options?.where ?? {}) },
      skip: options?.skip,
      take: options?.take,
      orderBy: options?.orderBy || { createdAt: 'desc' },
    });
  }

  async count(where?: Record<string, any>): Promise<number> {
    return this.prisma.clientLogUpload.count({
      where: { deletedAt: null, ...(where ?? {}) },
    });
  }

  async create(data: Omit<ClientLogUpload, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>): Promise<ClientLogUpload> {
    return this.prisma.clientLogUpload.create({ data });
  }

  async softDelete(id: string): Promise<void> {
    await this.prisma.clientLogUpload.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
```

**Step 2:** 在 `plugins/claw-admin-api/src/runtime/server/dao/admin/index.ts`（如不存在则新建）导出：

```ts
export { ClientLogDao } from './client-log.dao';
```

并在 `service/admin/index.ts` 顶部导入。

**Step 3: Commit**

```
feat(api_gateways): add ClientLogDao
```

---

### Task 2.3: 创建 Service

**Files:**
- Create: `plugins/claw-admin-api/src/runtime/server/service/admin/client-log.service.ts`

**Step 1: 创建文件**

```ts
import { ClientLogDao } from '#dao/admin/client-log.dao';
import { mkdir, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'node:path';
import { getConfig } from '@your-org/mastra/config';
import { logger } from '@your-org/mastra/logger';

export interface CreateClientLogInput {
  userId: string;
  deviceInfo: Record<string, unknown>;
  ipAddress?: string;
  fileName: string;
  fileBuffer: Buffer;
  logCount: number;
  logLevel?: string;
  timeRangeStart?: Date;
  timeRangeEnd?: Date;
}

export interface ClientLogListItem {
  id: string;
  userId: string;
  deviceInfo: Record<string, unknown>;
  ipAddress: string | null;
  fileName: string;
  fileSize: number;
  logCount: number;
  logLevel: string | null;
  timeRangeStart: Date | null;
  timeRangeEnd: Date | null;
  createdAt: Date;
}

export class ClientLogService {
  constructor(private readonly dao: ClientLogDao) {}

  private storageRoot(): string {
    const root = getConfig().agent?.storageRoot;
    if (!root) throw new Error('storageRoot is not configured');
    return root;
  }

  private dateSegment(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  async saveUpload(input: CreateClientLogInput): Promise<ClientLogListItem> {
    const id = `clog_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const dir = path.join(
      this.storageRoot(),
      'oss',
      'client-logs',
      this.dateSegment(),
      input.userId,
    );
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const safeName = input.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
    const filePath = path.join(dir, `${id}_${safeName}`);
    await writeFile(filePath, input.fileBuffer);

    const record = await this.dao.create({
      id,
      userId: input.userId,
      deviceInfo: input.deviceInfo as any,
      ipAddress: input.ipAddress ?? null,
      fileName: input.fileName,
      filePath,
      fileSize: input.fileBuffer.length,
      logCount: input.logCount,
      logLevel: input.logLevel ?? null,
      timeRangeStart: input.timeRangeStart ?? null,
      timeRangeEnd: input.timeRangeEnd ?? null,
      creatorId: input.userId,
      creatorName: input.userId,
      updaterId: input.userId,
      updaterName: input.userId,
    });

    logger.info('[ClientLog] Saved upload', { id, userId: input.userId, size: input.fileBuffer.length });
    return this.toListItem(record);
  }

  async list(options: {
    page: number;
    pageSize: number;
    userId?: string;
    search?: string;
  }): Promise<{ items: ClientLogListItem[]; total: number }> {
    const where: any = {};
    if (options.userId) where.userId = options.userId;
    if (options.search) {
      where.OR = [
        { fileName: { contains: options.search } },
        { userId: { contains: options.search } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.dao.findMany({
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
        where,
        orderBy: { createdAt: 'desc' },
      }),
      this.dao.count(where),
    ]);

    return { items: rows.map((r) => this.toListItem(r)), total };
  }

  async findById(id: string): Promise<ClientLogListItem | null> {
    const row = await this.dao.findById(id);
    return row ? this.toListItem(row) : null;
  }

  async getFilePath(id: string): Promise<{ path: string; fileName: string } | null> {
    const row = await this.dao.findById(id);
    if (!row) return null;
    return { path: row.filePath, fileName: row.fileName };
  }

  async softDelete(id: string): Promise<void> {
    const row = await this.dao.findById(id);
    if (row) {
      try {
        await unlink(row.filePath);
      } catch {
        // ignore — file may already be gone
      }
    }
    await this.dao.softDelete(id);
  }

  private toListItem(row: any): ClientLogListItem {
    return {
      id: row.id,
      userId: row.userId,
      deviceInfo: row.deviceInfo,
      ipAddress: row.ipAddress,
      fileName: row.fileName,
      fileSize: row.fileSize,
      logCount: row.logCount,
      logLevel: row.logLevel,
      timeRangeStart: row.timeRangeStart,
      timeRangeEnd: row.timeRangeEnd,
      createdAt: row.createdAt,
    };
  }
}
```

**Step 2:** 在 `service/admin/index.ts` 注册 `ClientLogService`（参考现有 lazy proxy 模式）。

**Step 3: Commit**

```
feat(api_gateways): add ClientLogService
```

---

### Task 2.4: 创建 Zod Schema

**Files:**
- Create: `plugins/claw-admin-api/src/runtime/server/config/schemas/client-log.schema.ts`

**Step 1: 创建文件**

```ts
import { z } from 'zod';

export const clientLogListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  userId: z.string().optional(),
});

export const clientLogDeviceInfoSchema = z.record(z.string(), z.unknown());
```

**Step 2:** 在 `config/schemas/index.ts` 中导出。

**Step 3: Commit**

```
feat(api_gateways): add client-log zod schemas
```

---

### Task 2.5: 用户端上传接口

**Files:**
- Create: `plugins/claw-admin-api/src/runtime/server/api/user/v1/client-logs/upload.post.ts`

**Step 1: 创建文件**

```ts
/**
 * User-facing client log upload endpoint.
 * Accepts multipart/form-data with fields:
 *   - file: zip archive (logs.jsonl + device.json inside)
 *   - device: JSON string of device info
 *   - logCount: number string
 *   - logLevel: optional severity hint
 *
 * @module api/user/v1/client-logs/upload
 */
import { readMultipartFormData } from 'h3';
import { ClientLogService } from '#service/admin/client-log.service';
import { ClientLogDao } from '#dao/admin/client-log.dao';
import { getUserIdFromAuth } from '#utils/auth';

const MAX_SIZE = 50 * 1024 * 1024; // 50MB

export default defineAuthenticatedHandler(async (event) => {
  const userId = await getUserIdFromAuth(event);

  const formData = await readMultipartFormData(event);
  if (!formData || formData.length === 0) {
    throw new ValidationError('No form data provided', { businessCode: '2000' });
  }

  const fileField = formData.find((f) => f.name === 'file');
  if (!fileField || !fileField.data) {
    throw new ValidationError('File is required', { businessCode: '2000' });
  }

  const buffer = Buffer.isBuffer(fileField.data)
    ? fileField.data
    : Buffer.from(fileField.data);

  if (buffer.length > MAX_SIZE) {
    throw new ValidationError('File exceeds 50MB limit', { businessCode: '2000' });
  }

  const filename = fileField.filename || `client-log-${Date.now()}.zip`;
  if (!filename.toLowerCase().endsWith('.zip')) {
    throw new ValidationError('Only .zip archives are accepted', { businessCode: '2000' });
  }

  const deviceStr = formData.find((f) => f.name === 'device')?.data?.toString('utf-8');
  let deviceInfo: Record<string, unknown> = {};
  try {
    deviceInfo = deviceStr ? JSON.parse(deviceStr) : {};
  } catch {
    throw new ValidationError('Invalid device JSON', { businessCode: '2000' });
  }

  const logCount = Number(formData.find((f) => f.name === 'logCount')?.data?.toString('utf-8')) || 0;
  const logLevel = formData.find((f) => f.name === 'logLevel')?.data?.toString('utf-8');

  const ipAddress =
    (event.node.req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    event.node.req.socket?.remoteAddress ||
    undefined;

  const service = new ClientLogService(new ClientLogDao(prisma));
  const result = await service.saveUpload({
    userId,
    deviceInfo,
    ipAddress,
    fileName: filename,
    fileBuffer: buffer,
    logCount,
    logLevel,
  });

  return createSuccessResponse(result, 'Log archive uploaded');
});
```

**Step 2: Commit**

```
feat(api_gateways): add user client-log upload endpoint
```

---

### Task 2.6: 用户端历史列表

**Files:**
- Create: `plugins/claw-admin-api/src/runtime/server/api/user/v1/client-logs/index.get.ts`

**Step 1: 创建文件**

```ts
import { ClientLogService } from '#service/admin/client-log.service';
import { ClientLogDao } from '#dao/admin/client-log.dao';
import { getUserIdFromAuth } from '#utils/auth';
import { clientLogListQuerySchema } from '#config/schemas/index';

export default defineAuthenticatedHandler(async (event) => {
  const userId = await getUserIdFromAuth(event);
  const query = getValidatedQuery(event, clientLogListQuerySchema.parse);

  const service = new ClientLogService(new ClientLogDao(prisma));
  const { items, total } = await service.list({
    page: query.page,
    pageSize: query.pageSize,
    userId,
  });

  return createPaginatedResponse(
    items,
    {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
      hasNext: query.page * query.pageSize < total,
      hasPrev: query.page > 1,
    },
    'Client logs retrieved',
  );
});
```

**Step 2: Commit**

```
feat(api_gateways): add user client-log list endpoint
```

---

### Task 2.7: 管理员接口（CRUD）

**Files:**
- Create: `plugins/claw-admin-api/src/runtime/server/api/admin/client-logs/index.get.ts`
- Create: `plugins/claw-admin-api/src/runtime/server/api/admin/client-logs/index.post.ts`
- Create: `plugins/claw-admin-api/src/runtime/server/api/admin/client-logs/[id]/index.get.ts`
- Create: `plugins/claw-admin-api/src/runtime/server/api/admin/client-logs/[id]/index.delete.ts`
- Create: `plugins/claw-admin-api/src/runtime/server/api/admin/client-logs/[id]/download.get.ts`

**Step 1:** 列表（管理员全量）

`api/admin/client-logs/index.get.ts`:
```ts
import { clientLogService } from '#service/admin/index';
import { clientLogListQuerySchema } from '#config/schemas/index';

export default defineEventHandlerWithAuth(
  [Roles.admin],
  [Modules.Notifications],
  async event => {
    const query = getValidatedQuery(event, clientLogListQuerySchema.parse);
    const result = await clientLogService.list(query);

    return createPaginatedResponse(
      result.items,
      {
        page: query.page,
        pageSize: query.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / query.pageSize),
        hasNext: query.page * query.pageSize < result.total,
        hasPrev: query.page > 1,
      },
      'Client logs retrieved',
    );
  },
);
```

**Step 2:** 详情

`api/admin/client-logs/[id]/index.get.ts`:
```ts
import { clientLogService } from '#service/admin/index';

export default defineEventHandlerWithAuth(
  [Roles.admin],
  [Modules.Notifications],
  async event => {
    const id = getRouterParam(event, 'id');
    if (!id) throw new ValidationError('Missing id', { businessCode: '2000' });
    const item = await clientLogService.findById(id);
    if (!item) throw new ApiError('Not found', '5000', ErrorType.NOT_FOUND);
    return createSuccessResponse(item, 'Client log retrieved');
  },
);
```

**Step 3:** 下载

`api/admin/client-logs/[id]/download.get.ts`:
```ts
import { clientLogService } from '#service/admin/index';
import { createReadStream, existsSync } from 'fs';
import { stat } from 'fs/promises';

export default defineEventHandlerWithAuth(
  [Roles.admin],
  [Modules.Notifications],
  async event => {
    const id = getRouterParam(event, 'id');
    if (!id) throw new ValidationError('Missing id', { businessCode: '2000' });
    const file = await clientLogService.getFilePath(id);
    if (!file || !existsSync(file.path)) {
      throw new ApiError('File not found', '5000', ErrorType.NOT_FOUND);
    }
    const stats = await stat(file.path);
    setHeader(event, 'Content-Type', 'application/zip');
    setHeader(event, 'Content-Disposition', `attachment; filename="${file.fileName}"`);
    setHeader(event, 'Content-Length', String(stats.size));
    return sendStream(event, createReadStream(file.path));
  },
);
```

**Step 4:** 删除

`api/admin/client-logs/[id]/index.delete.ts`:
```ts
import { clientLogService } from '#service/admin/index';

export default defineEventHandlerWithAuth(
  [Roles.admin],
  [Modules.Notifications],
  async event => {
    const id = getRouterParam(event, 'id');
    if (!id) throw new ValidationError('Missing id', { businessCode: '2000' });
    await clientLogService.softDelete(id);
    return createSuccessResponse({ id }, 'Client log deleted');
  },
);
```

**Step 5: Commit**

```
feat(api_gateways): add admin client-log CRUD endpoints
```

---

### Task 2.8: 注册 Module 常量

**Files:**
- Modify: `plugins/claw-admin-api/src/runtime/server/utils/auth.ts`

**Step 1:** 在 `Modules` 对象中添加 `ClientLogs`：

```ts
export const Modules = {
  // ...existing
  ClientLogs: 'client-logs',
};
```

并在 `ModuleArrays` 同步添加 `'client-logs'`。

**Step 2: Commit**

```
chore(api_gateways): register ClientLogs module constant
```

---

## Part 3 — 管理后台 UI

### Task 3.1: 添加 API composable

**Files:**
- Create: `projects/playground/app/apis/admin/client-logs.ts`

**Step 1:** 参考 `dashboard.ts` 的写法创建 composable：

```ts
export interface ClientLog {
  id: string;
  userId: string;
  deviceInfo: Record<string, unknown>;
  ipAddress: string | null;
  fileName: string;
  fileSize: number;
  logCount: number;
  logLevel: string | null;
  timeRangeStart: string | null;
  timeRangeEnd: string | null;
  createdAt: string;
}

export interface ClientLogListResponse {
  items: ClientLog[];
  total: number;
}

export const useClientLogsApi = () => {
  const api = useApi();
  const { error: showErrorToast } = useToast();

  return {
    list: async (params: { page: number; pageSize: number; search?: string; userId?: string }): Promise<ClientLogListResponse> => {
      const res = await api.get<ClientLogListResponse>('/api/admin/client-logs', { params });
      if (res.code !== DefaultBussinessCode.SUCCESS) {
        showErrorToast(res.message);
        throw new Error(res.message);
      }
      return res.data as any;
    },

    get: async (id: string): Promise<ClientLog> => {
      const res = await api.get<ClientLog>(`/api/admin/client-logs/${id}`);
      if (res.code !== DefaultBussinessCode.SUCCESS) throw new Error(res.message);
      return res.data as any;
    },

    remove: async (id: string): Promise<void> => {
      const res = await api.delete<{ id: string }>(`/api/admin/client-logs/${id}`);
      if (res.code !== DefaultBussinessCode.SUCCESS) throw new Error(res.message);
    },

    downloadUrl: (id: string): string => `/api/admin/client-logs/${id}/download`,
  };
};
```

(根据实际 `useApi` 响应包装做相应调整 — 参考 `apis/admin/dashboard.ts` 实际签名)

**Step 2: Commit**

```
feat(api_gateways-web): add client-logs admin api composable
```

---

### Task 3.2: 注册路由 + 菜单

**Files:**
- Modify: `plugins/claw-web/src/module.ts`

**Step 1:** 在 `pages.push({...})` 列表中添加（参考 tokens 路由写法）：

```ts
pages.push({
  name: 'admin-client-logs',
  path: `${prefix}/admin/client-logs`,
  file: resolver.resolve('./runtime/app/pages/admin/client-logs/index.vue'),
  meta: { layout: 'admin', requiresAuth: true },
});
pages.push({
  name: 'admin-client-logs-id',
  path: `${prefix}/admin/client-logs/:id`,
  file: resolver.resolve('./runtime/app/pages/admin/client-logs/[id].vue'),
  meta: { layout: 'admin', requiresAuth: true },
});
```

**Step 2: 在侧边栏菜单配置（找到现有 menus 注册位置）添加 `client-logs` 菜单项**

参考 admin tokens 菜单配置：

```ts
{
  title: 'Client Logs',
  icon: 'mdi-file-document-multiple',
  to: '/admin/client-logs',
}
```

**Step 3: Commit**

```
feat(api_gateways-web): register client-logs admin route
```

---

### Task 3.3: 创建列表页 index.vue

**Files:**
- Create: `plugins/claw-web/src/runtime/app/pages/admin/client-logs/index.vue`

**Step 1:** 参考 `pages/admin/tokens/index.vue` 的 v-data-table-server 模式实现：

```vue
<template>
  <div>
    <div class="d-flex align-center mb-6">
      <h1 class="text-h4">{{ $t('nav.clientLogs') }}</h1>
      <v-spacer />
    </div>

    <v-card>
      <v-card-text class="pb-0">
        <v-row class="mb-2">
          <v-col cols="12" sm="6" md="4">
            <v-text-field
              v-model="searchQuery"
              :label="$t('actions.search')"
              prepend-inner-icon="mdi-magnify"
              density="compact"
              variant="outlined"
              hide-details
              clearable
              @keyup.enter="onSearch"
            />
          </v-col>
          <v-col cols="12" sm="6" md="4">
            <v-text-field
              v-model="userIdFilter"
              :label="$t('clientLogs.userId')"
              density="compact"
              variant="outlined"
              hide-details
              clearable
              @keyup.enter="onSearch"
            />
          </v-col>
        </v-row>
      </v-card-text>

      <v-data-table-server
        :headers="headers"
        :items="items"
        :loading="loading"
        :items-per-page="pageSize"
        :items-length="total"
        :items-per-page-options="[10, 20, 50]"
        @update:options="onOptions"
      >
        <template #item.userId="{ item }">
          <span class="font-mono text-xs">{{ item.userId }}</span>
        </template>
        <template #item.deviceInfo="{ item }">
          <span class="text-xs">
            {{ item.deviceInfo?.platform ?? '-' }} {{ item.deviceInfo?.osVersion ?? '' }}
            / {{ item.deviceInfo?.modelName ?? '-' }}
          </span>
        </template>
        <template #item.fileSize="{ item }">
          {{ formatSize(item.fileSize) }}
        </template>
        <template #item.createdAt="{ item }">
          {{ new Date(item.createdAt).toLocaleString() }}
        </template>
        <template #item.actions="{ item }">
          <v-btn icon="mdi-eye" size="small" variant="text" @click="view(item)" />
          <v-btn icon="mdi-download" size="small" variant="text" color="primary" @click="download(item)" />
          <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="remove(item)" />
        </template>
      </v-data-table-server>
    </v-card>

    <!-- Detail dialog -->
    <v-dialog v-model="showDetail" max-width="700">
      <v-card>
        <v-card-title>{{ $t('clientLogs.detail') }}</v-card-title>
        <v-card-text>
          <pre class="text-xs" style="max-height: 60vh; overflow: auto;">{{ JSON.stringify(selected, null, 2) }}</pre>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showDetail = false">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
const clientLogsApi = useClientLogsApi();
const { success, error } = useToast();

const items = ref<any[]>([]);
const total = ref(0);
const loading = ref(false);
const page = ref(1);
const pageSize = ref(20);
const searchQuery = ref('');
const userIdFilter = ref('');

const showDetail = ref(false);
const selected = ref<any>(null);

const headers = [
  { title: 'ID', key: 'id', sortable: false },
  { title: 'User', key: 'userId' },
  { title: 'Device', key: 'deviceInfo', sortable: false },
  { title: 'File', key: 'fileName' },
  { title: 'Size', key: 'fileSize' },
  { title: 'Logs', key: 'logCount' },
  { title: 'Uploaded', key: 'createdAt' },
  { title: '', key: 'actions', sortable: false, width: 150 },
];

async function fetchData() {
  loading.value = true;
  try {
    const res = await clientLogsApi.list({
      page: page.value,
      pageSize: pageSize.value,
      search: searchQuery.value || undefined,
      userId: userIdFilter.value || undefined,
    });
    items.value = res.items;
    total.value = res.total;
  } catch (e: any) {
    error(e.message ?? 'Load failed');
  } finally {
    loading.value = false;
  }
}

function onOptions(opts: any) {
  page.value = opts.page;
  pageSize.value = opts.itemsPerPage;
  fetchData();
}

function onSearch() {
  page.value = 1;
  fetchData();
}

function view(item: any) {
  selected.value = item;
  showDetail.value = true;
}

async function download(item: any) {
  const url = clientLogsApi.downloadUrl(item.id);
  window.open(url, '_blank');
}

async function remove(item: any) {
  if (!confirm(`Delete log ${item.id}?`)) return;
  try {
    await clientLogsApi.remove(item.id);
    success('Deleted');
    fetchData();
  } catch (e: any) {
    error(e.message ?? 'Delete failed');
  }
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

onMounted(fetchData);
</script>
```

**Step 2: Commit**

```
feat(api_gateways-web): add client-logs list page
```

---

### Task 3.4: 创建详情页 [id].vue

**Files:**
- Create: `plugins/claw-web/src/runtime/app/pages/admin/client-logs/[id].vue`

**Step 1:** 简单详情页（显示日志 JSON 元数据 + 下载按钮）：

```vue
<template>
  <div>
    <v-btn variant="text" prepend-icon="mdi-arrow-left" @click="$router.back()">
      Back
    </v-btn>
    <h1 class="text-h4 mb-4">Client Log {{ id }}</h1>
    <v-card v-if="item">
      <v-card-text>
        <v-row>
          <v-col cols="6"><strong>User:</strong> {{ item.userId }}</v-col>
          <v-col cols="6"><strong>File:</strong> {{ item.fileName }}</v-col>
          <v-col cols="6"><strong>Size:</strong> {{ formatSize(item.fileSize) }}</v-col>
          <v-col cols="6"><strong>Logs:</strong> {{ item.logCount }}</v-col>
          <v-col cols="6"><strong>IP:</strong> {{ item.ipAddress ?? '-' }}</v-col>
          <v-col cols="6"><strong>Uploaded:</strong> {{ new Date(item.createdAt).toLocaleString() }}</v-col>
        </v-row>
        <v-divider class="my-4" />
        <h3 class="text-h6 mb-2">Device Info</h3>
        <pre class="text-xs bg-gray-100 dark:bg-gray-800 p-3 rounded">{{ JSON.stringify(item.deviceInfo, null, 2) }}</pre>
        <v-btn
          class="mt-4"
          color="primary"
          prepend-icon="mdi-download"
          :href="clientLogsApi.downloadUrl(item.id)"
          target="_blank"
        >
          Download zip
        </v-btn>
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
const route = useRoute();
const id = route.params.id as string;
const clientLogsApi = useClientLogsApi();
const { error } = useToast();
const item = ref<any>(null);

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

onMounted(async () => {
  try {
    item.value = await clientLogsApi.get(id);
  } catch (e: any) {
    error(e.message ?? 'Load failed');
  }
});
</script>
```

**Step 2: Commit**

```
feat(api_gateways-web): add client-logs detail page
```

---

### Task 3.5: i18n

**Files:**
- Modify: `plugins/claw-web/src/lang/en.json`
- Modify: `plugins/claw-web/src/lang/zh.json`
- Modify: `plugins/claw-web/src/lang/pt.json`

**Step 1:** 同步在三个文件中添加：

```json
{
  "nav": {
    "clientLogs": "Client Logs"
  },
  "clientLogs": {
    "userId": "User ID",
    "detail": "Log Detail",
    "uploadTime": "Upload Time"
  }
}
```

中文：`"clientLogs": "客户端日志"`、`"userId": "用户 ID"`、`"detail": "日志详情"`
葡萄牙语：`"clientLogs": "Registros do Cliente"` 等

**Step 2: Commit**

```
feat(api_gateways-web): add client-logs i18n keys
```

---

## Part 4 — 验证

### Task 4.1: 类型检查

```bash
# RN 端
cd /Users/admin/sourcecode/6.ai/kdoo-client/projects/app && pnpm typecheck

# 后端
cd /Users/admin/sourcecode/6.ai/api_gateways && pnpm test:types
```

### Task 4.2: 启动 dev server 验证

```bash
# 后端
cd /Users/admin/sourcecode/6.ai/api_gateways && pnpm dev

# RN 端
cd /Users/admin/sourcecode/6.ai/kdoo-client && pnpm dev
```

### Task 4.3: 端到端手动验证

1. 在管理后台 `/admin/login` 用 admin 账号登录
2. 在管理后台侧边栏确认看到 "Client Logs"
3. 启动 RN 应用（iOS/Android/Web 任一）
4. 进入 debug 页面
5. 点击 [上传应用日志]，观察模态进度 → 成功
6. 回到管理后台 `/admin/client-logs`，确认出现新条目
7. 点击 [查看] → 详情页正常
8. 点击 [下载] → 浏览器下载 zip
9. 解压 zip 确认包含 `logs.jsonl` + `device.json`
10. 点击 [删除] → 列表移除

---

## 待讨论 / Discussion

- [ ] **下载认证 cookie vs bearer**：管理后台使用 cookie session，目前下载用 `window.open` 浏览器原生发送 cookie 应该没问题，需验证。如果失败可改 `<a download>` + blob 方案。
- [ ] **JSZip 体积**：约 100KB gzipped，对 RN 包体积影响可接受。如需更小可换 `react-native-zip-archive` 原生方案。
- [ ] **存储增长**：用户上传日志累积可能撑爆磁盘。后续可加 cleanup 任务删除 30 天前的记录。本次不实现。
- [ ] **大文件分块**：当前单次上传 50MB 上限。若客户端日志长期增长到几十 MB 可考虑分块上传。本次不实现。
