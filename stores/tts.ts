import { create } from 'zustand';
import {
  AudioContext,
  type AudioBufferQueueSourceNode,
  type GainNode,
} from 'react-native-audio-api';
import { TtsService } from '@/services/tts-service';
import { logger } from '@/utils/logger';
import {
  createTrackPlayerProbe,
  duckMusicForTts,
  resumeDuckedMusic,
} from '@/utils/audio-coordination';

const DEFAULT_SAMPLE_RATE = 24000;

// ─── 模块级单例资源 ──────────────────────────────────────────────
// 这些资源位于 React/Zustand 之外，因为 AudioContext 和 source
// 节点是原生对象，必须在组件重新渲染之间持久存在。

let audioCtx: AudioContext | null = null;
let gainNode: GainNode | null = null;
let currentSampleRate: number = DEFAULT_SAMPLE_RATE;

// 音量增益 = 1.0（原始值）。服务端 PCM 已归一化到 [-1.0, 1.0]；
// 任何 > 1.0 的增益会在幅度峰值处（尤其是句尾爆发）导致硬削波，
// 产生刺耳的失真。保留 gain 节点以便将来做渐变/淡入淡出控制，
// 但不要放大 — 依赖设备音量即可。
const VOLUME_GAIN = 1.0;

// ─── 基于调度的播放 ──────────────────────────────────────────────
// 使用 AudioBufferQueueSourceNode：单个长生命周期 source node 持续
// 接收 enqueueBuffer() 调用，引擎内部处理 chunk 边界与播放节奏。
//
// 这替代了旧的 "每个 PCM chunk 创建一个新 AudioBufferSourceNode +
// 手动 start(nextStartTime)" 模式 — 后者在 react-native-audio-api
// 0.13.x 的 iOS 后端有已知问题：
//   #1064 — iOS 渲染以 ~3× 速率消费 buffer，调度时刻到达时 buffer
//           已被吃完，导致"前半段正常、后段丢失"
//   #727  — 同时存活 ≥11 个 source node 时引擎行为未定义
//           （一段 30s TTS 同时活跃的 source 早就超过 11 个）
//   #586  — 首个 chunk 之后所有后续 chunk 不出声（同源 bug）
// QueueSource 用单一 node + 引擎内部队列调度，绕开这三个 issue。
//
// 完整 pipeline 的所有 sentence 共享同一个 queueSource，句间零间隔
//（WS 在 N 播放期间已提前送达 N+1 的数据，由 QueueSource 顺序消化）。

let queueSource: AudioBufferQueueSourceNode | null = null;

// chunk 完成追踪：统计已 enqueue 的 PCM chunk 数 + 已播放完的。
// 当所有 chunk 都已播放（onBufferEnded 触发 isLastBufferInQueue=true）
// 且 pipeline 标记为完成时，自然完成立即触发 — 比任何定时器都准确，
// 因为它反映的是实际音频播放。
let enqueuedChunkCount = 0;
let playedChunkCount = 0;
// QueueSource 的 isLastBufferInQueue 信号有时序边界条件：客户端调用
// enqueueBuffer 期间若正在播前一个 chunk，可能错过 isLast=true 的事件。
// 用这个标志兜底：onBufferEnded 每触发一次，期望下一个就是队列里仅剩的
// 最后一个的 ended —— 如果一个 chunk ended 后再无新 chunk enqueue，
// 且 pipelineNoMore 已被标记，认为"队列已自然耗尽"，触发完成。
let queueSourceDrainedNaturally = false;

// 完成定时器：pipeline WS 关闭（onAllDone）后，为剩余播放时长
// 调度此定时器。最后一个 buffer 播完后触发 resetPipeline。
let completionTimer: ReturnType<typeof setTimeout> | null = null;

// 超时定时器：异常 WS 静默（连接断开但未触发 onAllDone）的安全网。
// 每收到一个 chunk 就重置；如果 DRAIN_TIMEOUT_MS 内没有新音频到达，
// 强制完成 pipeline。
const DRAIN_TIMEOUT_MS = 30000;
let drainTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Pipeline 驱动状态 ──────────────────────────────────────────
// 一个 TtsService 实例通过一条长连接 WebSocket 承载流式消息中的
// 每个 sentence。服务端按 FIFO 顺序合成；chunk 通过 sentence_index
//（audio.start 中携带）标记到达，我们将它们全部路由到同一调度时间线。
//
// pipelineSession：每次新 pipeline 递增。异步回调（drainTimer、
// completionTimer）在创建时捕获 session ID，与当前值比较以检测过期。
const pipelineService = new TtsService();
let pipelineActive = false;
let pipelineMessageId: string | null = null;
let pipelineSession = 0;

// 基于文本覆盖率的完成追踪，而非 sentence 计数。
//
// 服务端可能以不同方式拆分或合并我们的 sentence（例如在客户端合并的
// 终止标点处重新拆分，或合并短片段）。因此 "doneCount == sentCount"
// 很脆弱：不匹配会导致提前完成（最后一句被丢弃）或卡死（等待永不
// 到来的 done）。
//
// 改为：将发送的文本归一化一次，然后累积服务端在每次 audio.start 中
// 返回的 sentence_text。当累积的已接收文本覆盖了已发送文本时，我们
// 知道服务端已接收并开始合成每个 sentence — 然后等待对应的
// audio.done 来确认最后一个 PCM chunk 已返回。
let pipelineSentText = '';
let pipelineReceivedText = '';
let pipelineAllReceived = false;
let pipelineLastReceivedIdx = -1;
// 仅在服务端返回了最后一个已接收段的 audio.done 后才为 true —
// 即服务端已返回所有 sentence 的全部 PCM chunk。
// pipelineAllReceived 仅表示服务端已开始合成最后一段（audio.start）；
// 此后仍可能有更多 PCM chunk 到达，因此自然完成必须等到
// allSynthesized 才能触发。
let pipelineAllSynthesized = false;
// 仅用于日志 — 不再驱动完成逻辑。
let pipelineSentCount = 0;
let pipelineDoneCount = 0;
let pipelineNoMore = false;

// 暂停状态：录音会话抢占音频会话时，播放暂停但 pipeline WS 保持
// 开启，服务端继续合成。暂停期间到达的 PCM chunk 缓冲到
// pendingChunks，恢复时无缝刷新。
let pipelinePaused = false;
// 暂停期间触发了 onAllDone — 延迟到 resumeAfterRecording 处理。
let pipelineAllDoneWhilePaused = false;
// onAllDone has fired (either before or during pause). Pause cancels the
// completion timer, so resume uses this flag to re-run completion handling
// (re-arm the completion timer or finalize immediately). Without it, playback
// resumed from pause could never finalize the pipeline.
let pipelineAllDoneFired = false;

// 预缓冲：在开始播放前积累音频数据。
// TTS 服务端以约 50% 实时速度生成音频。通过在播放前缓冲
// PREBUFFER_MS 的音频，创造领先优势以吸收网络抖动，减少
// underrun 导致的静音间隙。值越大越平滑但等待时间越长。
const PREBUFFER_MS = 1500;

// 已 enqueue 的 chunk 总时长（用于诊断）。计算逻辑与旧 pendingDurationMs
// 类似，但语义改为"已喂给 QueueSource 的总时长"，不再用于节流。
let queueAheadMs = 0;

interface PendingChunk {
  data: ArrayBuffer;
  sampleRate: number;
}
let pendingChunks: PendingChunk[] = [];
let pendingDurationMs = 0;

function pushPending(data: ArrayBuffer, sampleRate: number): void {
  pendingChunks.push({ data, sampleRate });
  pendingDurationMs += (data.byteLength / 2 / sampleRate) * 1000;
}

function shiftPending(): PendingChunk | undefined {
  const chunk = pendingChunks.shift();
  if (chunk) {
    pendingDurationMs -= (chunk.data.byteLength / 2 / chunk.sampleRate) * 1000;
  }
  return chunk;
}

function clearPending(): PendingChunk[] {
  const chunks = pendingChunks;
  pendingChunks = [];
  pendingDurationMs = 0;
  return chunks;
}

/**
 * 去除 TTS 服务端会静默拒绝的 markdown 语法。
 *
 * 原因：TTS 服务端的 WS 端点会丢弃主要包含 markdown 结构的请求
 *（标题、纯粗体、列表项、引用标记）。它既不报错也不合成 — 客户端
 * 只能通过 30 秒空闲超时才知道被拒绝了。发送前去除这些标记可防止
 * 静默丢弃。
 *
 * 去除项：
 *   - ATX 标题:     "## 标题"    → "标题"
 *   - 粗体/斜体:    "**粗体**"   → "粗体"
 *   - 无序列表:     "- 条目"     → "条目"
 *   - 有序列表:     "1. 条目"    → "条目"
 *   - 引用标记:     "文本[12]"   → "文本"
 *   - 链接:         "[文本](url)" → "文本"
 *   - 行内代码:     "`代码`"     → "代码"
 *   - 表格:         "| a | b |"  → "a b"（整行合并）
 *   - 表格分隔线:   "|---|---|"  → ""（丢弃）
 *   - 水平线:       "---"/"___"  → ""（丢弃，保留 \n）
 *   - Emoji:        "你好🎉"     → "你好"（丢弃）
 *
 * 注意：这里刻意不把空行折叠为 \n\n。
 * 段落/空行边界被保留，以便 splitForTts 将它们视为硬边界，
 * 避免把短标题合并到正文中。
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')           // ATX 标题
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // 粗体
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1$2') // 斜体（非粗体）
    .replace(/^[-*+]\s+/gm, '')            // 无序列表符号
    .replace(/^\d+\.\s+/gm, '')            // 有序列表
    .replace(/\[(\d+)\]/g, '')             // 引用标记 [1] [12]（闭合）
    .replace(/\[\d+/g, '')                 // 未闭合引用 [1 [12（流式拆分残留）
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 链接 [文本](url)
    .replace(/`([^`]+)`/g, '$1')           // 行内代码
    .replace(/^\s*\|[\s:|-]+\|\s*$/gm, '') // 表格分隔行 "|---|---|"
    .replace(/^\|(.+)\|\s*$/gm, (_, inner: string) => // 表格数据行 "| a | b |"
      inner.split('|').map((c: string) => c.trim()).filter(Boolean).join(' '))
    .replace(/^[-*_]{3,}\s*$/gm, '')       // 水平线 "---" / "___" / "***"
    .replace(/\|/g, ' ')                   // 残留管道符（拆分表格行）→ 空格
    .replace(/\p{Extended_Pictographic}/gu, '') // emoji 🎉🔥❤️（主字形）
    .replace(/[\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]/gu, '') // emoji 残留: VS-16, ZWJ, 肤色修饰符
    .replace(/\n{3,}/g, '\n\n')            // 折叠过多空行（保留段落分隔）
    .trim();
}

/**
 * 将文本拆分为适合 TTS 的句子。
 *
 * 流程：去除 markdown → 在中文/英文句界拆分 → 合并连续短片段。
 * 合并是必要的，因为 TTS 服务端会静默丢弃过短的负载（< ~10 字符）；
 * 将相邻短片段合并到 MIN_SENTENCE_LEN 可确保每个片段都能被合成，
 * 同时保留自然边界位置作为合并点。
 */
const MIN_SENTENCE_LEN = 12;
const TERMINAL_PUNCT = /[。！？.!?？]$/;

/**
 * 句子边界拆分 —— 对齐 Python 端 SPLIT_SENTENCE:
 *   (?<=[。！？])   CJK 句末标点后零宽拆分（无需尾随空白）
 *   (?<=[.!?])\s+   英文句末标点 + 空白（缩写 Mr. / 小数 3.14 不会误拆）
 *   \n+             换行（TTS 自然停顿点）
 * 英文需要尾随空白确认边界——字符串结尾不算边界（由 buffer flush 处理）。
 */
const SPLIT_RE = /(?<=[。！？])|(?<=[.!?])\s+|\n+/;
const PARAGRAPH_RE = /\n{2,}/;

/**
 * 确保 `s` 以终止标点结尾。TTS 服务端会静默丢弃缺少句末标点
 *（句号/感叹号/问号）的负载。
 *
 * 循环剥离尾部噪声：空白 → 软标点（逗号/分号/冒号）→ 换行 → …，
 * 直到留下非空内容或全部剥光。否则像 "林徽因（1904–1955），\n"
 * 这样的片段会被变成 "，。"，服务端可能会误读或拒绝。
 * 全为空时返回空串，让调用方走"无可发送"路径。
 */
function ensureTerminalPunct(s: string): string {
  let cleaned = s.trim();
  const NOISE_RE = /[\s，；：,;:\n]+$/;
  while (cleaned && NOISE_RE.test(cleaned)) {
    cleaned = cleaned.replace(NOISE_RE, '');
  }
  if (!cleaned) return '';
  return TERMINAL_PUNCT.test(cleaned) ? cleaned : cleaned + '。';
}

/**
 * 归一化文本用于完成比较：只保留字母和数字（中日韩表意文字属于 \p{L}），
 * 去除所有空格、标点和符号（包括 emoji）。这样我们就能将发送的文本
 * 与服务端在每次 audio.start 中回传的 sentence_text 拼接进行比较，
 * 无论双方如何拆分或标点化负载。
 */
function normalizeText(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, '');
}

function splitForTts(text: string): string[] {
  const cleaned = stripMarkdown(text);
  const paragraphs = cleaned.split(PARAGRAPH_RE).map((p) => p.trim()).filter(Boolean);

  const merged: string[] = [];
  for (const para of paragraphs) {
    const parts = para.split(SPLIT_RE).map((s) => s.trim()).filter(Boolean);
    let buffer = '';
    for (const s of parts) {
      buffer = buffer ? buffer + s : s;
      // 遇到终止标点（。！？.!?）时立即刷新。
      // TTS 服务端将这些视为硬句界，会重新拆分包含它们的负载。
      // 如果客户端跨终止边界合并（如 "你好！很高兴见到你。" 作为一句），
      // 服务端会产生比客户端发送数量更多的 sentence，
      // 导致 pipelineDoneCount 提前达到 pipelineSentCount，
      // 在最后一句合成前就取消它。
      if (TERMINAL_PUNCT.test(buffer)) {
        merged.push(buffer);
        buffer = '';
      } else if (buffer.length >= MIN_SENTENCE_LEN) {
        merged.push(ensureTerminalPunct(buffer));
        buffer = '';
      }
    }
    if (buffer.trim()) merged.push(ensureTerminalPunct(buffer.trim()));
  }
  // 每句补尾随空格——TTS 服务端依赖空白确认词界/句界，
  // 缺少尾随空白的负载可能被静默丢弃或误读。
  return merged.map((s) => (s.endsWith(' ') ? s : `${s} `));
}

/**
 * 将 Int16 LE PCM（ArrayBuffer）转换为 Float32Array（-1.0 ~ 1.0），
 * 以兼容 Web Audio API。
 */
function int16ToFloat32(buffer: ArrayBuffer): Float32Array<ArrayBuffer> {
  const src = new Int16Array(buffer);
  const dst = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    dst[i] = src[i] / 32768;
  }
  return dst;
}

/**
 * 用户手势入口 — 恢复已存在的 AudioContext。
 *
 * 不在此创建 AudioContext：创建推迟到 initStreamingEngine，因为它需要
 * 从 audio.start 获取上游 sample_rate 来匹配 AudioContext 采样率。
 *
 * 如果 AudioContext 已存在（上一次播放未关闭），在用户手势内 resume 它。
 */
export function prepareAudioContext(): void {
  if (!audioCtx) {
    logger.debug('TTS', 'prepareAudioContext — deferred (await audio.start for sample_rate)');
    return;
  }
  if (audioCtx.state === 'suspended') {
    logger.debug('TTS', 'prepareAudioContext — resuming existing context');
    const ctx = audioCtx;
    ctx
      .resume()
      .then(() => {
        logger.debug('TTS', 'prepareAudioContext resumed', { state: ctx.state });
      })
      .catch((err: unknown) => {
        logger.warn('TTS', 'prepareAudioContext resume failed', err);
      });
  } else {
    logger.debug('TTS', 'prepareAudioContext — already running');
  }
}

/**
 * 为新 pipeline 初始化流式播放引擎。
 *
 * 用 audio.start 返回的 sample_rate 创建 AudioContext（确保采样率匹配，
 * 避免 react-native-audio-api 不可靠的重采样）。如果 AudioContext 已存在
 * 但 sampleRate 不匹配，关闭旧的重建。
 *
 * 创建一个 AudioBufferQueueSourceNode 持续接收 enqueueBuffer() 调用。
 * pitchCorrection=false 关闭 — TTS 不需要变调，且开启会引入处理延迟
 * （见 react-native-audio-api 文档 AudioBufferQueueSourceNode 备注）。
 */
function initStreamingEngine(sampleRate: number): void {
  logger.debug('TTS', 'initStreamingEngine', { sampleRate });
  disposeStreamingEngine();

  currentSampleRate = sampleRate;

  if (audioCtx && audioCtx.sampleRate !== sampleRate) {
    logger.debug('TTS', 'sampleRate mismatch — recreating AudioContext', {
      ctx: audioCtx.sampleRate,
      upstream: sampleRate,
    });
    try { void audioCtx.close(); } catch { /* 忽略 */ }
    audioCtx = null;
  }

  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate });
    logger.debug('TTS', 'AudioContext created', { sampleRate, state: audioCtx.state });
    if (audioCtx.state === 'suspended') {
      const ctx = audioCtx;
      ctx
        .resume()
        .then(() => logger.debug('TTS', 'AudioContext resumed', { state: ctx.state }))
        .catch((e: unknown) => logger.warn('TTS', 'AudioContext resume failed', e));
    }
  }

  gainNode = audioCtx.createGain();
  gainNode.gain.value = VOLUME_GAIN;
  gainNode.connect(audioCtx.destination);

  // 创建 queueSource — 单一长生命周期 node 承载整个 pipeline 的所有 chunk。
  // 必须在 start() 之前绑定 onBufferEnded，且在调 enqueueBuffer 之前
  // 调 start()，否则 isLastBufferInQueue 边界条件无法正确触发。
  queueSource = audioCtx.createBufferQueueSource({ pitchCorrection: false });
  queueSource.connect(gainNode);

  const mySession = pipelineSession;
  queueSource.onBufferEnded = (event) => {
    // 过期回调（pipeline 已切换）— 完全忽略。
    if (mySession !== pipelineSession) return;
    playedChunkCount++;
    if (queueAheadMs > 0) queueAheadMs = Math.max(0, queueAheadMs - 1000); // 粗略估算: 每个 buffer 播完减一点
    logger.debug('TTS-queue', 'buffer ended', {
      played: playedChunkCount,
      enqueued: enqueuedChunkCount,
      bufferId: event.bufferId,
      isLast: event.isLastBufferInQueue,
    });
    if (event.isLastBufferInQueue) {
      queueSourceDrainedNaturally = true;
    }
    checkNaturalCompletion();
  };

  enqueuedChunkCount = 0;
  playedChunkCount = 0;
  queueSourceDrainedNaturally = false;
  queueAheadMs = 0;

  logger.debug('TTS', 'engine ready', {
    upstreamSampleRate: sampleRate,
    ctxSampleRate: audioCtx.sampleRate,
    ctxState: audioCtx.state,
    currentTime: audioCtx.currentTime,
    queueSourceCreated: true,
  });
}

/**
 * 刷新 pending 中的所有 chunk 到 QueueSource。
 *
 * QueueSource 不需要 MAX_BUFFER_AHEAD_MS 节流 — 它内部队列是无上限的，
 * 引擎按入队顺序连续播放，无需客户端算 nextStartTime。所以这个函数
 * 只是简单地把 pending 全部喂给 QueueSource。
 */
function drainPendingChunks(): void {
  if (pendingChunks.length === 0 || !queueSource || !audioCtx) return;

  let flushed = 0;
  while (pendingChunks.length > 0) {
    const chunk = shiftPending()!;
    enqueuePcmChunk(chunk.data, chunk.sampleRate);
    flushed++;
  }

  if (flushed > 0) {
    logger.debug('TTS-queue', 'drained pending chunks', {
      flushed,
      remaining: pendingChunks.length,
    });
  }
}

/**
 * Arm (or re-arm) the WS-silence safety timer. If no new chunk arrives
 * within DRAIN_TIMEOUT_MS (e.g. the WS dropped silently without firing
 * onAllDone), force-reset the pipeline. Re-armed on every enqueue and on
 * resume from pause (pause cancels it).
 */
function armDrainTimer(): void {
  if (drainTimer) clearTimeout(drainTimer);
  const mySession = pipelineSession;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    logger.warn('TTS-queue', 'drain timeout — force resetting pipeline (WS silent)', {
      session: mySession,
    });
    pipelineService.cancel();
    resetPipeline(mySession);
  }, DRAIN_TIMEOUT_MS);
}

/**
 * 将 PCM chunk 转换为 AudioBuffer 并喂给 QueueSource。
 *
 * 与旧的 "每 chunk 一个 AudioBufferSourceNode + start(nextStartTime)"
 * 不同，这里所有 chunk 走单一 QueueSource：
 *   - 引擎内部处理 chunk 边界
 *   - 不会有多个 source 同时存活（绕开 #727）
 *   - 不依赖手算 nextStartTime（绕开 iOS #1064 调度漂移）
 *
 * drainTimer 在每个 chunk 上重新计时 — 如果 WS 静默 DRAIN_TIMEOUT_MS
 * （如断连但未触发 onAllDone），强制重置 pipeline。
 */
function enqueuePcmChunk(pcmData: ArrayBuffer, sampleRate: number): void {
  if (!audioCtx || !queueSource || !gainNode) {
    logger.warn('TTS', 'enqueuePcmChunk skipped — engine not ready');
    return;
  }

  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }

  if (sampleRate !== currentSampleRate) {
    logger.debug('TTS', 'sampleRate changed', { from: currentSampleRate, to: sampleRate });
    currentSampleRate = sampleRate;
  }

  const frames = pcmData.byteLength / 2;
  const durationMs = (frames / currentSampleRate) * 1000;
  const audioBuffer = audioCtx.createBuffer(1, frames, currentSampleRate);
  const float32Data = int16ToFloat32(pcmData);
  audioBuffer.copyToChannel(float32Data, 0);

  const bufferId = queueSource.enqueueBuffer(audioBuffer);
  enqueuedChunkCount++;
  queueAheadMs += durationMs;

  armDrainTimer();

  logger.debug('TTS-queue', 'enqueued', {
    enqueued: enqueuedChunkCount,
    played: playedChunkCount,
    durationMs: Math.round(durationMs),
    queueAheadMs: Math.round(queueAheadMs),
    bufferId,
  });
}

/**
 * 拆除流式播放引擎并释放原生资源。
 *
 * 清空 QueueSource 队列并断开连接，清除所有定时器，并将 GainNode 置空。
 * 不关闭 audioCtx（跨 pipeline 复用），也不触碰 pipeline 驱动状态
 *（那是 resetPipeline 的职责）。
 */
function disposeStreamingEngine(): void {
  if (completionTimer) {
    clearTimeout(completionTimer);
    completionTimer = null;
  }
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  clearPending();

  if (queueSource) {
    logger.debug('TTS-queue', 'disposeStreamingEngine', {
      enqueued: enqueuedChunkCount,
      played: playedChunkCount,
    });
    try {
      queueSource.clearBuffers();
    } catch {
      /* 已结束或未启动 */
    }
    try {
      queueSource.onBufferEnded = null;
    } catch {
      /* 忽略 */
    }
    try {
      queueSource.pause();
    } catch {
      /* 未启动 */
    }
    try {
      queueSource.disconnect();
    } catch {
      /* 忽略 */
    }
    queueSource = null;
  }
  enqueuedChunkCount = 0;
  playedChunkCount = 0;
  queueSourceDrainedNaturally = false;
  queueAheadMs = 0;

  if (gainNode) {
    try { gainNode.disconnect(); } catch { /* 忽略 */ }
    gainNode = null;
  }
  // 注意：不要在这里关闭 audioCtx。它在 pipeline 之间复用
  //（在用户手势上下文中创建）。
}

/**
 * 完全关闭并释放 AudioContext。仅在完全停止播放时调用
 *（stopTtsPlayback / stopAutoPlay），不在 pipeline 之间调用。
 */
function closeAudioContext(): void {
  if (audioCtx) {
    try { void audioCtx.close(); } catch { /* 忽略 */ }
    audioCtx = null;
  }
}

function stopAllInternal(): void {
  pipelineSession++;
  pipelineService.cancel();
  pipelineActive = false;
  pipelineMessageId = null;
  // Full shutdown invalidates any pending pause/resume cycle too (e.g. TTS
  // stopped while a video or recording session holds the pause).
  pipelinePaused = false;
  pipelineAllDoneWhilePaused = false;
  pipelineAllDoneFired = false;
  disposeStreamingEngine();
  closeAudioContext();
  // TTS 整体停止（手动停止 / 关闭自动播报 / 登出清理）→ 释放 duck 让路的音乐。
  resumeMusicAfterSpeech();
}

// ─── 音乐让路协调 ────────────────────────────────────────────────
// 与背景音乐（react-native-track-player）的互斥协议，决策逻辑见
// @/utils/audio-coordination。TTS 侧职责：开播时 duck（暂停正在播的
// 音乐并记忆），任何结束路径恢复。反向（音乐起 → TTS 停）由音乐侧
// 在启动前调用 releaseMusicDuck + stopTtsPlayback 完成。

/** TTS 真正出声（queueSource.start）时让音乐让路。fire-and-forget，永不阻塞开播。 */
function duckMusicForSpeech(): void {
  void (async () => {
    try {
      await duckMusicForTts(await createTrackPlayerProbe());
    } catch {
      // duckMusicForTts 内部已吞异常，此处为双保险。
    }
  })();
}

/** pipeline 结束 / 播放停止时恢复被 duck 的音乐。fire-and-forget。 */
function resumeMusicAfterSpeech(): void {
  void (async () => {
    try {
      await resumeDuckedMusic(await createTrackPlayerProbe());
    } catch {
      // 同上。
    }
  })();
}

// ─── 录音暂停/恢复 ──────────────────────────────────────────────
//
// 录音会抢占 iOS AVAudioSession 的 category/mode，与播放冲突。
// 我们不完全拆除 pipeline（那会丢失服务端正在进行的合成），
// 而是暂停播放同时保持 WS 开启。服务端继续生成音频；
// 我们将其缓冲，恢复时刷新以实现"从断点继续"的无缝体验。

/**
 * 为录音会话暂停 TTS 播放。
 *
 * - 暂停 QueueSource（终止正在播放的音频，保留队列位置）
 * - 挂起 AudioContext（为录音器释放原生音频会话）
 * - 保持 pipeline WS 开启 — 服务端继续合成，返回的 chunk 缓冲到
 *   pendingChunks
 * - 将 gainNode 置空，使 handlePipelineChunk 将新 chunk 路由到
 *   缓冲路径
 * - 设置 pipelinePaused 使 handlePipelineAllDone 延迟完成
 *
 * The queueSource itself is kept alive with its enqueued-but-unplayed
 * buffers intact; resumeAfterRecording() restarts it in place. Also used
 * by the video player to duck TTS while video audio plays.
 *
 * 无活跃 pipeline 时安全调用（空操作）。
 */
export function pauseForRecording(): void {
  // 无活跃 pipeline → 无需暂停。音频会话可供录音器抢占。
  if (!pipelineActive) {
    logger.debug('TTS-pause', 'no active pipeline — nothing to pause');
    return;
  }
  // 幂等：录音重入（如快速开始/停止）不应重复暂停。
  if (pipelinePaused) {
    logger.debug('TTS-pause', 'already paused — skipping');
    return;
  }

  pipelinePaused = true;
  logger.debug('TTS-pause', 'pausing for recording', {
    messageId: pipelineMessageId,
    pendingChunks: pendingChunks.length,
    enqueued: enqueuedChunkCount,
  });

  // Pause the QueueSource — stops immediately but KEEPS the internal queue
  // and read position. resumeAfterRecording() restarts this same source so
  // the enqueued-but-unplayed buffers continue from the pause point. Do NOT
  // dispose here: that would clearBuffers() and lose all audio buffered
  // ahead of playback. (The queued PCM is plain memory — AVAudioSession
  // preemption cannot corrupt it; only currentTime-based scheduling needs
  // re-anchoring via start() on resume.)
  if (queueSource) {
    try {
      queueSource.pause();
    } catch {
      /* not started or already ended */
    }
    // Detach from the old gain chain — gainNode is dropped below; resume
    // rebuilds the chain and reconnects.
    try {
      queueSource.disconnect();
    } catch {
      /* ignore */
    }
  }

  // 取消所有待处理的定时器 — 暂停期间它们无意义。
  // 恢复时如有需要会重新调度完成定时器。
  if (completionTimer) {
    clearTimeout(completionTimer);
    completionTimer = null;
  }
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }

  // 拆除 gain 节点，使 handlePipelineChunk 将新 chunk 路由到
  //（暂停态的）缓冲路径。这里不关闭 audioCtx — suspend() 足以为
  // 录音器释放原生音频会话，保持存活可避免 iOS 上的
  // "必须在用户手势中恢复"陷阱。
  if (gainNode) {
    try { gainNode.disconnect(); } catch { /* 忽略 */ }
    gainNode = null;
  }

  // 挂起 AudioContext。在 iOS 上这会释放 AVAudioSession 激活，
  // 让 expo-audio 的录音器无冲突地抢占。
  if (audioCtx && audioCtx.state === 'running') {
    audioCtx
      .suspend()
      .then(() => logger.debug('TTS-pause', 'audioCtx suspended'))
      .catch((e: unknown) => logger.warn('TTS-pause', 'suspend failed', e));
  }

  useTtsStore.setState({ isPlaying: false });
}

/**
 * 录音会话结束后恢复 TTS 播放。
 *
 * - 恢复 AudioContext（重新激活原生音频会话）
 * - 引擎已在播：在原 queueSource 上原地续播 — 暂停时保留的
 *   已入队未播完 buffer 全部保留，暂停期间新合成的 chunk 追加到队尾
 * - 引擎未启动（暂停时仍在预缓冲）：重建流式引擎并刷新缓冲的 chunk
 * - 重新武装被暂停取消的完成处理（onAllDone）与 WS 静默安全定时器
 *
 * 未暂停时安全调用（空操作）。
 */
export function resumeAfterRecording(): void {
  if (!pipelinePaused) {
    logger.debug('TTS-resume', 'not paused — skipping');
    return;
  }
  pipelinePaused = false;
  logger.debug('TTS-resume', 'resuming after recording', {
    messageId: pipelineMessageId,
    bufferedChunks: pendingChunks.length,
    bufferedMs: Math.round(pendingDurationMs),
    hasSource: !!queueSource,
    enqueued: enqueuedChunkCount,
    played: playedChunkCount,
    allDoneFired: pipelineAllDoneFired,
    allDoneWhilePaused: pipelineAllDoneWhilePaused,
  });

  // 恢复 AudioContext。这会重新激活原生音频会话。
  // 某些平台要求这在用户手势上下文中发生 — 录音的停止/释放链
  // 由按键释放手势发起，所以我们仍在那个调用栈中（尽力而为）。
  const ctxToResume = audioCtx;
  if (ctxToResume && ctxToResume.state === 'suspended') {
    ctxToResume
      .resume()
      .then(() => logger.debug('TTS-resume', 'audioCtx resumed', { state: ctxToResume.state }))
      .catch((e: unknown) => logger.warn('TTS-resume', 'resume failed', e));
  }

  // Two resume paths:
  //
  // 1) The engine was running before pause (queueSource alive). Its internal
  //    queue still holds the enqueued-but-unplayed buffers — restart the SAME
  //    source so playback continues from the pause point. Chunks synthesized
  //    during the pause are appended behind the retained buffers (FIFO order
  //    preserved).
  //    The restart uses the -1 offset sentinel through the JSI node (see
  //    below), which preserves the exact mid-buffer read position: playback
  //    resumes sample-accurately — nothing lost, nothing replayed.
  //
  //    (The old code rebuilt the engine here, whose disposeStreamingEngine()
  //    called clearBuffers() and silently threw away all retained audio; when
  //    no chunks arrived during the pause nothing resumed at all. That was
  //    the "closing the video sometimes resumes the voice, sometimes not"
  //    bug.)
  //
  // 2) The engine never started before pause (still pre-buffering) — build a
  //    fresh engine from the buffered chunks.
  const hasRetainedQueue = !!queueSource && playedChunkCount < enqueuedChunkCount;

  if (queueSource && audioCtx && (hasRetainedQueue || pendingChunks.length > 0)) {
    // Rebuild the gain chain torn down by pause: queueSource → gain → dest.
    gainNode = audioCtx.createGain();
    gainNode.gain.value = VOLUME_GAIN;
    gainNode.connect(audioCtx.destination);
    queueSource.connect(gainNode);

    const chunksToFlush = clearPending();
    for (const chunk of chunksToFlush) {
      enqueuePcmChunk(chunk.data, chunk.sampleRate);
    }

    try {
      // Exact resume with ZERO replayed audio: start(when, -1) keeps the
      // source's read position — the C++ start() returns before touching
      // vReadIndex_ when offset < 0, and pause() preserved both the queue
      // and the mid-buffer position. The public TS wrapper rejects negative
      // offsets (RangeError), so call the JSI host object directly; fall
      // back to the public API (offset 0, replays at most one chunk) if the
      // internal shape ever changes.
      const jsiNode = (queueSource as unknown as {
        node?: { start(when: number, offset: number): void };
      }).node;
      if (jsiNode) {
        jsiNode.start(audioCtx.currentTime, -1);
      } else {
        queueSource.start(audioCtx.currentTime, 0);
      }
    } catch (e: unknown) {
      logger.warn('TTS-resume', 'queueSource.start failed (resume in place)', {
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      try {
        queueSource.start(audioCtx.currentTime, 0);
      } catch {
        /* already logged above */
      }
    }

    // 续播同样属于 "TTS 出声" — 若录音期间有人经通知栏起了音乐，这里让其让路；
    // 若音乐本就处于 duck 暂停态，则是无害 no-op。
    duckMusicForSpeech();
    useTtsStore.setState({ isLoading: false, isPlaying: true });
    logger.debug('TTS-resume', 'resumed in place on retained queue', {
      flushedChunks: chunksToFlush.length,
      enqueued: enqueuedChunkCount,
      played: playedChunkCount,
    });
  } else if (pendingChunks.length > 0 && audioCtx) {
    logger.debug('TTS-resume', 'flushing buffered chunks (fresh engine)', {
      count: pendingChunks.length,
      ms: Math.round(pendingDurationMs),
    });
    const chunksToFlush = clearPending();
    const flushSampleRate = chunksToFlush[chunksToFlush.length - 1].sampleRate;

    initStreamingEngine(flushSampleRate);

    for (const chunk of chunksToFlush) {
      enqueuePcmChunk(chunk.data, chunk.sampleRate);
    }
    // 启动 queueSource — 必须在第一批 buffer 入队后调，否则立刻播就完了。
    if (queueSource && audioCtx) {
      try {
        queueSource.start(audioCtx.currentTime, 0);
      } catch (e: unknown) {
        logger.warn('TTS-resume', 'queueSource.start failed', {
          message: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
        });
      }
    }
    duckMusicForSpeech();
    useTtsStore.setState({ isLoading: false, isPlaying: true });
    logger.debug('TTS-resume', 'playback resumed from buffered chunks');
  } else {
    logger.debug('TTS-resume', 'nothing to resume — engine idle');
  }

  // Pause cancelled the drainTimer (silent-WS safety net). Re-arm it only if
  // the server may still send chunks; once everything is synthesized the
  // completion path owns cleanup and a drain timer could force-reset while a
  // long retained queue is still playing.
  if (pipelineActive && !pipelineAllSynthesized && !drainTimer) {
    armDrainTimer();
  }

  // onAllDone fired while paused (deferred) OR before pause (its completion
  // timer was cancelled by pause) — re-run completion handling now in either
  // case so the resumed playback can finalize the pipeline.
  if (pipelineAllDoneFired) {
    pipelineAllDoneWhilePaused = false;
    logger.debug('TTS-resume', 're-running completion handling after resume');
    handlePipelineAllDone();
  }
}

// ─── Pipeline 驱动 ──────────────────────────────────────────────

/**
 * 处理从 pipeline WS 到达的 PCM chunk。
 *
 * 将 chunk 路由到预缓冲（引擎未启动）或活跃调度（引擎运行中）。
 * 预缓冲阶段每个 pipeline 只运行一次 — 达到阈值后，所有后续 chunk
 *（跨每个 sentence）直接流入 enqueuePcmChunk。
 *
 * `idx` 是服务端报告的 sentence 索引；当前不需要按它分支
 *（所有 sentence 共享同一调度），但它被记录用于诊断。
 */
function handlePipelineChunk(idx: number, pcmData: ArrayBuffer, sampleRate: number): void {
  if (!pipelineActive) return;

  // 暂停模式：将到达的 PCM 路由到 pendingChunks 缓冲（服务端
  // 通过保持开启的 WS 继续合成 — chunk 在恢复时无缝刷新）。
  // 此守卫必须在预缓冲路径之前运行，否则 null gainNode
  // 会触发 initStreamingEngine 并在暂停期间开始播放。
  if (pipelinePaused) {
    pushPending(pcmData, sampleRate);
    logger.debug('TTS-pipe', 'buffered chunk while paused', {
      idx,
      bufferedChunks: pendingChunks.length,
      bufferedMs: Math.round(pendingDurationMs),
    });
    return;
  }

  if (!gainNode) {
    pushPending(pcmData, sampleRate);
    logger.debug('TTS-pipe', 'pre-buffering', {
      idx,
      chunks: pendingChunks.length,
      pendingMs: Math.round(pendingDurationMs),
      threshold: PREBUFFER_MS,
    });

    if (pendingDurationMs >= PREBUFFER_MS) {
      logger.debug('TTS-pipe', 'pre-buffer threshold reached — starting playback');
      const chunksToFlush = clearPending();

      initStreamingEngine(sampleRate);
      for (const chunk of chunksToFlush) {
        enqueuePcmChunk(chunk.data, chunk.sampleRate);
      }
      // 第一批 buffer 入队后启动 queueSource — 必须在所有 buffer 入队后调
      // start()，否则引擎立刻播完空队列会触发 isLastBufferInQueue=true 提前结束。
      if (queueSource && audioCtx) {
        try {
          queueSource.start(audioCtx.currentTime, 0);
        } catch (e: unknown) {
          logger.warn('TTS-pipe', 'queueSource.start failed', {
            message: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack : undefined,
          });
        }
      }
      duckMusicForSpeech();
      useTtsStore.setState({ isLoading: false, isPlaying: true });
      logger.debug('TTS-pipe', 'state → playing');
    }
  } else {
    // QueueSource 内部队列无上限 — 直接入队，引擎按 FIFO 顺序播放。
    // 不再需要 MAX_BUFFER_AHEAD_MS 节流（旧版本遗留的多 source 调度 bug
    // 已由 QueueSource 绕开）。
    enqueuePcmChunk(pcmData, sampleRate);
  }
}

/**
 * 服务端开始合成新 sentence。累积回传的 sentence_text（归一化后）
 * 并检查已接收文本是否已覆盖全部已发送文本。覆盖后，记录此最后一段
 * 的服务端索引 — 其后续的 audio.done 是"所有 PCM 已返回"的权威信号。
 */
function handlePipelineSentenceStart(idx: number, text: string): void {
  pipelineReceivedText += normalizeText(text);
  if (!pipelineAllReceived && pipelineSentText && pipelineReceivedText.includes(pipelineSentText)) {
    pipelineAllReceived = true;
    pipelineLastReceivedIdx = idx;
    logger.debug('TTS-pipe', 'all text received — waiting for last audio.done', {
      idx,
      lastIdx: pipelineLastReceivedIdx,
    });
  }
  logger.debug('TTS-pipe', 'sentence start', { idx, preview: text.slice(0, 40) });
}

/**
 * 服务端完成了一个 sentence 的合成。当所有文本已接收
 *（pipelineAllReceived）且此 done 匹配最后一段的索引时，
 * 服务端已返回所有 PCM chunk — 触发完成。
 *（进入 checkPipelineCompletion 重新检查 pipelineNoMore 门控。）
 */
function handlePipelineSentenceDone(idx: number): void {
  pipelineDoneCount++;
  // 当最后一段已接收段的 audio.done 到达时，
  // 整个 pipeline 的所有 PCM chunk 已返回。
  if (pipelineAllReceived && idx === pipelineLastReceivedIdx) {
    pipelineAllSynthesized = true;
    logger.debug('TTS-pipe', 'all synthesized — server confirmed last PCM', {
      idx,
      lastReceivedIdx: pipelineLastReceivedIdx,
    });
    // 关键：服务端已承诺不再发任何 chunk — 停止 drainTimer。
    // 否则它会在最后一个 chunk enqueue 30s 后触发，把还在播的
    // queueSource 拆掉，丢失最后几十个 buffer。drainTimer 本意是
    // 兜底"WS 静默掉线"，但 audio.done 之后 WS 静默是正常的。
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
      logger.debug('TTS-queue', 'drainTimer cleared — server confirmed all PCM synthesized');
    }
  }
  logger.debug('TTS-pipe', 'sentence done', {
    idx,
    done: pipelineDoneCount,
    sent: pipelineSentCount,
    noMore: pipelineNoMore,
    allReceived: pipelineAllReceived,
    allSynthesized: pipelineAllSynthesized,
  });
  checkPipelineCompletion(idx);
}

/**
 * 如果调用方承诺不再追加 sentence（pipelineNoMore），所有已发送
 * 文本已被服务端回传（pipelineAllReceived），且该最后已接收段的
 * audio.done 已到达，则立即触发完成。这避免了服务端 30 秒空闲超时
 * 的 WS 关闭延迟 — 之前音频播完后 UI 播放按钮还会长时间亮着。
 *
 * 完成由文本覆盖率（已接收覆盖已发送）决定，而非 sentence 计数 —
 * 服务端可能拆分或合并我们的 sentence，因此 doneCount == sentCount
 * 不可靠。
 *
 * 这里取消 pipeline WS（不再有音频到来），同时也防止了
 * 30 秒空闲关闭的双触发。
 */
function checkPipelineCompletion(doneIdx?: number): void {
  if (!pipelineActive) return;
  if (!pipelineNoMore) return;
  if (!pipelineAllReceived) return;
  // 最后已接收段的 done 必须已到达。
  if (doneIdx !== undefined && doneIdx !== pipelineLastReceivedIdx) return;

  logger.debug('TTS-pipe', 'all sentences synthesized — completing early', {
    sentCount: pipelineSentCount,
    doneCount: pipelineDoneCount,
    lastReceivedIdx: pipelineLastReceivedIdx,
    doneIdx,
  });
  // 取消 WS，使服务端空闲超时不会保持连接。
  // cancel() 在 close 触发之前清除服务的 pipelineActive 标志，
  // 因此 onclose 不会重新进入 handlePipelineAllDone。
  pipelineService.cancel();
  // 触发客户端完成路径（为剩余播放调度 completionTimer，然后 resetPipeline）。
  handlePipelineAllDone();
}

/**
 * 自然完成：所有已 enqueue 的 PCM chunk 已播放完毕（onBufferEnded 全部触发）。
 * 这是主要的完成机制 — 比任何定时器都准确，因为它反映的是实际音频
 * 播放，而非时间估算。
 *
 * 从 queueSource.onBufferEnded 回调调用。仅当所有条件满足时触发：
 * pipeline 活跃、不再有追加、所有已发送文本已回传（服务端已开始每段）、
 * 所有 chunk 已被音频引擎播完。清除后备定时器并立即重置。
 */
function checkNaturalCompletion(): void {
  if (!pipelineActive) return;
  if (pipelinePaused) return; // 暂停期间引起的 onBufferEnded — 忽略
  if (!pipelineNoMore) return;
  if (!pipelineAllReceived) return;
  if (!pipelineAllSynthesized) return;
  if (playedChunkCount < enqueuedChunkCount) return;
  if (pendingChunks.length > 0) {
    drainPendingChunks();
    return;
  }

  logger.debug('TTS-pipe', 'natural completion — all chunks played', {
    played: playedChunkCount,
    enqueued: enqueuedChunkCount,
  });

  if (completionTimer) {
    clearTimeout(completionTimer);
    completionTimer = null;
  }
  resetPipeline(pipelineSession);
}

/**
 * 标记不再向此 pipeline 追加 sentence。
 * 由 playVoice（所有 sentence 已知）或 finishStream()（聊天 WS
 * 表示流结束）调用。如果所有已提交 sentence 已合成完成，立即触发完成。
 */
function markPipelineComplete(): void {
  if (!pipelineActive) return;
  if (pipelineNoMore) return;
  pipelineNoMore = true;
  logger.debug('TTS-pipe', 'marked complete (no more sentences)', {
    sent: pipelineSentCount,
    done: pipelineDoneCount,
    allReceived: pipelineAllReceived,
  });
  checkPipelineCompletion();
}

/**
 * Pipeline WS 自然关闭（onAllDone）。服务端已合成我们发送的所有
 * sentence，但客户端可能仍在播放最后的 buffer。为剩余播放时长调度
 * 完成定时器，然后重置。
 */
function handlePipelineAllDone(): void {
  const mySession = pipelineSession;
  pipelineAllDoneFired = true;
  logger.debug('TTS-pipe', 'all sentences sent+synthesized — scheduling completion', {
    session: mySession,
    hasEngine: !!gainNode,
    paused: pipelinePaused,
    enqueued: enqueuedChunkCount,
    played: playedChunkCount,
  });

  // Defer to resumeAfterRecording: pause cancels any completion timer and
  // playback state is frozen. Resume re-runs this handler (flagged via
  // pipelineAllDoneFired) once audio can actually progress again.
  if (pipelinePaused) {
    pipelineAllDoneWhilePaused = true;
    logger.debug('TTS-pipe', 'onAllDone while paused — deferring completion to resume');
    return;
  }

  if (!audioCtx || !gainNode) {
    // 引擎从未达到预缓冲阈值。两种子情况：
    //   1. pendingChunks 有数据（总 PCM < PREBUFFER_MS，如短消息）
    //      — 现在强制启动引擎使缓冲的音频实际播放，然后继续调度
    //      完成定时器。
    //   2. 完全没有 PCM 到达 — 立即重置。
    if (pendingChunks.length > 0 && audioCtx) {
      logger.debug('TTS-pipe', 'engine not started but pending PCM exists — force-starting', {
        pendingChunks: pendingChunks.length,
        pendingMs: Math.round(pendingDurationMs),
      });
      const chunksToFlush = clearPending();
      const flushSampleRate = chunksToFlush[chunksToFlush.length - 1].sampleRate;

      initStreamingEngine(flushSampleRate);
      for (const chunk of chunksToFlush) {
        enqueuePcmChunk(chunk.data, chunk.sampleRate);
      }
      // 强制启动时也需要 start queueSource，否则引擎立刻播完。
      if (queueSource && audioCtx) {
        try {
          queueSource.start(audioCtx.currentTime, 0);
        } catch (e: unknown) {
          logger.warn('TTS-pipe', 'queueSource.start failed (force-start)', {
            message: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack : undefined,
          });
        }
      }
      duckMusicForSpeech();
      useTtsStore.setState({ isLoading: false, isPlaying: true });
      logger.debug('TTS-pipe', 'state → playing (force-started at completion)');
      // 继续调度后备完成定时器。
    } else {
      // 完全没有 PCM — 立即重置。
      resetPipeline(mySession);
      return;
    }
  }

  if (completionTimer) clearTimeout(completionTimer);
  // QueueSource 没有 nextStartTime — 用 queueAheadMs（已 enqueue 但未播完的时长）
  // 估算剩余播放时间，加上缓冲裕量。
  const remainingMs = Math.round(queueAheadMs) + 2000;
  logger.debug('TTS-pipe', 'scheduling fallback completion timer', {
    remainingMs,
    queueAheadMs: Math.round(queueAheadMs),
  });

  completionTimer = setTimeout(() => {
    completionTimer = null;
    if (mySession !== pipelineSession) {
      logger.debug('TTS-pipe', 'completion timer stale — ignoring');
      return;
    }
    logger.debug('TTS-pipe', 'pipeline completed (time-based)');
    resetPipeline(mySession);
  }, remainingMs);
}

/**
 * 重置 pipeline 驱动状态并清除 Zustand store。
 *
 * 调用方传入创建时捕获的 session ID；如果它不再匹配 pipelineSession
 *（已有更新的 pipeline 启动），重置为空操作。
 */
function resetPipeline(mySession: number): void {
  if (mySession !== pipelineSession) {
    logger.debug('TTS-pipe', 'reset skipped — stale session', { mySession, current: pipelineSession });
    return;
  }
  logger.debug('TTS-pipe', 'reset', { session: mySession });
  pipelineActive = false;
  pipelineMessageId = null;
  pipelineSentText = '';
  pipelineReceivedText = '';
  pipelineAllReceived = false;
  pipelineLastReceivedIdx = -1;
  pipelineAllSynthesized = false;
  // Per-pipeline completion flags. Do NOT touch pipelinePaused here: pause
  // belongs to the audio-session lifecycle (recording/video), not to this
  // pipeline — a new pipeline started mid-pause must keep buffering chunks.
  pipelineAllDoneWhilePaused = false;
  pipelineAllDoneFired = false;
  disposeStreamingEngine();
  // reset 只在自然完成（全部 chunk 已播完）或后备定时器到期时运行，
  // 即 TTS 播放确实结束 → 恢复被 duck 的音乐。
  resumeMusicAfterSpeech();
  useTtsStore.setState({ isPlaying: false, isLoading: false, currentlyPlayingId: null });
}

/**
 * 为 `messageId` 启动新的 TTS pipeline，包含指定的 `sentences`。
 *
 * 首先拆除任何现有的 pipeline。将 pipeline 服务的回调连接到
 * chunk/sentence-start/sentence-done/all-done/error 处理器。
 * pipeline session 递增，使前一个 pipeline 的过期回调被忽略。
 *
 * @param noMore 为 true 时，标记 pipeline 为"不会再有追加"，
 *   使完成在最后一句合成后立即触发。playVoice 设为 true
 *   （所有 sentence 已知）；enqueueText 留 false（流式，调用方
 *   须稍后调用 finishStream 标记完成）。
 */
function startPipeline(sentences: string[], messageId: string, noMore: boolean): void {
  // 拆除任何现有 pipeline（取消 WS，重置状态）。
  pipelineService.cancel();
  disposeStreamingEngine();

  pipelineSession++;
  const mySession = pipelineSession;
  pipelineActive = true;
  pipelineMessageId = messageId;
  pipelineSentCount = sentences.length;
  pipelineDoneCount = 0;
  pipelineNoMore = noMore;
  pipelineSentText = normalizeText(sentences.join(''));
  pipelineReceivedText = '';
  pipelineAllReceived = false;
  pipelineLastReceivedIdx = -1;
  pipelineAllSynthesized = false;
  // Fresh pipeline — completion flags from any previous session are stale.
  // (pipelinePaused is intentionally preserved: if a video/recording session
  // currently holds the pause, the new pipeline must buffer, not play.)
  pipelineAllDoneWhilePaused = false;
  pipelineAllDoneFired = false;

  logger.debug('TTS-pipe', 'startPipeline', {
    messageId,
    sentenceCount: sentences.length,
    noMore,
    session: mySession,
    lengths: sentences.map((s) => s.length),
  });

  useTtsStore.setState({
    isLoading: true,
    error: null,
    currentlyPlayingId: messageId,
    isPlaying: false,
  });

  pipelineService.pipelineStream(sentences, {
    onChunk: (idx, pcmData, sampleRate) => {
      if (mySession !== pipelineSession) return;
      handlePipelineChunk(idx, pcmData, sampleRate);
    },
    onSentenceStart: (idx, text) => {
      if (mySession !== pipelineSession) return;
      handlePipelineSentenceStart(idx, text);
    },
    onSentenceDone: (idx) => {
      if (mySession !== pipelineSession) return;
      handlePipelineSentenceDone(idx);
    },
    onAllDone: () => {
      if (mySession !== pipelineSession) {
        logger.debug('TTS-pipe', 'onAllDone stale — ignoring', { mySession, current: pipelineSession });
        return;
      }
      handlePipelineAllDone();
    },
    onError: (error) => {
      if (mySession !== pipelineSession) return;
      logger.warn('TTS-pipe', 'pipeline error:', error.message);
      pipelineService.cancel();
      resetPipeline(mySession);
      useTtsStore.setState({ error: error.message });
    },
  });
}

/**
 * 向活跃 pipeline 追加更多 sentence。无活跃 pipeline 或 pipeline 属于
 * 不同消息时为空操作。
 */
function appendToPipeline(sentences: string[], messageId: string): void {
  if (!pipelineActive || pipelineMessageId !== messageId) {
    logger.warn('TTS-pipe', 'appendToPipeline ignored — no matching active pipeline', {
      active: pipelineActive,
      activeMsgId: pipelineMessageId,
      requestedMsgId: messageId,
    });
    return;
  }
  if (sentences.length === 0) return;

  logger.debug('TTS-pipe', 'appendToPipeline', {
    messageId,
    added: sentences.length,
    lengths: sentences.map((s) => s.length),
  });
  pipelineSentCount += sentences.length;
  pipelineSentText += normalizeText(sentences.join(''));
  // 追加的文本使之前的覆盖率失效 — 在下次 audio.start 时重新检查。
  pipelineAllReceived = false;
  pipelineService.appendToPipeline(sentences);
}

// ─── Zustand store ─────────────────────────────────────────────

interface TtsState {
  /** 当前正在加载或播放的消息 ID。空闲时为 null。 */
  currentlyPlayingId: string | null;
  /** 音频正在播放时为 true。 */
  isPlaying: boolean;
  /** 正在获取 TTS 音频时为 true（WS 连接中，尚未收到 PCM）。 */
  isLoading: boolean;
  /** 最近一次失败的错误信息。 */
  error: string | null;

  /**
   * 页面失去焦点(用户切到其他页面)时设为 true。enqueueText 检查此
   * 标志，为 true 时不启动新 pipeline，从而防止流式自动播放在切页
   * 后继续播放。切回页面时不清除 — 由 finishStream 或新 messageId
   * 的 enqueueText 自动清除。
   */
  playbackSuppressed: boolean;
  /**
   * 被抑制的 messageId。首次 enqueueText 被抑制时记录，用于区分
   * "当前被抑制的消息"（继续抑制）和"新消息"（清除抑制，正常播放）。
   */
  suppressedMessageId: string | null;
  /** 设置播放抑制状态(由 ChatView 的 isFocused effect 调用)。 */
  setPlaybackSuppressed: (suppressed: boolean) => void;

  /**
   * 播放（或停止）一条消息的 TTS。
   *
   * - 如果同一 messageId 正在播放 → 切换为停止。
   * - 否则停止任何现有播放并启动新 pipeline。
   *
   * 所有 sentence 被拆分后通过单一 WebSocket 以 FIFO 顺序发送；
   * 服务端按顺序合成，客户端作为一个连续音频流播放。
   *
   * @returns true 表示播放已启动，false 表示已停止。
   */
  playVoice: (text: string, messageId: string) => Promise<boolean>;

  /** 停止所有 TTS 播放并清除状态。 */
  stopTtsPlayback: () => void;

  /**
   * 将流式文本加入自动播放 TTS 队列。Sentence 被追加到活跃 pipeline
   *（或为新 messageId 启动新 pipeline）。同一条 WS 承载所有 sentence
   * — 句间零延迟。
   */
  enqueueText: (text: string, messageId: string) => void;

  /**
   * 标记流式消息已完成（聊天 WS 结束）。此调用后，该 messageId
   * 不再允许追加 sentence。服务端合成完最后提交的 sentence 后，
   * 完成立即触发（无需 30 秒空闲等待）。
   *
   * 无匹配的活跃 pipeline 时为空操作。
   */
  finishStream: (messageId: string) => void;

  /** 停止自动播放：取消 pipeline，清除状态。 */
  stopAutoPlay: () => void;
}

export const useTtsStore = create<TtsState>((set, get) => ({
  currentlyPlayingId: null,
  isPlaying: false,
  isLoading: false,
  error: null,
  playbackSuppressed: false,
  suppressedMessageId: null,

  playVoice: async (text: string, messageId: string): Promise<boolean> => {
    logger.debug('TTS', 'playVoice called', { messageId, textLength: text.length });

    // 切换关闭：同一消息正在播放或加载中
    if (get().currentlyPlayingId === messageId && (get().isPlaying || get().isLoading)) {
      logger.debug('TTS', 'toggle off (same message playing)');
      get().stopTtsPlayback();
      return false;
    }

    // 用户手势入口：在此手势调用栈内立即创建/恢复 AudioContext，
    // 使原生音频会话在此手势内激活。
    prepareAudioContext();

    if (!text || !text.trim()) {
      logger.debug('TTS', 'playVoice rejected — empty text');
      return false;
    }

    const sentences = splitForTts(text);
    if (sentences.length === 0) {
      logger.debug('TTS', 'playVoice rejected — no sentences after split');
      return false;
    }

    logger.debug('TTS', 'playVoice split into sentences', {
      totalLen: text.length,
      count: sentences.length,
      lengths: sentences.map((s) => s.length),
    });

    startPipeline(sentences, messageId, true);
    return true;
  },

  stopTtsPlayback: () => {
    logger.debug('TTS', 'stopTtsPlayback');
    stopAllInternal();
    set({ isPlaying: false, isLoading: false, currentlyPlayingId: null });
  },

  enqueueText: (text: string, messageId: string) => {
    if (!text || !text.trim()) return;

    // ── 页面失焦抑制逻辑 ──
    // 切页面时 setPlaybackSuppressed(true) 被调用。此时:
    // - 首次被抑制(suppressedMessageId === null): 记录当前 messageId, return
    // - 同一条消息(messageId === suppressedMessageId): 继续抑制, return
    // - 新 messageId: 清除抑制, 正常处理(下次新 WS 恢复自动播放)
    if (get().playbackSuppressed) {
      const suppressedId = get().suppressedMessageId;
      if (suppressedId === null) {
        logger.debug('TTS', 'enqueueText suppressed — recording messageId', { messageId });
        set({ suppressedMessageId: messageId });
        return;
      }
      if (messageId === suppressedId) {
        logger.debug('TTS', 'enqueueText suppressed — same messageId', { messageId });
        return;
      }
      // 新 messageId → 清除抑制, 继续正常流程
      logger.debug('TTS', 'enqueueText — new messageId, clearing suppression', {
        suppressed: suppressedId,
        current: messageId,
      });
      set({ playbackSuppressed: false, suppressedMessageId: null });
    }

    const sentences = splitForTts(text);
    if (sentences.length === 0) {
      logger.debug('TTS', 'enqueueText skipped — empty after pipeline', {
        originalLen: text.length,
      });
      return;
    }

    // 新消息 → 启动新 pipeline。注意：这里不调用
    // prepareAudioContext（此处无用户手势）。调用方必须确保
    // 音频上下文已准备好（如通过 UI 中的自动播放开关），
    // 否则流式文本到达时不会有声音。
    if (pipelineMessageId !== messageId || !pipelineActive) {
      logger.debug('TTS', 'enqueueText — new pipeline', { messageId });
      // 如果有不同 pipeline 正在进行，先取消。
      if (pipelineActive && pipelineMessageId !== messageId) {
        pipelineService.cancel();
        pipelineSession++;
        disposeStreamingEngine();
        pipelineActive = false;
        pipelineMessageId = null;
      }
      startPipeline(sentences, messageId, false);
      return;
    }

    appendToPipeline(sentences, messageId);
    logger.debug('TTS', 'enqueueText appended', {
      messageId,
      count: sentences.length,
      originalLen: text.length,
    });
  },

  finishStream: (messageId: string) => {
    // WS 流结束 — 如果播放被抑制(用户切走页面), 清除抑制状态。
    // 这样下次新 WS 消息可以正常自动播放。
    if (get().playbackSuppressed) {
      logger.debug('TTS', 'finishStream — clearing playback suppression', { messageId });
      set({ playbackSuppressed: false, suppressedMessageId: null });
    }

    if (!pipelineActive || pipelineMessageId !== messageId) {
      logger.debug('TTS', 'finishStream — no matching active pipeline', {
        messageId,
        active: pipelineActive,
        activeMsgId: pipelineMessageId,
      });
      return;
    }
    logger.debug('TTS', 'finishStream — marking pipeline complete', {
      messageId,
      sent: pipelineSentCount,
      done: pipelineDoneCount,
    });
    markPipelineComplete();
  },

  stopAutoPlay: () => {
    logger.debug('TTS', 'stopAutoPlay');
    stopAllInternal();
    set({ isPlaying: false, isLoading: false, currentlyPlayingId: null });
  },

  setPlaybackSuppressed: (suppressed: boolean) => {
    if (get().playbackSuppressed === suppressed) return;
    logger.debug('TTS', 'setPlaybackSuppressed', { suppressed });
    set({ playbackSuppressed: suppressed });
  },
}));
