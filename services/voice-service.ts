import { isWeb } from '@/utils/platform';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File as FsFile, Paths, UploadType } from 'expo-file-system';
import { Platform } from 'react-native';
import { transcodeToWav } from '@/modules/kdoo-audio-transcoder';

const AUTH_STORAGE_KEY = 'auth_storage';

const STT_SAMPLE_RATE = 16000;

// ─── WAV conversion for mobile recordings ───────────────────────
// Both STT and voice clone upstream reject non-WAV containers ("Format not
// recognised"), so on mobile we always normalise the native recording to a
// 16 kHz mono RIFF/WAVE blob before uploading.
//   - iOS: AVAudioRecorder emits raw LINEARPCM 16-bit inside a .caf container.
//     We strip the CAF header in JS and repack as standard WAV.
//   - Android: MediaRecorder emits AAC inside MP4 (.m4a). We decode via the
//     kdoo-audio-transcoder native module (MediaExtractor + MediaCodec).
// Web uses MediaRecorder → webm/opus which is handled separately (see
// transcribeAudio's isWeb branch) and is not relevant here.

export interface ConvertedWav {
  /** Local file:// URI of the produced .wav (in cache). */
  uri: string;
  mimeType: 'audio/wav';
  filename: string;
}

/**
 * Convert a mobile recording (.caf on iOS, .m4a on Android) to a 16 kHz mono
 * WAV file in the cache directory. Returns the WAV URI; the caller uploads it.
 * Throws if conversion fails — the UI is expected to surface the error.
 */
export async function convertMobileRecordingToWav(audioUri: string): Promise<ConvertedWav> {
  if (audioUri.toLowerCase().endsWith('.caf')) {
    const sourceBytes = new Uint8Array(await new FsFile(audioUri).arrayBuffer());
    const { samples, sampleRate } = extractPcmFromCaf(sourceBytes);
    if (samples.length === 0) {
      throw new Error('CAF contained no PCM frames');
    }
    const wavBytes = encodeWavPcm16MonoFromInt16(samples, sampleRate);
    const wavFile = new FsFile(Paths.cache, 'recording.wav');
    wavFile.create({ overwrite: true });
    wavFile.write(wavBytes);
    return { uri: wavFile.uri, mimeType: 'audio/wav', filename: 'recording.wav' };
  }
  if (Platform.OS === 'android' && audioUri.toLowerCase().endsWith('.m4a')) {
    const wavFile = new FsFile(Paths.cache, 'recording.wav');
    const { uri } = await transcodeToWav(audioUri, wavFile.uri);
    return { uri, mimeType: 'audio/wav', filename: 'recording.wav' };
  }
  throw new Error(
    `convertMobileRecordingToWav: unsupported recording container (${audioUri})`,
  );
}


/**
 * Transcribe audio via the offline REST API.
 * POST /api/user/v1/audio/transcriptions
 *
 * On mobile: uses expo-file-system's native multipart upload (File.upload)
 *   which bypasses React Native's broken FormData/Blob implementation.
 *   Native recordings are AAC inside m4a (HIGH_QUALITY preset) and are
 *   uploaded as-is — the server must accept audio/mp4 on native clients.
 * On web: MediaRecorder produces webm/opus which most STT upstreams cannot
 *   decode without ffmpeg. We decode it via AudioContext, downmix to mono,
 *   resample to 16 kHz, then re-encode as 16-bit PCM WAV before upload.
 *
 * @param audioUri  Local file URI / blob URL of the recorded audio
 * @param language  Language code (e.g. 'auto', 'zh', 'en')
 * @returns Transcribed text
 */
export async function transcribeAudio(
  audioUri: string,
  language: string = 'auto',
): Promise<string> {
  const token = await getToken();

  // Build URL with query params
  const baseUrl =
    process.env.EXPO_PUBLIC_API_URL || 'https://api.example.com';
  const url = `${baseUrl}/api/user/v1/audio/transcriptions?language=${encodeURIComponent(language)}&model=whisper-1`;

  console.log('[Voice] Transcribing audio...', audioUri);

  try {
    if (isWeb) {
      const response = await fetch(audioUri);
      const webmBlob = await response.blob();
      const wavBytes = await transcodeToWavPcm(webmBlob, STT_SAMPLE_RATE);

      const formData = new FormData();
      formData.append('file', new Blob([wavBytes as unknown as BlobPart], { type: 'audio/wav' }), 'recording.wav');

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
        throw new Error(`STT API error (${res.status}): ${text}`);
      }

      const result = await res.json();
      console.log('[Voice] Transcription result:', result.text);
      return result.text || '';
    } else {
      // Mobile: use expo-file-system's native multipart upload.
      // React Native's FormData polyfill is broken in the new architecture
      // (SDK 56+): { uri, type, name } → "Unsupported FormDataPart implementation",
      // fetch(uri).blob() → "Creating blobs from 'ArrayBuffer' are not supported".
      // File.upload() handles multipart natively at the OS level.
      //
      // Decide the source mime from the recording container we know we
      // configured in ChatInputBar.tsx, NOT from the file extension. The
      // extension is reliable only when it actually matches the bytes —
      // mismatches have produced silent AAC-in-.caf files that upstream
      // STT rejects with "Format not recognised".
      const mimeType = Platform.OS === 'android'
        ? 'audio/mp4'           // AAC inside MP4 from MediaRecorder
        : 'audio/wav';          // raw PCM inside .caf from AVAudioRecorder

      const uploadHeaders: Record<string, string> = {};
      if (token) {
        uploadHeaders['Authorization'] = `Bearer ${token}`;
      }

      // iOS produces a .caf file with raw LINEARPCM 16-bit little-endian
      // samples (see ChatInputBar.tsx recording config). The STT upstream
      // rejects non-WAV containers with "Format not recognised", so we
      // parse the CAF header, strip the container, and re-pack the PCM
      // frames as a standard 16 kHz mono RIFF/WAVE blob. Android emits
      // AAC inside an MP4 container; we decode it on-device via the
      // kdoo-audio-transcoder module (MediaExtractor + MediaCodec) and
      // write a fresh WAV file the upstream can ingest.
      let uploadUri = audioUri;
      let uploadMimeType = mimeType;
      let uploadFilename = audioUri.split('/').pop() || 'recording.m4a';
      if (audioUri.toLowerCase().endsWith('.caf')) {
        try {
          const sourceBytes = new Uint8Array(await new FsFile(audioUri).arrayBuffer());
          const { samples, sampleRate, channels } = extractPcmFromCaf(sourceBytes);
          if (samples.length === 0) {
            throw new Error('CAF contained no PCM frames');
          }
          const wavBytes = encodeWavPcm16MonoFromInt16(samples, sampleRate);
          const wavFile = new FsFile(Paths.cache, 'recording.wav');
          wavFile.create({ overwrite: true });
          wavFile.write(wavBytes);
          uploadUri = wavFile.uri;
          uploadMimeType = 'audio/wav';
          uploadFilename = 'recording.wav';
        } catch (err) {
          console.warn('[Voice] Failed to repack CAF as WAV, falling back to raw upload:', err);
        }
      } else if (Platform.OS === 'android' && audioUri.toLowerCase().endsWith('.m4a')) {
        try {
          // Copy the raw m4a next to the WAV so the user can inspect both
          // on disk while diagnosing STT recognition issues. The cache
          // directory survives between launches on Android and is wiped
          // when the app is uninstalled.
          const stamp = new Date()
            .toISOString()
            .replace(/[:.]/g, '-')
            .replace('T', '_')
            .slice(0, 19);
          const sourceCopy = new FsFile(Paths.cache, `recording-${stamp}.m4a`);
          new FsFile(audioUri).copy(sourceCopy);

          const wavFile = new FsFile(Paths.cache, 'recording.wav');
          const { uri, sampleRate, frames } = await transcodeToWav(audioUri, wavFile.uri);
          uploadUri = uri;
          uploadMimeType = 'audio/wav';
          uploadFilename = 'recording.wav';
          const separator = '='.repeat(72);
          console.log(
            [
              '',
              separator,
              '[Voice] Android transcode → WAV',
              `  source:    ${sourceCopy.uri}`,
              `  sourceSize: ${sourceCopy.info().size ?? '?'} bytes`,
              `  wav:       ${uri}`,
              `  wavSize:   ${(new FsFile(uri)).info().size ?? '?'} bytes`,
              `  srcRate:   ${sampleRate} Hz (decoded native rate)`,
              `  dstRate:   16000 Hz (STT target)`,
              `  frames:    ${frames}`,
              separator,
              '',
            ].join('\n'),
          );
        } catch (err) {
          console.warn('[Voice] Failed to decode Android m4a to WAV, falling back to raw upload:', err);
        }
      }

      const file = new FsFile(uploadUri);
      const uploadResult = await file.upload(url, {
        httpMethod: 'POST',
        uploadType: UploadType.MULTIPART,
        fieldName: 'file',
        mimeType: uploadMimeType,
        parameters: uploadFilename ? { filename: uploadFilename } : undefined,
        headers: uploadHeaders,
      });

      if (uploadResult.status < 200 || uploadResult.status >= 300) {
        throw new Error(
          `STT API error (${uploadResult.status}): ${uploadResult.body}`,
        );
      }

      const result = JSON.parse(uploadResult.body);
      console.log('[Voice] Transcription result:', result.text);
      return result.text || '';
    }
  } catch (err: any) {
    console.error('[Voice] Transcription failed:', err.message);
    throw err;
  }
}

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

// ─── Web-specific: MediaRecorder helpers ───────────────────

/**
 * Check if MediaRecorder is available (web only).
 */
export function isMediaRecorderSupported(): boolean {
  return (
    isWeb &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}

/**
 * Start recording audio on web using MediaRecorder.
 * Returns an object with `stop()` method and a promise that resolves to the audio blob URI.
 */
export function startWebRecording(): {
  stop: () => Promise<string>;
  isRecording: boolean;
} {
  let mediaRecorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let isRecording = false;

  let resolvePromise: ((uri: string) => void) | null = null;
  let rejectPromise: ((err: Error) => void) | null = null;

  const promise = new Promise<string>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  // Capture references for the IIFE to avoid TS never-narrowing
  const _resolve = resolvePromise;
  const _reject = rejectPromise;

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
        },
      });

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      mediaRecorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        const uri = URL.createObjectURL(blob);
        stream?.getTracks().forEach((t) => t.stop());
        stream = null;
        isRecording = false;
        resolvePromise?.(uri);
      };

      mediaRecorder.onerror = () => {
        stream?.getTracks().forEach((t) => t.stop());
        stream = null;
        isRecording = false;
        rejectPromise?.(new Error('MediaRecorder error'));
      };

      mediaRecorder.start(100);
      isRecording = true;
    } catch (err: any) {
      (_reject as ((err: Error) => void) | null)?.(err);
    }
  })();

  return {
    stop: async () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      return promise;
    },
    get isRecording() {
      return isRecording;
    },
  };
}

// ─── Web-specific: webm/opus → 16 kHz mono PCM WAV transcode ────────────

/**
 * Decode a compressed audio Blob (typically webm/opus from MediaRecorder)
 * via AudioContext, then re-encode as 16-bit PCM WAV at the requested
 * sample rate. Avoids requiring ffmpeg on either the browser or the
 * upstream STT service.
 *
 * Must only be called on web — depends on `AudioContext` /
 * `OfflineAudioContext` which are browser-only APIs.
 */
async function transcodeToWavPcm(blob: Blob, outputSampleRate: number): Promise<Uint8Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    // Best-effort close; some browsers throw if called during active decode.
    decodeCtx.close().catch(() => undefined);
  }

  const channels = 1;
  const length = decoded.length;
  const sampleRate = decoded.sampleRate;
  const offlineCtx = new OfflineAudioContext(channels, length, sampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start();

  let rendered: AudioBuffer;
  try {
    rendered = await offlineCtx.startRendering();
  } catch (err) {
    throw new Error(`Failed to render audio: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pcm: Float32Array = rendered.getChannelData(0);
  let resampled: Float32Array = pcm;
  if (sampleRate !== outputSampleRate) {
    resampled = resampleLinear(pcm, sampleRate, outputSampleRate);
  }

  return encodeWavPcm16Mono(resampled, outputSampleRate);
}

/**
 * Linear interpolation resampler. Good enough for speech (16 kHz output)
 * where the input is already band-limited to the voice range.
 */
function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (toRate === fromRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcIdx - i0;
    output[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return output;
}

/**
 * Pack a mono Float32 PCM stream into a 16-bit PCM WAV container with
 * a standard RIFF header. Resulting Blob has MIME type `audio/wav` and
 * is accepted by virtually every STT upstream (Whisper, Paraformer, etc.).
 */
function encodeWavPcm16Mono(samples: Float32Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const intVal = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(offset, intVal, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

/**
 * Same layout as {@link encodeWavPcm16Mono} but takes already-quantized
 * Int16 samples. Used when the source is a CAF file that already contains
 * 16-bit linear PCM — skipping the float→int quantisation step preserves
 * full precision (avoids a round-trip through [-1, 1] floats).
 */
function encodeWavPcm16MonoFromInt16(samples: Int16Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, samples[i]!, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

// ─── CAF (Apple Core Audio Format) container parsing ───────────────────
// CAF header: "caff" magic + 4-byte version + 4-byte flags (skip these 8
// bytes after magic). Then a sequence of chunks:
//   each chunk = 4-byte ASCII type + 8-byte int64 size + <size> bytes data.
// The chunks we need:
//   "desc" — AudioFormat description (4-byte sampleRate float64, 4-byte
//            format ID, 4-byte format flags, 4-byte bytes-per-packet, ...
//            we only consume sampleRate + format ID + channels + bits).
//   "data" — Raw PCM frames (when format ID is kAudioFormatLinearPCM = 0x6C70636D).
// iOS AVAudioRecorder with LINEARPCM + .caf writes exactly this layout.

const CAF_HEADER_BYTES = 8; // magic (4) + version (2) + flags (2)
const CAF_FORMAT_LINEARPCM = 0x6c70636d; // 'lpcm' fourcc
const CAF_FORMAT_FLOAT32 = 0x63666366; // 'cf32' (32-bit float)

type CafExtraction = {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
};

function extractPcmFromCaf(bytes: Uint8Array): CafExtraction {
  if (bytes.length < CAF_HEADER_BYTES) {
    throw new Error('CAF file too small');
  }
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== 'caff') {
    throw new Error(`Not a CAF file (magic=${magic})`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = CAF_HEADER_BYTES;
  let sampleRate = 0;
  let formatId = 0;
  let formatFlags = 0;
  let bytesPerPacket = 0;
  let channelsPerFrame = 0;
  let bitsPerChannel = 0;
  let dataOffset = -1;
  let dataSize = -1;
  let editCount = 1;

  while (offset + 12 <= bytes.length) {
    const chunkType = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    // CAF chunk size is 8-byte big-endian int64 (high then low)
    const sizeHigh = view.getUint32(offset + 4, false);
    const sizeLow = view.getUint32(offset + 8, false);
    const chunkSize = sizeHigh * 0x1_0000_0000 + sizeLow;
    const headerLen = 12;
    const dataStart = offset + headerLen;
    const alignedStart = dataStart + ((chunkSize % 4) ? 4 - (chunkSize % 4) : 0);

    if (chunkType === 'desc') {
      // AudioFormat: sampleRate float64 (offset 0), formatID uint32 (8),
      // formatFlags uint32 (12), bytesPerPacket uint32 (16),
      // framesPerPacket uint32 (20), channelsPerFrame uint32 (24),
      // bitsPerChannel uint32 (28). We only consume what we need.
      sampleRate = view.getFloat64(dataStart + 0, false);
      formatId = view.getUint32(dataStart + 8, false);
      formatFlags = view.getUint32(dataStart + 12, false);
      bytesPerPacket = view.getUint32(dataStart + 16, false);
      channelsPerFrame = view.getUint32(dataStart + 24, false);
      bitsPerChannel = view.getUint32(dataStart + 28, false);
    } else if (chunkType === 'data') {
      dataOffset = dataStart;
      dataSize = chunkSize;
      // We can stop scanning — 'data' is the last meaningful chunk we need.
      break;
    } else if (chunkType === 'edit') {
      // CAF 'edit' chunk has a special layout: 4-byte mNumEntries followed
      // by that many 16-byte entries. We just need to skip past it; the
      // data chunk's size already excludes edited-out bytes.
      editCount = view.getUint32(dataStart, false);
      // chunkSize already reflects the whole edit chunk.
    }

    offset = alignedStart + chunkSize;
    if (editCount > 1 && chunkType === 'edit') {
      // No-op: editCount is informational, chunk size handles skipping.
      void editCount;
    }
  }

  if (sampleRate === 0 || channelsPerFrame === 0 || bitsPerChannel === 0) {
    throw new Error('CAF missing or malformed "desc" chunk');
  }
  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error('CAF missing "data" chunk');
  }
  if (formatId !== CAF_FORMAT_LINEARPCM && formatId !== CAF_FORMAT_FLOAT32) {
    throw new Error(
      `CAF format 0x${formatId.toString(16)} is not raw PCM (need lpcm=0x6c70636d or cf32=0x63666366)`,
    );
  }
  if (bitsPerChannel !== 16 && bitsPerChannel !== 32) {
    throw new Error(`CAF bit depth ${bitsPerChannel} not supported (need 16 or 32)`);
  }

  const pcmBytes = bytes.subarray(dataOffset, dataOffset + dataSize);
  let monoInt16: Int16Array;
  let monoChannels = channelsPerFrame;

  if (formatId === CAF_FORMAT_FLOAT32) {
    // 32-bit big-endian (CAF default) or little-endian (formatFlags bit 1)
    const littleEndian = (formatFlags & 0x02) !== 0;
    const frameCount = Math.floor(pcmBytes.length / 4 / channelsPerFrame);
    const interleaved = new Float32Array(frameCount * channelsPerFrame);
    for (let i = 0; i < interleaved.length; i++) {
      interleaved[i] = view.getFloat32(dataOffset + i * 4, littleEndian);
    }
    monoInt16 = downmixAndQuantize(interleaved, channelsPerFrame);
  } else {
    // LINEARPCM 16-bit
    const littleEndian = (formatFlags & 0x02) !== 0;
    const frameCount = Math.floor(pcmBytes.length / 2 / channelsPerFrame);
    const interleaved = new Int16Array(frameCount * channelsPerFrame);
    for (let i = 0; i < interleaved.length; i++) {
      interleaved[i] = view.getInt16(dataOffset + i * 2, littleEndian);
    }
    monoInt16 = downmixInt16(interleaved, channelsPerFrame);
    void bytesPerPacket;
  }

  // Resample to 16 kHz if needed (most STT upstreams expect 16 kHz mono).
  let finalSamples = monoInt16;
  if (Math.round(sampleRate) !== STT_SAMPLE_RATE) {
    const ratio = sampleRate / STT_SAMPLE_RATE;
    const outLength = Math.round(monoInt16.length / ratio);
    const resampled = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcIdx = i * ratio;
      const i0 = Math.floor(srcIdx);
      const i1 = Math.min(i0 + 1, monoInt16.length - 1);
      const t = srcIdx - i0;
      const v = monoInt16[i0]! * (1 - t) + monoInt16[i1]! * t;
      resampled[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
    finalSamples = resampled;
    monoChannels = 1;
  }

  return {
    samples: finalSamples,
    sampleRate: STT_SAMPLE_RATE,
    channels: monoChannels,
  };
}

/**
 * Average multiple channels of interleaved Int16 PCM into a single mono
 * Int16 buffer using linear averaging.
 */
function downmixInt16(interleaved: Int16Array, channels: number): Int16Array {
  if (channels === 1) return interleaved;
  const frameCount = Math.floor(interleaved.length / channels);
  const out = new Int16Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += interleaved[f * channels + c]!;
    }
    out[f] = Math.round(sum / channels);
  }
  return out;
}

/**
 * Quantize 32-bit float PCM (range [-1, 1]) to Int16 mono. Used when the
 * CAF container holds float samples instead of 16-bit integers.
 */
function downmixAndQuantize(interleaved: Float32Array, channels: number): Int16Array {
  const frameCount = Math.floor(interleaved.length / channels);
  const out = new Int16Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += interleaved[f * channels + c]!;
    }
    const avg = sum / channels;
    const clamped = Math.max(-1, Math.min(1, avg));
    out[f] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return out;
}
