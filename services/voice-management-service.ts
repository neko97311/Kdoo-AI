// 调后端 6 个 REST 接口，零业务逻辑。
// 后端接口文档(用户级偏好合并):
//   D:\w\api_gateways\docs\2026-07-07-tts-voice-user-profile-migration.md
// 历史 v1.1:
//   D:\w\api_gateways\docs\2026-07-06-tts-voice-api-v1.1-app-update.md
// (v1.1: POST /clone 异步,立即返回 pending Voice,前端轮询 GET /voices 查 status)
// (v1.2: 主键统一为 voiceId + voiceName,无 id/name/speaker_id)
import type { File } from 'expo-file-system';
import { api } from '@/services/api';
import { BASE_URL } from '@/services/api';
import {
  type GroupedVoices,
  type UserAudioPreferences,
  type Voice,
  type UserVoiceQuota,
  type VoiceErrorCode,
  VoiceApiError,
} from '@/types/voice';

/**
 * 解析音频 URL，与 resolveAvatarUrl 逻辑基本一致，但额外支持任意绝对路径：
 *   - 完整 http/https URL → 直接返回
 *   - `/api/user/v1/oss/download/xxx` → prepend BASE_URL
 *   - `api/user/v1/oss/download/xxx` → prepend `/` then BASE_URL
 *   - 其他 `/xxx` 绝对路径（如 `/tts/man1.mp3`） → prepend BASE_URL
 *   - 裸文件名 → 构造 OSS 下载路径
 */
export function resolveAudioUrl(url?: string | null): string {
  if (!url) return '';

  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  const downloadPrefix = '/api/user/v1/oss/download/';

  if (url.startsWith(downloadPrefix)) {
    return `${BASE_URL}${url}`;
  }
  if (url.startsWith('api/user/v1/oss/download/')) {
    return `${BASE_URL}/${url}`;
  }
  // 其他绝对路径（如 /tts/man1.mp3）直接拼 BASE_URL
  if (url.startsWith('/')) {
    return `${BASE_URL}${url}`;
  }
  // 裸文件名 → 当作 OSS key 拼下载路径
  return `${BASE_URL}${downloadPrefix}${url}`;
}

// ── Error code extraction ───────────────────────────────────────

const KNOWN_CODES: ReadonlySet<VoiceErrorCode> = new Set([
  'VOICE_NOT_FOUND',
  'VOICE_FORBIDDEN',
  'QUOTA_EXCEEDED',
  'INVALID_AUDIO',
  'INVALID_PARAMS',
  'INTERNAL_ERROR',
]);

/**
 * 后端错误统一形态: `new Error("CODE: human message")`
 * （api.ts 在 json.code !== '0000' 时抛 `new Error(json.message || ...)`，
 *  假定服务端把 code 拼进 message 字符串前端）。如未来后端改为返回
 *  json.code 字段，把这里改成读 `error.code`。
 */
function toVoiceError(err: unknown): VoiceApiError {
  if (err instanceof VoiceApiError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  for (const code of KNOWN_CODES) {
    if (msg.includes(code)) {
      return new VoiceApiError(code, msg);
    }
  }
  return new VoiceApiError('INTERNAL_ERROR', msg);
}

// ── REST ────────────────────────────────────────────────────────

export async function fetchVoices(): Promise<GroupedVoices> {
  try {
    return await api.get<GroupedVoices>('/api/user/v1/audio/voices');
  } catch (e) {
    throw toVoiceError(e);
  }
}

export async function fetchPreferences(): Promise<UserAudioPreferences> {
  try {
    return await api.get<UserAudioPreferences>('/api/user/v1/audio/preferences');
  } catch (e) {
    throw toVoiceError(e);
  }
}

export async function updatePreferences(
  patch: Partial<UserAudioPreferences>,
): Promise<UserAudioPreferences> {
  try {
    return await api.put<UserAudioPreferences>('/api/user/v1/audio/preferences', patch);
  } catch (e) {
    throw toVoiceError(e);
  }
}

/**
 * v1.1: 后端异步处理,立即返回 voiceId + status='pending'。
 * 前端需把返回的 voice 加入 pending 队列,定时 GET /voices 轮询直到 status 终结。
 * v1.2: pending 时 voiceId 为 null,改用 created_at/owner_id 做本地句柄。
 * refText 必填:用户念的稿子原文,后端 ASR 对比打分用。
 * language: 当前 app 语言(zh/en/pt),传给后端用于按语言挑选 prompt/示例/反馈语种。
 */
export async function submitClone(
  file: File,
  name: string,
  refText: string,
  language: string,
): Promise<Voice> {
  try {
    return await api.postMultipart<Voice>(
      '/api/user/v1/audio/voices/clone',
      file,
      { name, ref_text: refText, language },
    );
  } catch (e) {
    throw toVoiceError(e);
  }
}

export async function deleteVoice(voiceId: string): Promise<void> {
  try {
    await api.delete<{ success: true }>(
      `/api/user/v1/audio/voices/${encodeURIComponent(voiceId)}`,
    );
  } catch (e) {
    throw toVoiceError(e);
  }
}

/**
 * 重命名用户克隆音色(只改展示名 voiceName)。
 *
 * 端点契约:
 *   POST /api/user/v1/audio/voices/:voiceId/rename
 *   路径参数 :voiceId = Omni speakerId(后端按此定位)
 *   Body: { name: string }                 // trim 后非空,长度 1-64
 *   权限:  ownerId === currentUserId AND source === 'cloned'
 *   响应:  { code: "0000" }                 // 仅成功码,不带数据
 *   错误:  api.ts 已统一抛 new Error(json.message);走 toVoiceError 解析错误码
 *
 * 校验:
 *   - 客户端: 非空 + ≤ 64 字符(对齐后端约束)
 *   - 后端二次校验 ownerId + source
 *
 * 为什么 service 不回 Voice:
 *   - 后端契约仅回 { code: "0000" }
 *   - 改名只动 voiceName,前端按 voiceId 在 groupedVoices 里就地改字段即可
 *   - 避免依赖后端字段漂移(asr_score/asr_text 等)
 */
export async function renameVoice(
  voiceId: string,
  name: string,
): Promise<{ code: '0000' }> {
  try {
    return await api.post<{ code: '0000' }>(
      `/api/user/v1/audio/voices/${encodeURIComponent(voiceId)}/rename`,
      { name },
    );
  } catch (e) {
    throw toVoiceError(e);
  }
}

export async function fetchQuota(): Promise<UserVoiceQuota> {
  try {
    return await api.get<UserVoiceQuota>('/api/user/v1/audio/voices/quota');
  } catch (e) {
    throw toVoiceError(e);
  }
}
