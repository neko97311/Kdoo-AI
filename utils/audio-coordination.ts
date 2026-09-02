/**
 * Audio channel coordination: music (react-native-track-player) vs TTS read-aloud.
 *
 * 音乐与 TTS 是两条完全独立的音频通道（RNTP 的系统播放器 vs
 * react-native-audio-api 的 AudioContext），无人协调时会同时出声。
 * 本模块提供统一的 "duck"（让路）协议，双方各自遵守：
 *
 *   1. TTS 开播 → 音乐若在 Playing 则暂停并记忆（duck）；
 *      TTS 结束 → 恢复被 duck 的音乐。（stores/tts.ts 负责调用）
 *   2. 音乐主动开始（用户点卡片 / 通知栏恢复 / 新结果自动播放）→
 *      TTS 整体停止。由音乐侧在启动前调用 releaseMusicDuck() +
 *      useTtsStore.stopTtsPlayback() 完成（MusicCardList / PlaybackService）。
 *
 * 设计要点：
 *   - probe 注入式：决策逻辑可以在不触碰原生模块的情况下单测。
 *   - 运行时代码通过 createTrackPlayerProbe() 获取 probe —— 动态 import，
 *     web / 无原生模块环境下返回 null，全部调用方按"无音乐通道"安全降级。
 *   - 所有函数永不抛出：协调失败最多导致短暂叠音，绝不能阻塞 TTS 或录音。
 *
 * @module utils/audio-coordination
 */

/** 对音乐播放器的最小探测接口（只暴露协调所需的能力）。 */
export interface MusicPlayerProbe {
  /** 音乐是否正在出声（State.Playing），暂停/停止/无队列都算 false。 */
  isPlaying(): Promise<boolean>;
  pause(): Promise<void>;
  play(): Promise<void>;
}

/**
 * 构造基于 react-native-track-player 的 probe。
 * 动态 import + 全 try/catch：web 或原生模块缺失时返回 null。
 */
export async function createTrackPlayerProbe(): Promise<MusicPlayerProbe | null> {
  try {
    const mod = await import('react-native-track-player');
    const TrackPlayer = mod.default;
    if (!TrackPlayer || typeof TrackPlayer.getPlaybackState !== 'function') return null;
    return {
      isPlaying: async () =>
        (await TrackPlayer.getPlaybackState()).state === mod.State.Playing,
      pause: () => TrackPlayer.pause(),
      play: () => TrackPlayer.play(),
    };
  } catch {
    return null;
  }
}

// ── duck 状态 ─────────────────────────────────────────────────────
// true = "音乐是被 TTS 暂停让路的，TTS 结束时应当恢复它"。
// 模块级单例 —— 与 tts.ts 的 AudioContext 一样跨 pipeline / 跨组件存活。
let musicDuckedByTts = false;

/** 当前是否处于 "音乐被 TTS duck" 状态（主要供测试与诊断）。 */
export function isMusicDuckedByTts(): boolean {
  return musicDuckedByTts;
}

/**
 * TTS 开播时调用：音乐正在播放则暂停并置 duck 标志。
 *
 * 音乐未在播放（已暂停或无队列）→ 不做任何事也不置标志 —— 否则 TTS
 * 结束时会把用户自己主动暂停的音乐错误地恢复出来。
 */
export async function duckMusicForTts(probe: MusicPlayerProbe | null): Promise<void> {
  if (!probe) return;
  try {
    if (await probe.isPlaying()) {
      await probe.pause();
      musicDuckedByTts = true;
    }
  } catch {
    // 忽略 —— 协调失败不阻塞 TTS。
  }
}

/**
 * TTS 结束时调用：恢复被 duck 的音乐并清除标志。
 *
 * 非 duck 状态 → 纯 no-op。标志先于 play() 清除：即使 play 失败，
 * 也不希望留下陈旧标志导致后续错误恢复。
 */
export async function resumeDuckedMusic(probe: MusicPlayerProbe | null): Promise<void> {
  if (!musicDuckedByTts) return;
  musicDuckedByTts = false;
  if (!probe) return;
  try {
    await probe.play();
  } catch {
    // 忽略。
  }
}

/**
 * 立即清除 duck 标志但不恢复播放。
 *
 * 音乐即将自行开始时调用（用户点卡片 / 通知栏播放 / 新结果自动播放）：
 * 此时音乐侧同时会停掉 TTS，而 TTS 的拆除路径会调用 resumeDuckedMusic ——
 * 若不先清标志，TTS 拆除会对即将被替换的旧队列再 play() 一次，
 * 用户会听到旧歌响一瞬间又被切断。
 */
export function releaseMusicDuck(): void {
  musicDuckedByTts = false;
}
