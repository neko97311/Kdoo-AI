/**
 * A single voice-conversation transcript item.
 * One segmentId corresponds to one utterance (multiple interim chunks + one final).
 */
export interface TranscriptItem {
  /** LiveKit lk.segment_id — unique per utterance */
  segmentId: string
  /** Who spoke this segment */
  role: 'user' | 'assistant'
  /** Current text (interim gets replaced by final as it streams in) */
  text: string
  /** Whether this segment is finalized (user stopped speaking) */
  isFinal: boolean
  /** Epoch milliseconds */
  createdAt: number
  /** Optional local SQLite row id. Assigned on first flush to SQLite.
   *  Format: `vt_<hash8>` (deterministic, see voice-transcript-encode.ts).
   *  Undefined while the segment lives only in memory. */
  localId?: string
}

/**
 * Failed-to-persist transcript queued for retry on close.
 */
export interface FailedTranscriptJob {
  sessionId: string
  turn: {
    role: 'user' | 'assistant'
    text: string
    ts: number
    segmentId: string
  }
}

/**
 * Voice call modal view mode (avatar vs live transcript text).
 */
export type VoiceViewMode = 'avatar' | 'text'
