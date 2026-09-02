// ── v18g PLATFORM SHIM: web ────────────────────────────────────────────────
// Web is a non-production target (only used for static previews / Storybook-
// style demos). The production targets are iOS + Android. We don't want web
// to pull in the entire `react-native-nitro-markdown` dependency graph
// (see `markdownSession.native.ts` for why).
//
// This stub mirrors the native `MarkdownSession` API shape (append / reset /
// dispose / getAllText) using a plain string buffer so the web build
// compiles and the streaming logic still works on the JS side — the
// rendered text just isn't incrementally parsed into native markdown ASTs
// (we render the cumulative `<Text>` directly via `MarkdownRenderer.web.tsx`
// which already is a pure-text fallback).

export interface MarkdownSession {
  append(delta: string): void;
  reset(text: string): void;
  dispose(): void;
  getAllText(): string;
}

export function createMarkdownSession(initialText: string = ''): MarkdownSession {
  let buffer = initialText;
  let disposed = false;
  return {
    append(delta) {
      if (disposed) return;
      buffer += delta;
    },
    reset(text) {
      if (disposed) return;
      buffer = text;
    },
    dispose() {
      disposed = true;
      buffer = '';
    },
    getAllText() {
      return buffer;
    },
  };
}
