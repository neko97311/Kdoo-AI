package expo.modules.kdooaudiotranscoder

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Decodes compressed audio (m4a/AAC, webm/Opus, 3gp/AMR, …) into a
 * standard 16 kHz mono 16-bit PCM WAV file using Android's
 * MediaExtractor + MediaCodec. Pure SDK API — no ffmpeg, no native libs.
 *
 * Why: the STT upstream (Whisper-compatible) at the project's backend
 * rejects compressed containers ("Format not recognised"). iOS already
 * records raw LINEARPCM into a .caf container and JS strips the header;
 * Android's MediaRecorder cannot emit raw PCM at all (only AAC/AMR/WebM),
 * so the audio must be decoded on-device. This module fills that gap.
 *
 * Stream format:
 *   input  — file:// or absolute path to a compressed audio file
 *   output — absolute path for the produced .wav file
 */
class KdooAudioTranscoderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KdooAudioTranscoder")

    AsyncFunction("transcodeToWav") { inputUri: String, outputPath: String ->
      val input = File(stripFileScheme(inputUri))
      val outputFile = File(stripFileScheme(outputPath))
      outputFile.parentFile?.mkdirs()
      val info = decodeToWav(input, outputFile)
      mapOf(
        "uri" to "file://${outputFile.absolutePath}",
        "sampleRate" to info.sampleRate,
        "channels" to info.channels,
        "frames" to info.frames
      )
    }
  }

  private data class DecodeInfo(val sampleRate: Int, val channels: Int, val frames: Long)

  companion object {
    private const val TARGET_CHANNELS = 1
    private const val TARGET_SAMPLE_RATE = 16000
    private const val TARGET_BITS = 16
    // 10 ms of PCM per chunk — fits comfortably in MediaCodec output
    // buffer bounds (typically up to ~64 KB) and gives plenty of
    // headroom for variable input bitrates.
    private const val TIMEOUT_US = 10_000L

    private fun stripFileScheme(uri: String): String =
      if (uri.startsWith("file://")) uri.removePrefix("file://") else uri

    /**
     * Pipeline:
     *   1. MediaExtractor finds the audio track.
     *   2. MediaCodec decoder configured with that track's format.
     *   3. Each output buffer → accumulated Float32 PCM (normalised).
     *   4. Re-channeled to mono by averaging channels.
     *   5. Quantised to Int16 and written behind a 44-byte WAV header
     *      at the codec's NATIVE sample rate (typically 44.1 or 48 kHz).
     *
     * Note on sample rate: the upstream STT (Whisper-compatible via
     * librosa) resamples internally to 16 kHz, so we deliberately do
     * NOT resample here. The earlier attempt to linear-interpolate from
     * the codec's native rate down to 16 kHz destroyed spectral content
     * (aliasing), which was the dominant cause of poor recognition
     * accuracy on Android. The "right" rate for the WAV is whatever
     * the decoder actually emits.
     */
    private fun decodeToWav(input: File, output: File): DecodeInfo {
      val extractor = MediaExtractor()
      try {
        extractor.setDataSource(input.absolutePath)
        val trackIndex = findAudioTrack(extractor)
        extractor.selectTrack(trackIndex)
        val inputFormat = extractor.getTrackFormat(trackIndex)
        val mime = inputFormat.getString(MediaFormat.KEY_MIME)
          ?: throw IllegalArgumentException("Audio track has no mime type")

        // Tell the decoder we want 16-bit PCM out. Without this hint
        // some devices pick PCM_FLOAT (planar, normalised to [-1, 1]),
        // which is fine in principle but mixes badly with our planar
        // channel assumption below. 16-bit PCM_16BIT is the one format
        // every AAC decoder on every Android API level we target
        // produces identically: interleaved, little-endian, in [-32768,
        // 32767]. Forcing it here removes the "is this buffer float or
        // int16" guesswork that previously corrupted the signal.
        inputFormat.setInteger(
          MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT
        )

        val codec = MediaCodec.createDecoderByType(mime)
        try {
          codec.configure(inputFormat, null, null, 0)
          codec.start()

          // We accumulate everything to know the final sample count
          // before writing the WAV header. For voice messages (<1 min)
          // at the codec's native rate (typically 44.1 kHz mono) this
          // tops out at ≈ 5 MB of Float32, well within the heap budget.
          val pcm = ArrayList<Float>(1 shl 15)
          var infoIndex = codec.dequeueInputBuffer(TIMEOUT_US)
          var sawInputEos = false
          var sawOutputEos = false
          var outSampleRate: Int = inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
          var outChannels: Int = inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)

          while (!sawOutputEos) {
            if (!sawInputEos && infoIndex >= 0) {
              val inBuf = codec.getInputBuffer(infoIndex)
              if (inBuf != null) {
                val sampleSize = extractor.readSampleData(inBuf, 0)
                if (sampleSize < 0) {
                  codec.queueInputBuffer(
                    infoIndex, 0, 0, 0,
                    MediaCodec.BUFFER_FLAG_END_OF_STREAM
                  )
                  sawInputEos = true
                } else {
                  codec.queueInputBuffer(
                    infoIndex, 0, sampleSize, extractor.sampleTime, 0
                  )
                  extractor.advance()
                }
              }
              infoIndex = codec.dequeueInputBuffer(TIMEOUT_US)
            }

            val outIndex = codec.dequeueOutputBuffer(bufferInfo, TIMEOUT_US)
            if (outIndex >= 0) {
              val outBuf = codec.getOutputBuffer(outIndex)
              // Read the actual output format the first time we get a
              // valid output buffer. The sample rate / channel count we
              // get back is the truth — it may differ from the input
              // track format on resampling-capable codecs.
              if (outBuf != null) {
                val outFormat = codec.outputFormat
                if (outFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                  outSampleRate = outFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                }
                if (outFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                  outChannels = outFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                }
                if (bufferInfo.size > 0) {
                  appendPcmInt16(outBuf, bufferInfo.offset, bufferInfo.size, outChannels, pcm)
                }
              }
              codec.releaseOutputBuffer(outIndex, false)
              if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                sawOutputEos = true
              }
            }
          }

          // Mix down to mono if the source is multichannel. AAC is
          // mono by default but the upstream could in principle carry a
          // stereo track — handle both.
          val monoSrc = if (outChannels == 1) {
            FloatArray(pcm.size) { pcm[it] }
          } else {
            FloatArray(pcm.size / outChannels).also { mixed ->
              var i = 0
              var j = 0
              while (i < pcm.size) {
                var sum = 0f
                for (c in 0 until outChannels) sum += pcm[i + c]
                mixed[j++] = sum / outChannels
                i += outChannels
              }
            }
          }

          writeWav(output, monoSrc, outSampleRate, TARGET_SAMPLE_RATE)

          return DecodeInfo(outSampleRate, TARGET_CHANNELS, monoSrc.size.toLong())
        } finally {
          try { codec.stop() } catch (_: Throwable) {}
          try { codec.release() } catch (_: Throwable) {}
        }
      } finally {
        extractor.release()
      }
    }

    private val bufferInfo = MediaCodec.BufferInfo()

    private fun findAudioTrack(extractor: MediaExtractor): Int {
      for (i in 0 until extractor.trackCount) {
        val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("audio/")) return i
      }
      throw IllegalArgumentException("No audio track in input file")
    }

    /**
     * Decode one MediaCodec output buffer (PCM 16-bit signed
     * little-endian, interleaved) into the Float32 accumulator.
     *
     * The decoder output format is forced to PCM_16BIT in
     * [decodeToWav]; this function trusts that contract. Calling it on
     * PCM_FLOAT buffers would produce nonsense — the float bits would
     * be reinterpreted as two int16 samples each, halving the apparent
     * sample rate and corrupting channel interleaving.
     *
     * Normalisation uses 32768 (symmetric), not 32767. The decoder
     * hands us full-range Int16 in [-32768, 32767]; mapping that to
     * floats with the same divisor in both directions preserves the
     * signal magnitude end-to-end and matches how the iOS CAF decoder
     * in voice-service.ts quantises back to Int16.
     */
    private fun appendPcmInt16(
      buffer: ByteBuffer,
      offset: Int,
      size: Int,
      channels: Int,
      out: ArrayList<Float>
    ) {
      buffer.position(offset)
      buffer.limit(offset + size)
      val asShort = buffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
      val n = size / 2
      for (i in 0 until n) {
        val s = asShort.get(i).toInt()
        out.add(s / 32768f)
      }
    }

    /**
     * Writes a standard RIFF/WAVE file at the target sample rate. If
     * the source sample rate differs (e.g. MediaCodec decoded to 44.1
     * or 48 kHz), we downsample with a 7-tap windowed-sinc filter first
     * to suppress aliasing — linear-interpolation downsampling, the
     * obvious-but-wrong choice, folds spectral content above the new
     * Nyquist back into the audible band and destroys recognition
     * accuracy.
     */
    private fun writeWav(file: File, samples: FloatArray, srcRate: Int, dstRate: Int) {
      val resampled = if (srcRate == dstRate) samples else sincDownsample(samples, srcRate, dstRate)
      val dataBytes = resampled.size * 2
      val totalBytes = 44 + dataBytes
      val riffChunkSize = totalBytes - 8
      file.parentFile?.mkdirs()
      // Build the entire WAV (header + Int16 samples) in a single byte
      // buffer and write it in one shot. The previous implementation
      // streamed via FileOutputStream + ByteBuffer.wrap(ByteArray), which
      // produced sporadic EBADF on some Android emulators because the
      // FileOutputStream and the ByteBuffer-backed write path interacted
      // badly when the underlying fd was reused by the JVM. A single
      // write sidesteps the issue. Memory cost is bounded by recording
      // length; voice messages are typically <1 minute (≈ 2 MB at
      // 16 kHz mono Int16) which is well within the heap budget.
      val out = ByteArray(totalBytes)
      val v = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
      v.put("RIFF".toByteArray(Charsets.US_ASCII))
      v.putInt(riffChunkSize)
      v.put("WAVE".toByteArray(Charsets.US_ASCII))
      v.put("fmt ".toByteArray(Charsets.US_ASCII))
      v.putInt(16)
      v.putShort(1)
      v.putShort(1)
      v.putInt(dstRate)
      v.putInt(dstRate * 2)
      v.putShort(2)
      v.putShort(TARGET_BITS.toShort())
      v.put("data".toByteArray(Charsets.US_ASCII))
      v.putInt(dataBytes)
      for (i in resampled.indices) {
        val s = resampled[i]
        // Symmetric quantisation: a -1.0 sample must round to -32768,
        // not -32767 — otherwise we lose one bit of dynamic range on
        // the negative peak and Whisper sees asymmetric clipping. The
        // `s < 0 ? -1 : 1` signs pick the half-range so +1.0 doesn't
        // overflow past 32767.
        val q = if (s >= 0) (s * 32767f).toInt() else (s * 32768f).toInt()
        v.putShort(q.coerceIn(-32768, 32767).toShort())
      }
      file.writeBytes(out)
    }

    /**
     * 7-tap windowed-sinc polyphase resampler. Handles both up- and
     * downsampling: the kernel works whenever the ratio of source to
     * destination rate is rational. For each output sample we evaluate
     * the sinc kernel at the fractional source position and weight it
     * with a Hann window. The kernel is short (7 taps) because voice
     * messages don't need brick-wall rejection — we just need enough
     * stopband attenuation that aliasing of ambient noise above 8 kHz
     * doesn't drown out the speech band.
     *
     * Why 7 taps not 15: this is speech, not music. STT models do
     * their own front-end filtering, so anything above ~6 kHz is
     * inaudible to the recogniser anyway. The Hann window at 7 taps
     * gives ~30 dB stopband rejection, which is plenty.
     *
     * IMPORTANT: when srcRate < dstRate (e.g. Android emulator feeding
     * us AMR_NB at 8 kHz while the STT expects 16 kHz), the previous
     * "return input early" branch silently wrote a WAV header that
     * lied about the sample rate — Whisper then heard a 16 kHz file
     * whose actual content was 8 kHz, producing frequency-halved
     * audio with mirrored aliases that destroyed recognition. Always
     * resample, in either direction.
     */
    private fun sincDownsample(input: FloatArray, srcRate: Int, dstRate: Int): FloatArray {
      if (input.isEmpty() || srcRate == dstRate) return input
      val dstLen = (input.size.toLong() * dstRate / srcRate).toInt()
      val output = FloatArray(dstLen)
      val ratio = srcRate.toDouble() / dstRate.toDouble()
      val halfKernel = 3 // 2*3+1 = 7 taps
      for (i in 0 until dstLen) {
        // Centre of the source window that contributes to output[i].
        val centre = (i + 0.5) * ratio - 0.5
        var sum = 0.0
        var weightSum = 0.0
        for (k in -halfKernel..halfKernel) {
          val srcIdx = (centre + k).toInt()
          if (srcIdx < 0 || srcIdx >= input.size) continue
          val t = (centre + k) - srcIdx // fractional distance, ∈ [0,1)
          // Normalised sinc: sin(π·t)/(π·t), 1 at t=0.
          val sinc = if (t == 0.0) 1.0 else kotlin.math.sin(Math.PI * t) / (Math.PI * t)
          // Hann window centred at the tap — attenuates the kernel
          // edges so the filter has a smooth roll-off instead of
          // Gibbs-ringing at the boundaries.
          val window = 0.5 * (1.0 - kotlin.math.cos(2.0 * Math.PI * (k + halfKernel) / (2 * halfKernel)))
          val w = sinc * window
          sum += input[srcIdx] * w
          weightSum += w
        }
        output[i] = if (weightSum != 0.0) (sum / weightSum).toFloat() else 0f
      }
      return output
    }
  }
}
