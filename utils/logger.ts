/**
 * Lightweight client-side logger with file persistence.
 *
 * Provides level-based logging (debug/info/warn/error) that mirrors entries
 * to an in-memory ring buffer and a JSONL file under expo-file-system.
 *
 * The buffer is capped at MAX_BUFFER_ENTRIES; oldest entries are dropped.
 * Other modules can read entries via getEntries() for archive/upload flows.
 *
 * Captures unhandled JS errors and promise rejections via ErrorUtils hooks
 * so they land in the same buffer for later upload.
 *
 * Runtime log-level gating:
 *   - `setMinimumLevel('debug' | 'info' | 'warn' | 'error')` to raise the
 *     threshold. Default in __DEV__ is 'debug', in production is 'info'.
 *   - `setSilencedScopes(['api', 'Gate'])` to mute specific scope tags
 *     regardless of level (handy when a noisy module's logs drown signal).
 *   - `EXPO_PUBLIC_LOG_LEVEL` and `EXPO_PUBLIC_LOG_SILENCE` env vars are
 *     read at module load time so a Metro restart picks them up without
 *     code changes:
 *       EXPO_PUBLIC_LOG_LEVEL=warn         → only warn+error
 *       EXPO_PUBLIC_LOG_LEVEL=error        → only error
 *       EXPO_PUBLIC_LOG_SILENCE=api,Gate   → mute those scopes entirely
 *
 * @module utils/logger
 */

import {
  documentDirectory,
  getInfoAsync,
  makeDirectoryAsync,
  writeAsStringAsync,
  deleteAsync,
} from 'expo-file-system/legacy';

const LOG_DIR = `${documentDirectory ?? ''}logs`;
const LOG_FILE = `${LOG_DIR}/kdoo-logs.jsonl`;

const MAX_BUFFER_ENTRIES = 1000;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const buffer: LogEntry[] = [];

let writeQueue: Promise<void> = Promise.resolve();

// ── Runtime gating ──

/**
 * Minimum level required for an entry to be emitted to the console and
 * persisted to the ring buffer / JSONL file.
 *
 * Defaults: __DEV__ → 'debug' (everything), production → 'info' (drops debug).
 * Can be overridden at startup via EXPO_PUBLIC_LOG_LEVEL env var.
 */
let minimumLevel: LogLevel =
  (process.env.EXPO_PUBLIC_LOG_LEVEL as LogLevel | undefined) ??
  (__DEV__ ? 'debug' : 'info');

/**
 * Scopes that should NEVER be emitted, regardless of level. Useful for
 * muting specific noisy modules without affecting the global threshold.
 * Loaded from EXPO_PUBLIC_LOG_SILENCE (comma-separated scope names).
 */
const silencedScopes: Set<string> = new Set(
  (process.env.EXPO_PUBLIC_LOG_SILENCE ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Raise/lower the global log threshold at runtime. */
export function setMinimumLevel(level: LogLevel): void {
  minimumLevel = level;
}

/** Read the current global log threshold. */
export function getMinimumLevel(): LogLevel {
  return minimumLevel;
}

/**
 * Replace the silenced-scopes set at runtime. Pass an empty array to
 * re-enable everything. Pass null to clear without re-enabling anything.
 */
export function setSilencedScopes(scopes: readonly string[]): void {
  silencedScopes.clear();
  for (const s of scopes) silencedScopes.add(s);
}

/** Read the current silenced-scopes list (copy — safe to mutate). */
export function getSilencedScopes(): string[] {
  return Array.from(silencedScopes);
}

// ── Persistence (JSONL append) ──

function persist(entry: LogEntry): void {
  writeQueue = writeQueue.then(async () => {
    try {
      const dirInfo = await getInfoAsync(LOG_DIR);
      if (!dirInfo.exists) {
        await makeDirectoryAsync(LOG_DIR, { intermediates: true });
      }
      const line = JSON.stringify(entry) + '\n';
      const fileInfo = await getInfoAsync(LOG_FILE);
      if (!fileInfo.exists) {
        await writeAsStringAsync(LOG_FILE, line, { encoding: 'utf8' });
      } else {
        await writeAsStringAsync(LOG_FILE, line, { encoding: 'utf8', append: true });
      }
    } catch {
      // Silent — file persistence is best-effort
    }
  });
}

function shouldEmit(level: LogLevel, scope: string): boolean {
  if (silencedScopes.has(scope)) return false;
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minimumLevel];
}

function record(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (!shouldEmit(level, scope)) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    data,
  };

  buffer.push(entry);
  if (buffer.length > MAX_BUFFER_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_BUFFER_ENTRIES);
  }

  persist(entry);

  const consoleFn =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(`[${scope}]`, message, data ?? '');
}

export const logger = {
  debug: (scope: string, message: string, data?: unknown) =>
    record('debug', scope, message, data),
  info: (scope: string, message: string, data?: unknown) =>
    record('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown) =>
    record('warn', scope, message, data),
  error: (scope: string, message: string, data?: unknown) =>
    record('error', scope, message, data),
};

export function getEntries(): readonly LogEntry[] {
  return buffer;
}

export async function clearEntries(): Promise<void> {
  buffer.length = 0;
  await writeQueue;
  try {
    await deleteAsync(LOG_FILE, { idempotent: true });
  } catch {
    // ignore
  }
}

export const LOG_FILE_PATH = LOG_FILE;

// ── Global error capture ──

let hooksInstalled = false;

export function installGlobalErrorHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  const errorUtils = (globalThis as any).ErrorUtils;
  if (errorUtils?.setGlobalHandler) {
    const previous = errorUtils.getGlobalHandler?.();
    errorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
      logger.error('global', error?.message ?? 'Unhandled error', {
        stack: error?.stack,
        isFatal: !!isFatal,
      });
      previous?.(error, isFatal);
    });
  }

  const tracking = (globalThis as any).HermesInternal?.enablePromiseRejectionTracker;
  if (typeof tracking === 'function') {
    tracking({
      allRejections: true,
      onUnhandled: (id: number, error: unknown) => {
        logger.error('promise', `Unhandled rejection #${id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }
}
