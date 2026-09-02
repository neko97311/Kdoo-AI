// ── v18g PLATFORM SHIM: native ──────────────────────────────────────────────
// Web bundling would otherwise eagerly resolve the entire `react-native-nitro-markdown`
// dependency graph — which transitively pulls `ratex-react-native` → RN internals
// (codegenNativeComponent, setUpReactDevTools, ...). Those internal relative paths
// are unstable across RN minor versions and break the web bundler.
//
// By exporting from a `.native.ts` extension, Metro only resolves this file on
// native platforms (iOS / Android). The web bundler never enters this module.
//
// ── v18p: lazy require factory ──────────────────────────────────────────────
// Top-level `import { createMarkdownSession } from 'react-native-nitro-markdown'`
// would resolve the entire nitro-markdown module graph at RN startup. That graph
// pulls in `react-native-nitro-modules` → `installWorkletsSupport()` (calls
// `NitroModules.box(NitroModules)` and registers a worklets serializer) at module
// init time. On this app's dependency mix (worklets + nitro-markdown already in
// `.pnpm` from peer deps) the worklets proxy and nitro proxy form a self-recursive
// `get NativeModules` loop during module init, blowing the JS stack with
// "RangeError: Maximum call stack size exceeded".
//
// We instead expose a factory whose body does the require lazily — only when
// `createMarkdownSession()` is actually called from a chat page render. By then
// the app's normal module graph has already finished initializing, so the
// worklets/nitro proxies are stable and no circular init loop occurs.
//
// We keep the `MarkdownSession` type as a pure `import type` so TypeScript
// types are still available without dragging the runtime module into the type
// graph at all (TS erases `import type` statements).
import type { MarkdownSession as MarkdownSessionSpec } from 'react-native-nitro-markdown';

export type MarkdownSession = MarkdownSessionSpec;

/**
 * Lazy factory that resolves `react-native-nitro-markdown` on first call.
 *
 * Returns the `MarkdownSession` HybridObject (C++ native session) that the
 * streaming store uses to incrementally parse markdown deltas off the JS
 * thread. See `stores/streaming.ts` for the owning Map keyed by messageId.
 *
 * The first call pays the cost of evaluating the entire
 * `react-native-nitro-markdown` + `react-native-nitro-modules` graph — but
 * this happens lazily on the chat page, not at RN startup, so it does not
 * race with `installWorkletsSupport()` registration during module init.
 */
export function createMarkdownSession(initialText?: string): MarkdownSession {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createMarkdownSession: factory } = require('react-native-nitro-markdown');
  return factory(initialText);
}
