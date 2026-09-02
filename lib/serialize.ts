import type { ChatSession, ChatMessage } from '@/types';

/**
 * Revive `updatedAt` Date instances on rehydrated sessions.
 *
 * zustand/middleware's persist JSON.stringifies the partialized state on
 * write, which converts Date → ISO string. On rehydrate we must convert
 * back to Date so downstream sorting / time-grouping logic (which calls
 * getTime / Date arithmetic) keeps working.
 *
 * Defensive: tolerates already-Date values, missing fields, and malformed
 * strings (falls back to epoch).
 */
export function reviveSessions(
  sessions: ChatSession[] | undefined,
): ChatSession[] {
  if (!Array.isArray(sessions)) return [];
  return sessions.map((s) => ({
    ...s,
    updatedAt: toSafeDate((s as unknown as { updatedAt?: unknown }).updatedAt),
  }));
}

/**
 * Revive `createdAt` Date instances on every message in the messages dict.
 *
 * The persisted shape is `Record<sessionId, ChatMessage[]>`. Each message's
 * `createdAt` must be a Date for correct chronological ordering and render
 * formatting.
 */
export function reviveMessages(
  messages: Record<string, ChatMessage[]> | undefined,
): Record<string, ChatMessage[]> {
  if (!messages || typeof messages !== 'object') return {};
  const out: Record<string, ChatMessage[]> = {};
  for (const [sessionId, list] of Object.entries(messages)) {
    if (!Array.isArray(list)) {
      out[sessionId] = list;
      continue;
    }
    out[sessionId] = list.map((m) => ({
      ...m,
      createdAt: toSafeDate((m as unknown as { createdAt?: unknown }).createdAt),
    }));
  }
  return out;
}

function toSafeDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}
