/**
 * In-app camera single-photo result channel.
 *
 * The dedicated /camera screen (expo-camera) captures a single photo and
 * hands the resulting Attachment back to whichever screen launched it —
 * ChatInputBar (to start a compose session) or photo-compose (to append to
 * an in-progress edit) — through this single, module-level callback. It is
 * the only channel by which the camera screen returns its result.
 *
 * One-shot semantics: `emitCameraResult` invokes the currently registered
 * handler exactly once and then clears it, so a single capture can never
 * deliver its result twice. Cancelling the camera screen calls
 * `clearCameraResultHandler` to discard the result without invoking anything.
 *
 * Design: docs/superpowers/specs/2026-07-24-photo-compose-design.md
 * (Plan B extension — in-app camera replaces the platform system camera on
 * native iOS/Android; web keeps the existing system-camera flow).
 */
import type { Attachment } from '@/types';

type CameraResultHandler = (attachment: Attachment) => void;

let cameraResultHandler: CameraResultHandler | null = null;

/** Register the single camera-result handler, replacing any previous one. */
export function setCameraResultHandler(handler: CameraResultHandler): void {
  cameraResultHandler = handler;
}

/** Invoke the current handler exactly once, then clear it. No-op if none is set. */
export function emitCameraResult(attachment: Attachment): void {
  const handler = cameraResultHandler;
  cameraResultHandler = null;
  handler?.(attachment);
}

/** Remove the handler without invoking it (used when the camera screen is cancelled). */
export function clearCameraResultHandler(): void {
  cameraResultHandler = null;
}
