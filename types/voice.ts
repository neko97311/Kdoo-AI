// TTS 声音管理 - 前端类型契约
// 后端接口文档:
//   - 当前接口契约(用户级偏好合并): D:\w\api_gateways\docs\2026-07-07-tts-voice-user-profile-migration.md
//   - 历史 v1.1 接口:            D:\w\api_gateways\docs\2026-07-06-tts-voice-api-v1.1-app-update.md
// v1.1(2026-07-06):clone 改异步,Voice 新增 5 字段,POST /clone 入参加 ref_text 必填
// v1.2(2026-07-07):Voice 主键统一为 voiceId(=Omni speakerId)。
//                    删 id/name/speaker_id,改用 voiceId+voiceName。

export type VoiceSource = 'system' | 'cloned';
export type Gender = 'male' | 'female' | 'neutral';
/**
 * 克隆音色状态机(v1.1):
 *   pending → processing → success / failed
 * - success: 可用,voiceId 已分配
 * - failed: 保留在 mine 列表,显示 failure_reason + 重试入口
 */
export type CloneStatus = 'pending' | 'processing' | 'success' | 'failed';

export interface Voice {
  /**
   * 全局唯一,可作 React key。
   * - 系统音色:固定枚举值,例 "sys-zh-female-warm"
   * - 克隆音色:成功时 = Omni 引擎 speakerId(后端调用时给定的 name 字段);
   *           pending / processing / failed 时为 null(后端 success 后回填)
   */
  voiceId: string | null;
  /** 展示名。例: "温柔女声" | "我的克隆 #1" */
  voiceName: string;
  source: VoiceSource;
  gender: Gender;
  /**
   * 后端按 voice.language 算好的性别展示文案,前端直接展示,不做 i18n 翻译。
   * 例: en→"Male"/"Female", zh→"男"/"女", pt→"Masculino"/"Feminino"。
   * 可选:老数据或脱机 mock 可能缺失,渲染时降级到不显示。
   */
  genderLabel?: string;
  /** BCP-47 标签，例 "zh-CN" */
  language: string;
  description?: string;
  /** 原始录音音频 URL（克隆音色用户录音的原始文件） */
  originalAudioUrl?: string | null;
  /** 系统音色业务分类标签：recommend / narrator / ... */
  category?: string;
  /** 克隆音色 owner（系统音色无此字段） */
  owner_id?: string;
  /** 克隆音色状态(系统音色无此字段);后端不在 list 中返回 null 时表示不可用 */
  status?: CloneStatus;
  /**
   * 失败原因(status='failed' 时有值)。
   * 格式: `"CODE: human message"`,前端用 toVoiceError 提取 code。
   */
  failure_reason?: string | null;
  /**
   * v1.1 新增:用户录音时念的稿子原文(用于 ASR 对比打分)。
   * 仅克隆音色有值。
   */
  ref_text?: string | null;
  /** v1.1 新增:ASR 识别结果(成功时有值,可能为空字符串表示识别失败) */
  asr_text?: string | null;
  /** v1.1 新增:ASR 打分 [0,1],越高越接近 ref_text。仅 success 时有值 */
  asr_score?: number | null;
  /** ISO8601 */
  created_at?: string;
}

/**
 * key 用作 React list key 的稳定唯一标识。
 * pending/processing 阶段 voiceId 可能为 null(尚未从 Omni 拿到),
 * 这种情况下回退到 created_at,理论上前端不应出现重复(克隆节流+用户不感知)。
 * 若仍冲突,降到 index key(最后兜底,React 只会在 reorder 时报警)。
 */
export function voiceKey(v: Voice, index?: number): string | number {
  if (v.voiceId) return v.voiceId;
  if (v.created_at) return `pending:${v.created_at}`;
  return index ?? Math.random();
}

/**
 * 后端 `/api/user/v1/audio/voices` 固定分组键。
 * 4 组互斥：同一 Voice 仅出现在 1 个组中。
 * - mine: 当前用户的克隆音色
 * - en / zh / pt: 系统音色按语言分桶(en/zh 实际有内容,pt 后端保留空组)
 * 注:性别('male'/'female')是 voice.gender 字段,不再提升为顶级分组。
 */
export type VoiceGroupKey = 'mine' | 'en' | 'zh' | 'pt';

/** 后端 GET 响应结构。 */
export interface GroupedVoices {
  mine: Voice[];
  en: Voice[];
  zh: Voice[];
  pt: Voice[];
}

/**
 * UI 渲染顺序：mine 置首位（用户私有资产最相关），
 * 其余按语言常规排列（葡 / 英 / 中）。修改此处即可联动 UI tabs 与网格切换。
 */
export const VOICE_GROUP_ORDER: readonly VoiceGroupKey[] = [
  'mine',
  'pt',
  'en',
  'zh',
] as const;

export interface UserAudioPreferences {
  /**
   * 用户单选默认音色(= Omni speakerId)。null = 未设置 / 清空（后端使用系统兜底）。
   * v1.2: 后端字段从 default_voice_id 改名为 voice_id(随用户级偏好合并)。
   * WS 合成时不传 voice 字段，后端按此值选择。
   */
  voice_id: string | null;
  /**
   * 默认音色的展示名,前端 UI 用作 hint。
   * 后端同步冗余存储,避免每次显示还要查系统表。
   */
  voice_name?: string | null;
}

export interface UserVoiceQuota {
  /** 默认 3 */
  max_cloned: number;
  /**
   * v1.1: 含 pending / processing / success 的克隆音色数(failed 也算)。
   * 用户反复点击时,pending 占位防堆积。
   */
  cloned_used: number;
}

/**
 * v1.1 删除 CloneTask。POST /clone 立即返回 Voice(包含 voiceId + status='pending'),
 * 前端用 GET /voices 轮询 voiceId 对应 voice 的 status 字段判断处理进度。
 */

/** 后端业务错误码 → 服务层捕获 → UI 分支处理 */
export type VoiceErrorCode =
  | 'VOICE_NOT_FOUND'
  | 'VOICE_FORBIDDEN'
  | 'QUOTA_EXCEEDED'
  | 'INVALID_AUDIO'
  | 'INVALID_PARAMS'
  | 'INTERNAL_ERROR';

/** 自定义错误类，store 层用 instanceof 判定 */
export class VoiceApiError extends Error {
  code: VoiceErrorCode;
  httpStatus?: number;
  constructor(code: VoiceErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'VoiceApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
