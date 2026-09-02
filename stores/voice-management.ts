// TTS 声音管理 - 中央 store（唯一真理源）
// 后端接口文档(用户级偏好合并):
//   D:\w\api_gateways\docs\2026-07-07-tts-voice-user-profile-migration.md
// 历史 v1.1: D:\w\api_gateways\docs\2026-07-06-tts-voice-api-v1.1-app-update.md
import { create } from 'zustand';
import type { File } from 'expo-file-system';

import {
  fetchVoices,
  fetchPreferences,
  updatePreferences,
  submitClone as submitCloneService,
  deleteVoice as deleteVoiceService,
  renameVoice as renameVoiceService,
  fetchQuota,
} from '@/services/voice-management-service';

import type {
  GroupedVoices,
  UserAudioPreferences,
  UserVoiceQuota,
  Voice,
} from '@/types/voice';
import { voiceKey } from '@/types/voice';

const DEFAULT_PREFERENCES: UserAudioPreferences = {
  voice_id: null,
};

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 30;

type MultipartFile = File;

interface CloneTask {
  voiceId: string;
  attempts: number;
  timer: ReturnType<typeof setInterval>;
}

export interface VoiceManagementState {
  // 数据
  groupedVoices: GroupedVoices;
  preferences: UserAudioPreferences;
  quota: UserVoiceQuota | null;

  // 标志
  voicesLoaded: boolean;
  preferencesLoaded: boolean;
  mutating: boolean;

  // Actions
  loadVoices: () => Promise<void>;
  loadPreferences: () => Promise<void>;
  loadQuota: () => Promise<void>;
  setDefaultVoice: (id: string | null) => Promise<void>;
  submitClone: (file: MultipartFile, name: string, refText: string, language: string) => Promise<Voice>;
  startPollingClone: (voiceOrVoice: string | Voice) => string | null;
  stopPollingClone: (voiceId: string) => void;
  stopAllPolling: () => void;
  deleteVoice: (id: string) => Promise<void>;
  /**
   * 重命名用户克隆音色。后端只回 `{ success: true }`,
   * 前端按 voiceId 在分组里就地改 voiceName 字段,
   * 其他字段(asr_score/asr_text/ref_text 等)保留本地已有的最新值。
   */
  renameVoice: (id: string, name: string) => Promise<{ id: string; name: string }>;
  refreshAll: () => Promise<void>;
}

// 模块级轮询表（跨组件实例共享）
const pollTimers: Map<string, CloneTask> = (() => {
  const m = new Map<string, CloneTask>();
  if (typeof globalThis !== 'undefined') {
    (globalThis as any).__VOICE_POLL_TIMERS__ = m;
  }
  return m;
})();

function findVoiceGroup(
  grouped: GroupedVoices,
  voiceId: string,
): keyof GroupedVoices | null {
  for (const key of ['mine', 'en', 'zh', 'pt'] as const) {
    if (grouped[key].some((v) => v.voiceId === voiceId)) return key;
  }
  return null;
}

export const useVoiceManagementStore = create<VoiceManagementState>()(
  (set, get) => ({
      groupedVoices: { mine: [], en: [], zh: [], pt: [] },
      preferences: { ...DEFAULT_PREFERENCES },
      quota: null,

      voicesLoaded: false,
      preferencesLoaded: false,
      mutating: false,

      async loadVoices() {
        const grouped = await fetchVoices();
        console.log('[voice-settings] fetchVoices ok', {
          mineCount: grouped.mine.length,
          enCount: grouped.en.length,
          zhCount: grouped.zh.length,
          ptCount: grouped.pt.length,
        });
        set({ groupedVoices: grouped, voicesLoaded: true });
      },

      async loadPreferences() {
        const prefs = await fetchPreferences();
        set({
          preferences: prefs,
          preferencesLoaded: true,
        });
      },

      async loadQuota() {
        const q = await fetchQuota();
        set({ quota: q });
      },

      async setDefaultVoice(id) {
        // 不变量: 非 null 时必须在 4 个分组集合内
        if (id !== null) {
          const g = get().groupedVoices;
          // v1.2: 过滤 pending(voiceId=null)。业务上不会拿 pending voiceId 来设置默认音色。
          const knownIds = new Set<string>(
            [
              ...g.mine.map((v) => v.voiceId),
              ...g.en.map((v) => v.voiceId),
              ...g.zh.map((v) => v.voiceId),
              ...g.pt.map((v) => v.voiceId),
            ].filter((v): v is string => v !== null),
          );
          if (!knownIds.has(id)) {
            throw new Error(`voice id not found in voices cache: ${id}`);
          }
        }

        const previous = get().preferences.voice_id;
        // 乐观更新
        set({
          preferences: { voice_id: id },
          mutating: true,
        });
        try {
          const saved = await updatePreferences({ voice_id: id });
          set({ preferences: saved });
        } catch (e) {
          // 回滚
          set({ preferences: { voice_id: previous } });
          throw e;
        } finally {
          set({ mutating: false });
        }
      },

      async submitClone(file, name, refText, language) {
        const pending = await submitCloneService(file, name, refText, language);
        // [F] 乐观推 pending voice 进 mine 列表 —— 用户提交后立刻能看到"训练中",
        // 不必等下一次 polling tick(3s 后)。后端 response 已经包含 status/created_at
        // 等元数据,直接 patch 进 groupedVoices.mine 头部。
        // 后续 polling tick 拉到的真实数据会通过 loadVoices 整体替换,这里
        // 的乐观项会自动被 reconcile(因为 voiceKey 相同)。
        const pollKey = get().startPollingClone(pending);
        // 把后端返回的 pending 项插到 mine 头部(避免覆盖已有的同 voiceId 项)。
        if (pollKey) {
          set((state) => {
            const exists = state.groupedVoices.mine.some(
              (v) => v.voiceId === pending.voiceId || voiceKey(v) === voiceKey(pending),
            );
            if (exists) return state;
            return {
              groupedVoices: {
                ...state.groupedVoices,
                mine: [pending, ...state.groupedVoices.mine],
              },
            };
          });
        }
        return pending;
      },

      startPollingClone(voiceOrVoice: string | Voice) {
        // 统一轮询键:有 voiceId 用 voiceId;否则用 `${owner_id}:${created_at}`。
        // 这把"启动时用 null voiceId 创建 polling"和"tick 内部扫 mine 项"两条
        // 路径合并到同一个 key 空间,避免历史上 null vs `local:...` 对不上的 bug。
        const pollKey =
          typeof voiceOrVoice === 'string'
            ? voiceOrVoice
            : voiceOrVoice.voiceId ??
              `${voiceOrVoice.owner_id ?? 'anon'}:${voiceOrVoice.created_at ?? ''}`;
        if (!pollKey) return null;

        // 已在轮询则不重复启动
        if (pollTimers.has(pollKey)) return pollKey;

        const tick = async () => {
          const task = pollTimers.get(pollKey);
          if (!task) return;
          task.attempts += 1;
          try {
            await get().loadVoices();
            const grouped = get().groupedVoices;
            // 用 pollKey 统一匹配:可能在 mine 列表里(无论是否已经回填 voiceId),
            // 也可能在某个 locale 分组里(后端回填后挪位置?实际不会,但保留兼容)。
            const mineItem = grouped.mine.find((v) => {
              if (v.voiceId) return v.voiceId === pollKey;
              return `${v.owner_id ?? 'anon'}:${v.created_at ?? ''}` === pollKey;
            });
            const groupKey = mineItem
              ? 'mine'
              : findVoiceGroup(grouped, pollKey);
            if (groupKey) {
              const voice = mineItem ?? grouped[groupKey].find((v) => v.voiceId === pollKey);
              if (voice && (voice.status === 'success' || voice.status === 'failed')) {
                get().stopPollingClone(pollKey);
                return;
              }
            } else if (task.attempts >= POLL_MAX_ATTEMPTS) {
              // 一直没找到对应 voice(可能用户删了),最多轮询到上限后停止。
              get().stopPollingClone(pollKey);
              return;
            }
            if (task.attempts >= POLL_MAX_ATTEMPTS) {
              get().stopPollingClone(pollKey);
            }
          } catch {
            // 单次失败不中断轮询,继续下一次
          }
        };

        const timer = setInterval(tick, POLL_INTERVAL_MS);
        pollTimers.set(pollKey, { voiceId: pollKey, attempts: 0, timer });
        return pollKey;
      },

      stopPollingClone(voiceId) {
        const task = pollTimers.get(voiceId);
        if (task) {
          clearInterval(task.timer);
          pollTimers.delete(voiceId);
        }
      },

      stopAllPolling() {
        for (const [, task] of pollTimers) {
          clearInterval(task.timer);
        }
        pollTimers.clear();
      },

      async deleteVoice(id) {
        // 悲观删除:先发请求,成功后再改本地
        await deleteVoiceService(id);
        const g = get().groupedVoices;
        const next: GroupedVoices = {
          mine: g.mine.filter((v) => v.voiceId !== id),
          en: g.en.filter((v) => v.voiceId !== id),
          zh: g.zh.filter((v) => v.voiceId !== id),
          pt: g.pt.filter((v) => v.voiceId !== id),
        };
        // 后端已联动清 voice_id,前端仅在本地 cache 中同步
        const prefs = { ...get().preferences };
        if (prefs.voice_id === id) {
          prefs.voice_id = null;
        }
        set({
          groupedVoices: next,
          preferences: prefs,
        });
      },

      async renameVoice(id, name) {
        // 悲观更新:先发请求,成功后用入参直接覆盖本地 voiceName 字段。
        // 后端只回 success,不回 Voice 对象——避免字段漂移(asr_score/asr_text
        // 等可能在不同时间点不同步)。其他字段全部保留本地已有的最新值。
        await renameVoiceService(id, name);
        const g = get().groupedVoices;
        const patchOne = (list: Voice[]) =>
          list.map((v) => (v.voiceId === id ? { ...v, voiceName: name } : v));
        const next: GroupedVoices = {
          mine: patchOne(g.mine),
          en: patchOne(g.en),
          zh: patchOne(g.zh),
          pt: patchOne(g.pt),
        };
        // 同步默认音色 hint(若该音色正好是用户默认)
        const prefs = { ...get().preferences };
        if (prefs.voice_id === id) {
          prefs.voice_name = name;
        }
        set({
          groupedVoices: next,
          preferences: prefs,
        });
        return { id, name };
      },

      async refreshAll() {
        await Promise.allSettled([
          get().loadVoices(),
          get().loadPreferences(),
          get().loadQuota(),
        ]);
      },
    }),
);

// 挂载时(冷启动 / 重新进入声音页)检查 mine 分组里的 pending voice,自动恢复轮询.
// 在 voice-settings 获得焦点时调用,无需 UI 改动.
// 关键点:store 是 zustand 全局单例,但 useFocusEffect 之前被 if(voicesLoaded) 早返
// 卡住,导致用户离开页面后再回来,AppState 切到后台被 stopAllPolling 杀掉的轮询
// 永远没人重启。修复:每次 focus 都跑一遍这个,把仍在 pending/processing 的项
// 重新挂回 pollTimers(已经存在的会被去重)。
// v1.3: 统一使用 `voiceId ?? ${owner_id}:${created_at}` 作为轮询键,
// 和 submitClone / startPollingClone 内部一致。
export function resumePendingPolling(): void {
  const grouped = useVoiceManagementStore.getState().groupedVoices;
  for (const v of grouped.mine) {
    if (v.status === 'pending' || v.status === 'processing') {
      useVoiceManagementStore.getState().startPollingClone(v);
    }
  }
}
