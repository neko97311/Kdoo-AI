import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
import { getWsBaseUrl } from './session-service';
import { logger } from '@/utils/logger';

const AUTH_STORAGE_KEY = 'auth_storage';
const TTS_WS_PATH = '/api/user/v1/audio/tts/stream/ws';
const DEFAULT_SAMPLE_RATE = 24000;

// ─── 本地 dump（用于确认接收完整性）──────────────────────────────
// 每条 pipeline 在 WS 关闭时把所有收到的 PCM chunk 拼成一个 raw PCM
// 文件写入缓存目录，同时落盘一份元数据 JSON（chunk 数、字节数、
// 采样率、句子文本）。这样设备调试时可以直接从 Files/AirDrop 取出，
// 离线比对服务端返回是否完整。整体 dump 而非按 sentence 分文件，
// 是为了减少文件系统调用次数、便于一次性听完整段。
const DUMP_ENABLED = process.env.EXPO_PUBLIC_DEBUG_TTS_PIPELINE_DUMP === 'true';

interface SentenceRecord {
  index: number;
  text: string;
  chunkCount: number;
  bytes: number;
}

interface DumpMeta {
  savedAt: string;
  sampleRate: number;
  totalChunks: number;
  totalBytes: number;
  sentences: SentenceRecord[];
}

function concatArrayBuffers(parts: ArrayBuffer[]): Uint8Array {
  const total = parts.reduce((s, b) => s + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), offset);
    offset += p.byteLength;
  }
  return out;
}

/**
 * 构造一个 16-bit PCM、单声道 WAV 头部（小端）。
 * - audioFormat = 1 (PCM)
 * - numChannels = 1
 * - bitsPerSample = 16
 */
function buildWavHeader(sampleRate: number, pcmByteLength: number): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcmByteLength, true); // RIFF chunk size
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // num channels = 1 (mono)
  view.setUint32(24, sampleRate, true); // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate (16-bit mono)
  view.setUint16(32, 2, true); // block align (channels * bytesPerSample)
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, pcmByteLength, true); // data chunk size

  return header;
}

async function writePipelineDump(
  sampleRate: number,
  chunks: ArrayBuffer[],
  sentences: SentenceRecord[],
): Promise<void> {
  if (chunks.length === 0) {
    logger.debug('TTS-pipeline', 'dump skipped — no PCM chunks received');
    return;
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const pcmBytes = concatArrayBuffers(chunks);
  const totalBytes = pcmBytes.byteLength;
  const totalChunks = chunks.length;

  // Paths.cache triggers new Directory() → this.validatePath() which is a
  // native-only call. Deferring from module scope to here so the module
  // can be safely imported on web without crashing at load time.
  const dumpDir = Paths.cache;
  const pcmPath = `${dumpDir.uri}tts-${stamp}.pcm`;
  const wavPath = `${dumpDir.uri}tts-${stamp}.wav`;
  const metaPath = `${dumpDir.uri}tts-${stamp}.json`;

  const pcmFile = new File(pcmPath);
  pcmFile.create({ overwrite: true });
  pcmFile.write(pcmBytes);

  const wavHeader = buildWavHeader(sampleRate, totalBytes);
  const wavBytes = new Uint8Array(wavHeader.byteLength + totalBytes);
  wavBytes.set(wavHeader, 0);
  wavBytes.set(pcmBytes, wavHeader.byteLength);
  const wavFile = new File(wavPath);
  wavFile.create({ overwrite: true });
  wavFile.write(wavBytes);

  const meta: DumpMeta = {
    savedAt: new Date().toISOString(),
    sampleRate,
    totalChunks,
    totalBytes,
    sentences,
  };
  const metaFile = new File(metaPath);
  metaFile.create({ overwrite: true });
  metaFile.write(JSON.stringify(meta, null, 2));

  logger.info('TTS-pipeline', 'dump saved', {
    pcmPath: pcmFile.uri,
    wavPath: wavFile.uri,
    metaPath: metaFile.uri,
    bytes: totalBytes,
    chunks: totalChunks,
    sentences: sentences.length,
    durationMs: Math.round((totalBytes / 2 / sampleRate) * 1000),
  });
}

export type PipelineChunkCallback = (
  sentenceIndex: number,
  pcmChunk: ArrayBuffer,
  sampleRate: number,
) => void;

export type PipelineSentenceStartCallback = (sentenceIndex: number, sentenceText: string) => void;
export type PipelineSentenceDoneCallback = (sentenceIndex: number) => void;
export type PipelineErrorCallback = (error: Error) => void;

export interface TtsPipelineOptions {
  onChunk: PipelineChunkCallback;
  onSentenceStart: PipelineSentenceStartCallback;
  onSentenceDone: PipelineSentenceDoneCallback;
  onAllDone?: () => void;
  onError?: PipelineErrorCallback;
}

export class TtsService {
  private sampleRate: number = DEFAULT_SAMPLE_RATE;

  private pipelineWs: WebSocket | null = null;
  private pipelineActive: boolean = false;
  private pipelineOptions: TtsPipelineOptions | null = null;
  private pipelineSentCount: number = 0;
  private pipelineCurrentIdx: number = -1;
  private pipelineChunkInSentence: number = 0;
  private pipelineTotalChunks: number = 0;
  private pipelineTotalBytes: number = 0;
  private pipelineOutbox: string[] = [];
  private pipelineDraining: boolean = false;
  private pipelineStartTime: number = 0;

  // 本地 dump 用的累积缓冲。
  private dumpChunks: ArrayBuffer[] = [];
  private dumpSentences: SentenceRecord[] = [];
  private dumpFlushed: boolean = false;

  private async getAuthToken(): Promise<string | null> {
    try {
      const stored = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.token || null;
      }
    } catch {
      // 忽略
    }
    return null;
  }

  pipelineStream(initialSentences: string[], options: TtsPipelineOptions): void {
    this.cancel();

    this.pipelineActive = true;
    this.pipelineOptions = options;
    this.pipelineSentCount = 0;
    this.pipelineCurrentIdx = -1;
    this.pipelineChunkInSentence = 0;
    this.pipelineTotalChunks = 0;
    this.pipelineTotalBytes = 0;
    this.pipelineOutbox = [...initialSentences];
    this.pipelineDraining = false;
    this.pipelineStartTime = Date.now();
    this.sampleRate = DEFAULT_SAMPLE_RATE;

    this.dumpChunks = [];
    this.dumpSentences = [];
    this.dumpFlushed = false;

    logger.info('TTS-pipeline', 'start', {
      initialCount: initialSentences.length,
      lengths: initialSentences.map((s) => s.length),
    });

    this.openPipelineWs().catch((e) => {
      logger.warn('TTS-pipeline', 'setup failed', e);
      this.pipelineActive = false;
      this.pipelineOptions = null;
      options.onError?.(e instanceof Error ? e : new Error(String(e)));
    });
  }

  appendToPipeline(sentences: string[]): void {
    if (!this.pipelineActive || !this.pipelineOptions) {
      logger.warn('TTS-pipeline', 'appendToPipeline ignored — no active pipeline');
      return;
    }
    if (sentences.length === 0) return;

    for (const s of sentences) this.pipelineOutbox.push(s);
    logger.debug('TTS-pipeline', 'appended', {
      added: sentences.length,
      outboxSize: this.pipelineOutbox.length,
      sentCount: this.pipelineSentCount,
    });

    if (this.pipelineWs && this.pipelineWs.readyState === WebSocket.OPEN) {
      this.drainPipelineOutbox();
    }
  }

  isPipelineActive(): boolean {
    return (
      this.pipelineActive &&
      !!this.pipelineWs &&
      this.pipelineWs.readyState === WebSocket.OPEN
    );
  }

  private createTtsWebSocket(token: string | null): WebSocket {
    let url = `${getWsBaseUrl()}${TTS_WS_PATH}`;
    if (token) url += `?user_token=${encodeURIComponent(token)}`;

    const ws = token
      ? new (WebSocket as any)(url, ['access_token', token], {
          headers: { Cookie: `user_token=${token}` },
        }) as WebSocket
      : new WebSocket(url);

    ws.binaryType = 'arraybuffer';
    return ws;
  }

  private async openPipelineWs(): Promise<void> {
    if (!this.pipelineActive || !this.pipelineOptions) return;

    const token = await this.getAuthToken();

    if (!this.pipelineActive || !this.pipelineOptions) {
      logger.debug('TTS-pipeline', 'cancelled during auth — aborting open');
      return;
    }

    const options = this.pipelineOptions;

    logger.debug('TTS-pipeline', 'WS connecting', {
      hasToken: !!token,
      outboxSize: this.pipelineOutbox.length,
    });

    const ws = this.createTtsWebSocket(token);
    this.pipelineWs = ws;

    ws.onopen = () => {
      if (!this.pipelineActive) return;
      logger.debug('TTS-pipeline', 'WS open', { outboxSize: this.pipelineOutbox.length });
      this.drainPipelineOutbox();
    };

    ws.onmessage = (event) => {
      if (!this.pipelineActive) return;
      const data = event.data;

      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          logger.debug('TTS-pipeline', 'recv', JSON.stringify(msg));
          this.handlePipelineControl(msg, options);
        } catch {
          // 忽略非 JSON 字符串
        }
      } else if (data instanceof ArrayBuffer) {
        this.pipelineChunkInSentence++;
        this.pipelineTotalChunks++;
        this.pipelineTotalBytes += data.byteLength;
        logger.debug('TTS-pipeline', 'chunk recv', {
          idx: this.pipelineCurrentIdx,
          inSentence: this.pipelineChunkInSentence,
          global: this.pipelineTotalChunks,
          bytes: data.byteLength,
          totalBytes: this.pipelineTotalBytes,
          elapsed: `${Date.now() - this.pipelineStartTime}ms`,
        });
        if (DUMP_ENABLED) {
          this.dumpChunks.push(data);
        }
        options.onChunk(this.pipelineCurrentIdx, data, this.sampleRate);
      }
    };

    ws.onerror = (e: any) => {
      if (!this.pipelineActive) return;
      logger.warn('TTS-pipeline', 'WS error', { error: String(e?.message || e) });
    };

    ws.onclose = (e: any) => {
      const wasActive = this.pipelineActive;
      logger.info('TTS-pipeline', 'WS closed', {
        code: e?.code,
        reason: e?.reason,
        sentCount: this.pipelineSentCount,
        currentIdx: this.pipelineCurrentIdx,
        totalChunks: this.pipelineTotalChunks,
        totalBytes: this.pipelineTotalBytes,
        wasActive,
      });

      // 抓拍 dump 数据：在清状态之前取值，因为 cancel 路径也会触发 onclose。
      const shouldFlush = DUMP_ENABLED && !this.dumpFlushed;
      const dumpSampleRate = this.sampleRate;
      const dumpChunks = this.dumpChunks;
      const dumpSentences = this.dumpSentences;
      if (shouldFlush) this.dumpFlushed = true;

      const opts = this.pipelineOptions;
      this.pipelineActive = false;
      this.pipelineWs = null;
      this.pipelineOptions = null;

      // 仅在自然/未 cancel 关闭时触发 onAllDone。
      // cancel() 会主动调用 pipelineOptions?.onAllDone?.()，避免双重触发。
      if (wasActive) opts?.onAllDone?.();

      if (shouldFlush) {
        writePipelineDump(dumpSampleRate, dumpChunks, dumpSentences).catch((err) => {
          logger.warn('TTS-pipeline', 'dump write failed', err);
        });
      }
    };
  }

  private drainPipelineOutbox(): void {
    if (!this.pipelineWs || this.pipelineWs.readyState !== WebSocket.OPEN) return;
    if (this.pipelineDraining) return;
    this.pipelineDraining = true;
    try {
      while (this.pipelineOutbox.length > 0 && this.pipelineWs.readyState === WebSocket.OPEN) {
        const text = this.pipelineOutbox.shift()!;
        this.pipelineWs.send(JSON.stringify({ text }));
        this.pipelineSentCount++;
        logger.debug('TTS-pipeline', 'sent', {
          idx: this.pipelineSentCount - 1,
          len: text.length,
          preview: text.slice(0, 400),
          remaining: this.pipelineOutbox.length,
        });
      }
    } finally {
      this.pipelineDraining = false;
    }
  }

  private handlePipelineControl(msg: any, options: TtsPipelineOptions): void {
    switch (msg.type) {
      case 'info':
        break;
      case 'connected':
        break;
      case 'audio.start': {
        const idx: number = typeof msg.sentence_index === 'number' ? msg.sentence_index : this.pipelineSentCount - 1;
        const text: string = typeof msg.sentence_text === 'string' ? msg.sentence_text : '';
        if (msg.sample_rate) this.sampleRate = msg.sample_rate;
        this.pipelineCurrentIdx = idx;
        this.pipelineChunkInSentence = 0;
        if (DUMP_ENABLED) {
          this.dumpSentences.push({ index: idx, text, chunkCount: 0, bytes: 0 });
        }
        logger.debug('TTS-pipeline', 'audio.start', { idx, sampleRate: this.sampleRate });
        options.onSentenceStart(idx, text);
        break;
      }
      case 'audio.done': {
        const idx: number = typeof msg.sentence_index === 'number' ? msg.sentence_index : this.pipelineCurrentIdx;
        const totalBytes: number = typeof msg.total_bytes === 'number' ? msg.total_bytes : 0;
        logger.debug('TTS-pipeline', 'audio.done', {
          idx,
          totalBytes,
          chunksInSentence: this.pipelineChunkInSentence,
        });
        if (DUMP_ENABLED) {
          const rec = this.dumpSentences.find((s) => s.index === idx && s.bytes === 0);
          if (rec) {
            rec.chunkCount = this.pipelineChunkInSentence;
            rec.bytes = totalBytes;
          }
        }
        options.onSentenceDone(idx);
        this.pipelineCurrentIdx = -1;
        break;
      }
      case 'error': {
        const message: string = typeof msg.message === 'string' ? msg.message : 'TTS server error';
        if (message.includes('Idle timeout')) {
          logger.debug('TTS-pipeline', 'server idle timeout — treating as drain');
          return;
        }
        logger.warn('TTS-pipeline', 'server error:', message);
        options.onError?.(new Error(message));
        break;
      }
      default:
        logger.debug('TTS-pipeline', 'unknown control', { type: msg.type });
        break;
    }
  }

  cancel(): void {
    // 抓拍 dump 数据再清状态 — cancel 不应丢已接收的 PCM。
    // ws.onclose 已被置 null（下面），不会再次触发写盘，所以这里
    // 必须主动 flush。
    const shouldFlush = DUMP_ENABLED && !this.dumpFlushed;
    const dumpSampleRate = this.sampleRate;
    const dumpChunks = this.dumpChunks;
    const dumpSentences = this.dumpSentences;
    if (shouldFlush) this.dumpFlushed = true;

    this.pipelineActive = false;
    this.pipelineOptions = null;
    this.pipelineOutbox = [];
    this.pipelineSentCount = 0;
    this.pipelineCurrentIdx = -1;
    this.pipelineChunkInSentence = 0;
    this.pipelineTotalChunks = 0;
    this.pipelineTotalBytes = 0;
    this.pipelineDraining = false;
    if (this.pipelineWs) {
      const ws = this.pipelineWs;
      this.pipelineWs = null;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch { /* 忽略 */ }
    }

    if (shouldFlush) {
      writePipelineDump(dumpSampleRate, dumpChunks, dumpSentences).catch((err) => {
        logger.warn('TTS-pipeline', 'dump write on cancel failed', err);
      });
    }
  }
}
