/**
 * Persist voice-call transcript turns to the backend.
 * Falls into voiceStore.failedQueue on error for retry on call close.
 */
import { api } from './api'

export interface VoiceTranscriptTurnPayload {
  role: 'user' | 'assistant'
  text: string
  ts: number
  segmentId?: string
}

export const voiceTranscriptService = {
  /**
   * Persist a single transcript turn.
   * api.post<T>(path, body?) — body is positional 2nd arg (NOT {body:{}}).
   */
  async save(
    sessionId: string,
    turn: VoiceTranscriptTurnPayload,
  ): Promise<void> {
    await api.post(
      `/api/user/v1/sessions/${sessionId}/voice-transcripts`,
      { turns: [turn] },
    )
  },

  /**
   * Persist a batch of transcript turns (used by closeVoiceCall flush).
   */
  async saveBatch(
    sessionId: string,
    turns: VoiceTranscriptTurnPayload[],
  ): Promise<void> {
    if (turns.length === 0) return
    await api.post(
      `/api/user/v1/sessions/${sessionId}/voice-transcripts`,
      { turns },
    )
  },
}
