import React, { Component, memo, Suspense, useMemo, type ReactNode } from 'react';
import { View, Text, Linking } from 'react-native';
import { router } from 'expo-router';
import type {
  CustomRenderers,
  CustomRendererProps,
  LinkRendererProps,
  ImageRendererProps,
  HeadingRendererProps,
  MarkdownSession,
  MarkdownTheme,
  PartialMarkdownTheme,
} from 'react-native-nitro-markdown';
import { useResolvedScheme, useColors, type ColorTokens } from '@/hooks/useColors';

// ── v18p: lazy-load nitro-markdown components & theme helpers ──────────────
//
// Top-level `import { Markdown, MarkdownStream, darkMarkdownTheme, ... } from
// 'react-native-nitro-markdown'` resolves the entire nitro-markdown module
// graph at RN startup. That graph transitively pulls in
// `react-native-nitro-modules` → `installWorkletsSupport()` (registers a
// worklets serializer by calling `NitroModules.box(NitroModules)`) at module
// init time. On this app's dep mix the worklets proxy and nitro proxy form a
// self-recursive `get NativeModules` loop during init, blowing the JS stack
// with "RangeError: Maximum call stack size exceeded".
//
// We instead:
//   - Wrap `Markdown` and `MarkdownStream` in `React.lazy(() => ...)` so the
//     nitro-markdown module is only evaluated on the FIRST render of a chat
//     bubble, not at app boot.
//   - Move `darkMarkdownTheme` / `defaultMarkdownTheme` / `mergeThemes` access
//     into a `getTheme()` helper that lazily `require()`s the package the
//     first time it is called (and memoizes the merged theme per scheme).
//
// Type-only imports (`import type { ... }`) are erased by TypeScript so they
// never trigger runtime module evaluation.
const Markdown = React.lazy(() =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  import('react-native-nitro-markdown').then((m) => ({ default: m.Markdown })),
);
const MarkdownStream = React.lazy(() =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  import('react-native-nitro-markdown').then((m) => ({ default: m.MarkdownStream })),
);

type NitroTheme = MarkdownTheme;
let _themesCache: { dark: NitroTheme; light: NitroTheme } | null = null;

function getThemes() {
  if (_themesCache) return _themesCache;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { darkMarkdownTheme, defaultMarkdownTheme } = require('react-native-nitro-markdown');
  _themesCache = { dark: darkMarkdownTheme, light: defaultMarkdownTheme };
  return _themesCache;
}

function mergeThemes(base: NitroTheme, overrides: PartialMarkdownTheme): NitroTheme {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mergeThemes: merge } = require('react-native-nitro-markdown');
  return merge(base, overrides);
}

/**
 * Suspense fallback while the lazy `Markdown`/`MarkdownStream` chunk is
 * being downloaded + initialized. The first render after app boot pays this
 * cost; subsequent renders use the cached chunk and skip the fallback.
 *
 * We render plain text here so the user sees something while the native
 * session warms up. We also keep the citation-injection transform applied
 * so any `[N]` markers visible in the fallback are still converted to
 * `[[N]](url)` form (matching the final rendered output).
 */
function MarkdownFallback({ text, sources }: { text: string; sources?: { url: string }[] }) {
  const processedText = useMemo(() => injectCitationLinks(text, sources), [text, sources]);
  return (
    <Text className="text-body-md leading-6 text-aura-on-surface" selectable>
      {processedText}
    </Text>
  );
}

// REMOVED in v18p: dead-code mdParser from the old markdown-display impl.
// nitro-markdown handles parsing internally in C++; no JS-side parser needed.

const MARKDOWN_OPTIONS = { gfm: true, math: false, html: false, sourceOffsets: true } as const;

/**
 * Marker prefix placed inside the URL hash so the custom `link` render
 * rule can distinguish injected citation links from regular markdown
 * links and route them to the in-app WebView page instead of the system
 * browser.
 *
 * Using a hash marker (rather than a custom URL scheme) avoids any risk
 * of markdown-it or downstream rendering percent-encoding the `:` that
 * would separate a scheme from the URL. The link rule strips the marker
 * hash and forwards the remaining URL to router.push('/webview').
 *
 * Example:
 *   Real source:        https://example.com/article
 *   Injected markdown:  [[1]](https://example.com/article#kdooref)
 *   Link rule extracts: https://example.com/article
 */
const CITATION_MARKER = '#kdooref';

/**
 * Convert inline citation markers like [1], [2], 【1】, ［1］ into markdown
 * links pointing to the corresponding source URL from SearXNG results.
 *
 * Supports half-width `[N]` plus full-width `【N】` and `［N］` (common in
 * CJK model output). Negative lookahead `(?!\(|\])` skips:
 *   - `[N](url)`  — already a markdown link
 *   - `[N]]`      — inner bracket of an existing `[[N]](url)` wrapper
 *
 * Output uses `[[N]](URL#kdooref)` so the markdown renderer keeps the
 * visible `[N]` brackets (instead of consuming them as link-text
 * delimiters), and so the link rule can recognise citation links by
 * their `#kdooref` hash marker and route them to the in-app WebView
 * page.
 */
function injectCitationLinks(text: string, sources?: { url: string }[]): string {
  if (!sources || sources.length === 0) return text;
  const citationRegex = /(\[|【|［)(\d+)(\]|】|］)(?!\(|\])/g;
  return text.replace(citationRegex, (match, _open: string, numStr: string, _close: string) => {
    const num = parseInt(numStr, 10);
    if (num < 1 || num > sources.length) return match;
    const url = sources[num - 1]?.url;
    if (!url) return match;
    return `[[${num}]](${url}${CITATION_MARKER})`;
  });
}

class MarkdownErrorBoundary extends Component<
  { children: ReactNode; fallbackText: string },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownErrorBoundary] NitroMarkdown failed, falling back to plain text:', error.message);
  }
  render() {
    if (this.state.hasError) {
      return (
        <Text className="text-body-md leading-6 text-aura-on-surface" selectable>
          {this.props.fallbackText}
        </Text>
      );
    }
    return this.props.children;
  }
}

// ── Custom renderers (nitro-markdown API) ───────────────────────────
//
// Each renderer receives { node, children, Renderer } plus type-specific props.
// We override a few defaults to preserve the look + behavior from the old
// react-native-markdown-display implementation:
//   - paragraph: tighten bottom margin (was 4)
//   - link: open in external browser via Linking (old default already did this)
//   - image: wrap in a fixed-height container with rounded corners
//
// Heading sizes + code/blockquote/list/table styling come from `theme.colors`
// + `styles` overrides on the <Markdown> component — no per-node JSX needed.
//
// Note: the old `softbreak`/`hardbreak` → '\n' rule is no longer needed
// here. react-native-nitro-markdown handles line breaks natively based on
// AST node type; emitting '\n' from a custom soft_break renderer would
// double-insert line breaks.
//
// Note on `key` props: nitro-markdown handles React `key` assignment
// internally based on AST node identity, so we never need to provide our
// own `key` from `props.node`. Attempting to read `props.node.key` is a
// type error because `MarkdownNode` does not expose a `key` field.

function buildCustomRenderers(colors: ColorTokens): CustomRenderers {
  return {
    paragraph: ((props: CustomRendererProps) => {
      return (
        <Text style={{ marginBottom: 4 }}>
          {props.children}
        </Text>
      );
    }) as CustomRenderers['paragraph'],

    heading: ((props: HeadingRendererProps) => {
      const sizeMap: Record<number, { fontSize: number; lineHeight: number; marginTop: number; marginBottom: number; fontWeight: '700' | '600' }> = {
        1: { fontSize: 22, lineHeight: 30, marginTop: 10, marginBottom: 4, fontWeight: '700' },
        2: { fontSize: 19, lineHeight: 26, marginTop: 8, marginBottom: 3, fontWeight: '700' },
        3: { fontSize: 16, lineHeight: 22, marginTop: 8, marginBottom: 2, fontWeight: '600' },
        4: { fontSize: 15, lineHeight: 20, marginTop: 6, marginBottom: 2, fontWeight: '600' },
        5: { fontSize: 14, lineHeight: 18, marginTop: 4, marginBottom: 1, fontWeight: '600' },
        6: { fontSize: 13, lineHeight: 17, marginTop: 4, marginBottom: 1, fontWeight: '600' },
      };
      const s = sizeMap[props.level] ?? sizeMap[6];
      return <Text style={s}>{props.children}</Text>;
    }) as CustomRenderers['heading'],

    link: ((props: LinkRendererProps) => {
      const href: string = props.href || '';
      const isCitation = href?.endsWith(CITATION_MARKER);
      const targetUrl = isCitation ? href.slice(0, -CITATION_MARKER.length) : href;
      return (
        <Text
          style={isCitation
            ? { color: colors.outline, textDecorationLine: 'none' }
            : { color: '#1677FF', textDecorationLine: 'underline' }}
          onPress={() => {
            if (!targetUrl) return;
            if (isCitation) {
                router.push({ pathname: '/webview', params: { url: targetUrl } });
            } else {
               Linking.openURL(targetUrl).catch(() => {});
            }
          }}
        >
          {props.children}
        </Text>
      );
    }) as CustomRenderers['link'],

    image: ((props: ImageRendererProps) => {
      const url = props.url || '';
      if (!url) return null;
      return (
        <View style={{ borderRadius: 8, marginVertical: 4, overflow: 'hidden' }}>
          <Text
            onPress={() => Linking.openURL(url).catch(() => {})}
            style={{ color: '#1677FF', textDecorationLine: 'underline' }}
          >
            [{props.alt || 'image'}]
          </Text>
        </View>
      );
    }) as CustomRenderers['image'],
  };
}

// ── Theme overrides (small per-node style tweaks layered on top of base theme)
const lightThemeOverrides = {};
const darkThemeOverrides = {};

// ── Per-node style overrides (apply on top of theme)
const styleOverrides = {
  // Inline code: keep monospace + subtle background
  code_inline: {
    fontFamily: 'monospace',
    backgroundColor: 'rgba(124,58,237,0.08)',
    borderRadius: 4,
    paddingHorizontal: 4,
  },
  // Code block: larger monospace area
  code_block: {
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 18,
    padding: 8,
    borderRadius: 6,
    backgroundColor: 'rgba(124,58,237,0.06)',
  },
  // Blockquote: left accent bar
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: '#1D4ED8',
    paddingLeft: 10,
    marginVertical: 4,
    opacity: 0.85,
  },
};

/**
 * ── v18d 方案 B: StreamingMarkdownRenderer (外部 session prop) ──────────────
 *
 * Architecture change vs v18d 方案 A:
 *
 *   - 方案 A: this component owned its own `useMarkdownSession()` and called
 *     `session.append(processedText.slice(lastLen))` based on local diffing.
 *     The diffing was JS-thread work and could lag behind real WS deltas.
 *
 *   - 方案 B (current): the `MarkdownSession` HybridObject is created and
 *     owned by `stores/streaming.ts`, which keeps a module-level Map keyed
 *     by messageId. The native session receives every `text-delta` from
 *     `chat.ts` BEFORE the throttled `updateStreamingContent` call — so the
 *     C++ AST is always at least as up-to-date as the JS-visible text.
 *
 *     This component just renders whatever the session already holds, via
 *     `<MarkdownStream session={...} />`. The session's internal listener
 *     fires a single re-render per RAF tick with the new suffix range, so
 *     even 50 tokens/s of WS input becomes ≤60 renders/s on the JS thread.
 *
 * When `session` is undefined (non-streaming render, e.g. after stream end
 * or for messages that were never streaming), we fall back to the static
 * `<Markdown>{text}</Markdown>` path — zero native session overhead.
 *
 * Streaming crash recovery: `MarkdownErrorBoundary` catches any error from
 * `<MarkdownStream>` and swaps to plain-text <Text>.
 */
function StreamingMarkdownRenderer({
  text,
  style,
  sources,
  scheme,
  session,
}: {
  text: string;
  style?: any;
  sources?: { url: string }[];
  scheme: 'light' | 'dark';
  session?: MarkdownSession;
}) {
  const colors = useColors();
  const renderers = useMemo(() => buildCustomRenderers(colors), [colors]);

  // Citation injection — pure string regex, O(n). Memoized so we don't
  // re-replace when only unrelated props change.
  const processedText = useMemo(() => injectCitationLinks(text, sources), [text, sources]);

  // ── BUG FIX: removed session.reset() useEffect ────────────────────────────
  //
  // The previous effect compared `session.getAllText()` (native buffer,
  // updated IMMEDIATELY by chat.ts on each text-delta) against `processedText`
  // (JS text prop, updated via streaming.ts's 50ms THROTTLE). Because the
  // native buffer is always ahead of the throttled JS text, the comparison
  // ALWAYS mismatched during active streaming, triggering `session.reset()`
  // on every throttle flush.
  //
  // MarkdownStream is designed for append-only incremental rendering. Repeated
  // reset() calls caused its internal AST state to desync, resulting in
  // duplicated text appearing within a single assistant bubble.
  //
  // The session lifecycle is fully managed by stores/streaming.ts:
  //   - startStreaming(messageId) → getOrCreateStreamingSession (create)
  //   - text-delta handler         → session.append(delta) (incremental)
  //   - endStreaming()             → disposeStreamingSession (destroy)
  //
  // This component must be READ-ONLY w.r.t. the session — never mutate it.

  // Theme — memoized per scheme. Themes are resolved via the lazy `getThemes`
  // helper so the nitro-markdown module only loads when we actually render
  // markdown (NOT at app boot).
  const theme = useMemo(() => {
    const themes = getThemes();
    const base = scheme === 'dark' ? themes.dark : themes.light;
    const overrides = scheme === 'dark' ? darkThemeOverrides : lightThemeOverrides;
    return mergeThemes(base, overrides);
  }, [scheme]);

  // Iron rule v18o: <MarkdownStream> rejects `session={undefined}` at the type
  // level (it accepts `MarkdownSession | MarkdownSessionController`, neither of
  // which includes undefined). MarkdownRendererBase already gates the call site
  // with `session ? <Streaming/> : <Static/>`, but we ALSO early-return here
  // defensively in case this component is ever invoked directly with undefined
  // (e.g. tests, refactors). Falling back to StaticMarkdownRenderer keeps the
  // streaming UI rendering correctly without per-call `?.` noise at the JSX.
  if (!session) {
    return (
      <StaticMarkdownRenderer
        text={text}
        style={style}
        sources={sources}
        scheme={scheme}
      />
    );
  }

  // Render MarkdownStream with the externally-owned session. MarkdownStream
  // accepts either a controller (useMarkdownSession) or a raw HybridObject.
  // We pass the raw HybridObject since we own the lifecycle in streaming.ts.
  //
  // ── v18p: Suspense boundary ────────────────────────────────────────────────
  // `MarkdownStream` is wrapped in `React.lazy(() => import(...))` above to
  // defer evaluation of the nitro-markdown module graph until first chat
  // render (see comment at top of file). The Suspense fallback is shown
  // during that one-time load; subsequent renders reuse the cached chunk.
  return (
    <View style={{ minWidth: 0, ...style }}>
      <Suspense fallback={<MarkdownFallback text={text} sources={sources} />}>
        <MarkdownStream
          session={session}
          theme={theme}
          styles={styleOverrides}
          renderers={renderers}
          // ── v18e: 禁用 incrementalParsing ────────────────────────────────────
          //
          // Background:
          //   nitro-markdown's incremental AST path
          //   (`utils/incremental-ast.ts:288-309`) falls back to a FULL re-parse
          //   whenever the appended chunk contains any markdown special
          //   character — `/[`*_~[\]#!<>()|$\n\r]/`. That fallback is O(n) over
          //   the entire accumulated text, runs on the JS thread, and competes
          //   with the WS text-delta handler. Late in a stream the body tends
          //   to include more of those characters (citations, lists, code
          //   blocks, links, math-ish punctuation), which made the re-parse
          //   run more often AND over a longer string. Each full re-parse
          //   blocked the JS thread long enough for `markdown-stream.tsx:298`
          //   scheduleFlush() to queue up many RAF ticks, so the user saw
          //   text come out in big chunks ("整段整段") instead of token-by-token.
          //
          // Decision:
          //   Disable `incrementalParsing` and let the C++ HybridObject use
          //   its plain append + native AST path. This costs ~30% of the
          //   theoretical incremental throughput but gives us:
          //     - No JS-thread fallback path (AST work stays on the native
          //       side via the listener)
          //     - A single, predictable render per RAF tick
          //     - Stable streaming UX regardless of the character mix
          //
          // We keep `updateStrategy="raf"` + `useTransitionUpdates` so the
          // user-visible render cadence is still capped to one frame and
          // native touch/scroll events keep priority over stream renders.
          updateStrategy="raf"
          useTransitionUpdates
          options={MARKDOWN_OPTIONS}
        />
      </Suspense>
    </View>
  );
}

/**
 * Static (non-streaming) renderer — used when the caller knows the text is
 * final and won't change, OR when no session is provided. Falls back to the
 * plain `<Markdown>` component which parses the text once and renders it.
 *
 * This path is also used as the fallback when the streaming session
 * crashes — `MarkdownErrorBoundary` swaps to plain-text <Text> in that case.
 */
function StaticMarkdownRenderer({
  text,
  style,
  sources,
  scheme,
}: {
  text: string;
  style?: any;
  sources?: { url: string }[];
  scheme: 'light' | 'dark';
}) {
  const colors = useColors();
  const renderers = useMemo(() => buildCustomRenderers(colors), [colors]);
  const processedText = useMemo(() => injectCitationLinks(text, sources), [text, sources]);
  const theme = useMemo(() => {
    const themes = getThemes();
    const base = scheme === 'dark' ? themes.dark : themes.light;
    const overrides = scheme === 'dark' ? darkThemeOverrides : lightThemeOverrides;
    return mergeThemes(base, overrides);
  }, [scheme]);

  // ── v18p: Suspense boundary ────────────────────────────────────────────────
  // `Markdown` is wrapped in `React.lazy(() => import(...))` above to defer
  // evaluation of the nitro-markdown module graph until first chat render.
  return (
    <View style={{ minWidth: 0, ...style }}>
      <Suspense fallback={<MarkdownFallback text={text} sources={sources} />}>
        <Markdown
          theme={theme}
          styles={styleOverrides}
          renderers={renderers}
          options={MARKDOWN_OPTIONS}
        >
          {processedText}
        </Markdown>
      </Suspense>
    </View>
  );
}

function MarkdownRendererBase({
  text,
  style,
  sources,
  session,
}: {
  text: string;
  style?: any;
  sources?: { url: string }[];
  session?: MarkdownSession;
}) {
  const scheme = useResolvedScheme();

  return (
    <MarkdownErrorBoundary fallbackText={injectCitationLinks(text, sources)}>
      {session
        ? <StreamingMarkdownRenderer text={text} style={style} sources={sources} scheme={scheme} session={session} />
        : <StaticMarkdownRenderer text={text} style={style} sources={sources} scheme={scheme} />
      }
    </MarkdownErrorBoundary>
  );
}

// ── v13: React.memo with deep-ish equality for streaming case ──
// During WS streaming, ChatBubble re-renders on every token, passing a
// fresh `text` string. A naive shallow comparison (default memo) would
// always see a new `text` reference and force a full Markdown re-parse.
//
// Optimization: skip re-render when `text` is content-equal AND `sources`
// reference is stable. This catches the common case where a sibling
// re-render (e.g. parent state change) reuses the same text+sources props.
// Token-by-token growth is NOT skipped — each new character still triggers
// a parse (intentional — user wants to see streaming output).
//
// Note: React.memo's default shallow equality compares `text === prev.text`
// (string equality), so identical strings from a parent re-render will be
// skipped automatically. We keep the default equality and add no custom
// `areEqual` — over-eager equality here could mask real content updates.
export const MarkdownRenderer = memo(MarkdownRendererBase);
