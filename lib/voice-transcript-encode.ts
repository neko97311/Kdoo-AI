/**
 * Pure functions to encode TranscriptItem into ChatMessage rows
 * for SQLite persistence, plus a detector for transcript-origin rows.
 */
import type { ChatMessage, MessageContent } from '@/types'
import type { TranscriptItem } from '@/types/voice-transcript'

const TRANSCRIPT_ID_PREFIX = 'vt_'

/** djb2 variant — 32-bit hash, hex output. Collision probability is
 *  negligible for LiveKit segmentId strings (<1000 per session). */
function hashString(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) + input.charCodeAt(i)
    h = h & h
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Deterministic SQLite row id for a transcript segment.
 *  Format: `vt_<hash8>` — prefix distinguishes voice rows from chat rows
 *  so isTranscriptMessage can identify origin without a separate column. */
export function makeTranscriptLocalId(segmentId: string): string {
  return `${TRANSCRIPT_ID_PREFIX}${hashString(segmentId)}`
}

/** Convert a TranscriptItem into a ChatMessage row for SQLite persistence.
 *  Reuses TextContent variant with `state` so ChatBubble renders it the
 *  same as streaming chat messages (interim vs final). */
export function transcriptToChatMessage(
  item: TranscriptItem,
  sessionId: string,
  localId?: string,
): ChatMessage {
  const id = localId ?? makeTranscriptLocalId(item.segmentId)
  const content: MessageContent[] = [{
    type: 'text',
    text: item.text || '',
    state: item.isFinal ? 'completed' : 'streaming',
  }]
  return {
    id,
    sessionId,
    role: item.role,
    content,
    createdAt: new Date(item.createdAt),
  }
}

/** Detect whether a ChatMessage originated as a voice transcript.
 *  Used by loadMessages reconciliation and replay paths. */
export function isTranscriptMessage(msg: Pick<ChatMessage, 'id'>): boolean {
  return msg.id.startsWith(TRANSCRIPT_ID_PREFIX)
}
