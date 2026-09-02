import React, { memo, useMemo, type ReactNode } from 'react';
import { View, Text, Linking, Platform } from 'react-native';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { router } from 'expo-router';
import { useColors, type ColorTokens } from '@/hooks/useColors';

/**
 * Citation marker — MUST stay in sync with MarkdownRenderer.native.tsx.
 *
 * Native appends `#kdooref` to injected citation URLs so the custom link
 * renderer can recognize them and route to the in-app WebView page instead
 * of the system browser. Web does the same for parity.
 */
const CITATION_MARKER = '#kdooref';
const CITATION_MARKER_LEN = CITATION_MARKER.length;

/**
 * Convert inline citation markers like [1], [2], 【1】, ［1］ into markdown
 * links pointing to the corresponding source URL from SearXNG results.
 *
 * Implementation is identical to the native renderer so citation link
 * injection stays consistent across platforms.
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

/**
 * Heading sizes — must match MarkdownRenderer.native.tsx HEADING_SIZES map
 * so web + native chat bubbles look identical at every zoom level.
 */
const HEADING_STYLES: Record<number, {
  fontSize: number;
  lineHeight: number;
  marginTop: number;
  marginBottom: number;
  fontWeight: '700' | '600';
}> = {
  1: { fontSize: 22, lineHeight: 30, marginTop: 10, marginBottom: 4, fontWeight: '700' },
  2: { fontSize: 19, lineHeight: 26, marginTop: 8, marginBottom: 3, fontWeight: '700' },
  3: { fontSize: 16, lineHeight: 22, marginTop: 8, marginBottom: 2, fontWeight: '600' },
  4: { fontSize: 15, lineHeight: 20, marginTop: 6, marginBottom: 2, fontWeight: '600' },
  5: { fontSize: 14, lineHeight: 18, marginTop: 4, marginBottom: 1, fontWeight: '600' },
  6: { fontSize: 13, lineHeight: 17, marginTop: 4, marginBottom: 1, fontWeight: '600' },
};

const INLINE_CODE_STYLE = {
  fontFamily: 'monospace',
  backgroundColor: 'rgba(124,58,237,0.08)',
  borderRadius: 4,
  paddingHorizontal: 4,
} as const;

const BLOCK_CODE_STYLE = {
  fontFamily: 'monospace',
  fontSize: 13,
  lineHeight: 18,
  padding: 8,
  borderRadius: 6,
  backgroundColor: 'rgba(124,58,237,0.06)',
} as const;

/**
 * Drop whitespace-only text nodes from a node list.
 *
 * Why this is needed:
 *   react-markdown v10's default root is a Fragment (no `root` component /
 *   `root` prop exists in v10 — see `Options` in index.d.ts). The underlying
 *   hast tree preserves literal "\n" whitespace text nodes between
 *   block-level elements (between `<li>`s inside a `<ul>`, between rows in a
 *   `<tbody>`, between `<p>`, `<blockquote>`, etc. at the top level).
 *
 *   RN/RNW forbids bare strings inside `<View>`:
 *     "Unexpected text node: \n. A text node cannot be a child of a <View>"
 *
 *   Every View-based container below (outer wrapper + pre/blockquote/ul/ol/
 *   table/thead/tbody/tr) therefore runs its children through this filter to
 *   strip whitespace-only strings while preserving real elements.
 *
 *   Non-whitespace strings are preserved (defensive — react-markdown normally
 *   wraps stray text in a `<p>`, but customizing components can change that).
 *
 * `React.Children.toArray` flattens fragments, assigns keys, and turns every
 * child into a comparable node; strings survive as string entries, so the
 * `typeof child === 'string'` check catches them cleanly.
 *
 * Defense-in-depth: the primary fix is `rehypeStripBlockWhitespace` below
 * (strips whitespace at hast parse time). This filter is a safety net for any
 * whitespace that slips past the rehype plugin (e.g., introduced by a future
 * rehype plugin that runs after ours).
 */
function filterBlockChildren(children: ReactNode): ReactNode[] {
  return React.Children.toArray(children).filter(child => {
    if (typeof child === 'string') {
      return child.trim().length > 0;
    }
    return true;
  });
}

/**
 * Rehype plugin: strip whitespace-only text nodes from the hast tree.
 *
 * PRIMARY fix for the "text node cannot be a child of a <View>" error.
 *
 * Why a rehype plugin instead of a React-time filter:
 *   react-markdown v10 has no `root` component / `root` prop (confirmed by
 *   reading index.d.ts). Its default root is a Fragment, so the literal "\n"
 *   whitespace text nodes between block-level elements in the hast tree are
 *   rendered as bare strings inside whatever wraps `<Markdown>` — in our
 *   case, an outer `<View>` plus all the View-based block containers
 *   (`<ul>`, `<table>`, `<blockquote>`, etc.).
 *
 *   By stripping these whitespace-only text nodes at hast time (before any
 *   React element is materialized), we eliminate the bare strings at the
 *   source. The React tree that react-markdown produces is then free of
 *   whitespace-only text nodes, so no `<View>` ever sees one.
 *
 * Skips `<pre>`/`<code>`/`<textarea>` where whitespace is semantically
 * significant (line breaks inside code blocks must be preserved).
 *
 * Placed last in the `rehypePlugins` array so any whitespace introduced by
 * earlier plugins is also stripped.
 */
const SKIP_WHITESPACE_TAGS = new Set(['pre', 'code', 'textarea']);
function rehypeStripBlockWhitespace() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      const children = node.children;
      if (!Array.isArray(children)) return;
      const tag = node.tagName;
      if (tag && SKIP_WHITESPACE_TAGS.has(tag)) return;
      const filtered = children.filter((c: any) => {
        if (c && c.type === 'text' && typeof c.value === 'string') {
          return c.value.trim().length > 0;
        }
        return true;
      });
      node.children = filtered;
      filtered.forEach(walk);
    };
    walk(tree);
  };
}

/**
 * Build react-markdown component overrides mapping HTML tags to React Native
 * primitives. Rebuilt only when color tokens change (light/dark switch).
 *
 * Why RN primitives and not raw HTML? Two reasons:
 *   1. Style parity with native — same `useColors()` tokens drive both
 *      implementations, so citation chips, link colors, etc. match exactly.
 *   2. Routing parity — citation links must call `router.push('/webview')`
 *      on both platforms. Using `<Text onPress>` keeps that path identical.
 */
function buildMarkdownComponents(colors: ColorTokens) {
  return {
    // Headings
    h1: (props: any) => <Text style={HEADING_STYLES[1]}>{props.children}</Text>,
    h2: (props: any) => <Text style={HEADING_STYLES[2]}>{props.children}</Text>,
    h3: (props: any) => <Text style={HEADING_STYLES[3]}>{props.children}</Text>,
    h4: (props: any) => <Text style={HEADING_STYLES[4]}>{props.children}</Text>,
    h5: (props: any) => <Text style={HEADING_STYLES[5]}>{props.children}</Text>,
    h6: (props: any) => <Text style={HEADING_STYLES[6]}>{props.children}</Text>,

    // Paragraph — tight bottom margin (matches native marginBottom: 4)
    p: (props: any) => <Text style={{ marginBottom: 4 }}>{props.children}</Text>,

    // Inline emphasis
    strong: (props: any) => <Text style={{ fontWeight: '700' }}>{props.children}</Text>,
    em: (props: any) => <Text style={{ fontStyle: 'italic' }}>{props.children}</Text>,
    del: (props: any) => (
      <Text style={{ textDecorationLine: 'line-through' }}>{props.children}</Text>
    ),

    // Code — distinguish inline vs block by content (matches react-markdown v10
    // behavior where `inline` prop is no longer provided; we use the presence
    // of a newline OR a `language-` className as the block signal).
    code: (props: any) => {
      const { children, className } = props;
      const text = String(children ?? '');
      const isBlock = /language-(\w+)/.exec(className || '') || text.includes('\n');
      return (
        <Text style={isBlock ? BLOCK_CODE_STYLE : INLINE_CODE_STYLE}>
          {isBlock ? text.replace(/\n$/, '') : children}
        </Text>
      );
    },

    // Pre — block wrapper for fenced code blocks. `pre` in hast contains the
    // `<code>` child plus surrounding `"\n"` whitespace text nodes; strip them
    // before rendering inside this `<View>`.
    pre: (props: any) => (
      <View style={{ marginVertical: 4 }}>{filterBlockChildren(props.children)}</View>
    ),

    // Blockquote — left purple accent bar (matches native blockquote style).
    // Multiple `<p>` children inside a blockquote are separated by `"\n"`
    // whitespace text nodes that must be stripped for the View wrapper.
    blockquote: (props: any) => (
      <View
        style={{
          borderLeftWidth: 3,
          borderLeftColor: '#1D4ED8',
          paddingLeft: 10,
          marginVertical: 4,
          opacity: 0.85,
        }}
      >
        {filterBlockChildren(props.children)}
      </View>
    ),

    // Links — citation links route to in-app WebView, others open externally
    a: (props: any) => {
      const href: string = props.href || '';
      const isCitation = href.endsWith(CITATION_MARKER);
      const targetUrl = isCitation ? href.slice(0, -CITATION_MARKER_LEN) : href;
      return (
        <Text
          style={
            isCitation
              ? { color: colors.outline, textDecorationLine: 'none' }
              : { color: '#1677FF', textDecorationLine: 'underline' }
          }
          onPress={() => {
            if (!targetUrl) return;
            if (isCitation) {
              router.push({ pathname: '/webview', params: { url: targetUrl } });
            } else if (Platform.OS === 'web') {
              window.open(targetUrl, '_blank', 'noopener,noreferrer');
            } else {
              Linking.openURL(targetUrl).catch(() => {});
            }
          }}
        >
          {props.children}
        </Text>
      );
    },

    // Images — render as a clickable placeholder link, matching native's
    // image renderer behavior (the native app doesn't load remote images
    // inline in chat; it shows a clickable [alt] label).
    img: (props: any) => (
      <Text
        onPress={() => {
          if (!props.src) return;
          if (Platform.OS === 'web') {
            window.open(props.src, '_blank', 'noopener,noreferrer');
          } else {
            Linking.openURL(props.src).catch(() => {});
          }
        }}
        style={{ color: '#1677FF', textDecorationLine: 'underline' }}
      >
        [{props.alt || 'image'}]
      </Text>
    ),

    // Lists. `<ul>`/`<ol>` children are `<li>` elements separated by literal
    // "\n" whitespace text nodes from hast — those bare strings would land
    // inside the View wrapper and trip RNW's text-node-in-View guard.
    ul: (props: any) => (
      <View style={{ marginVertical: 4, paddingLeft: 8 }}>
        {filterBlockChildren(props.children)}
      </View>
    ),
    ol: (props: any) => (
      <View style={{ marginVertical: 4, paddingLeft: 8 }}>
        {filterBlockChildren(props.children)}
      </View>
    ),
    li: (props: any) => (
      <View style={{ flexDirection: 'row', marginBottom: 2 }}>
        <Text>{'\u2022 '}</Text>
        <View style={{ flex: 1 }}>
          <Text>{props.children}</Text>
        </View>
      </View>
    ),

    // Horizontal rule
    hr: () => (
      <View style={{ height: 1, backgroundColor: '#ccc', marginVertical: 8 }} />
    ),

    // Tables — basic View-based layout (GFM tables). Each level (table/thead/
    // tbody/tr) receives row/section children with "\n" whitespace text nodes
    // between them; strip those before they hit the View wrappers.
    table: (props: any) => (
      <View
        style={{
          borderWidth: 1,
          borderColor: '#e5e7eb',
          borderRadius: 4,
          marginVertical: 4,
          overflow: 'hidden',
        }}
      >
        {filterBlockChildren(props.children)}
      </View>
    ),
    thead: (props: any) => (
      <View style={{ backgroundColor: '#f3f4f6' }}>
        {filterBlockChildren(props.children)}
      </View>
    ),
    tbody: (props: any) => (
      <View>{filterBlockChildren(props.children)}</View>
    ),
    tr: (props: any) => (
      <View
        style={{
          flexDirection: 'row',
          borderBottomWidth: 1,
          borderColor: '#e5e7eb',
        }}
      >
        {filterBlockChildren(props.children)}
      </View>
    ),
    th: (props: any) => (
      <Text style={{ flex: 1, padding: 6, fontWeight: '600' }}>{props.children}</Text>
    ),
    td: (props: any) => <Text style={{ flex: 1, padding: 6 }}>{props.children}</Text>,
  };
}

/**
 * Web markdown renderer using `react-markdown` + `remark-gfm`.
 *
 * Why a separate web implementation?
 *   `react-native-nitro-markdown` depends on Nitro Modules JSI bindings
 *   (C++/Kotlin/Swift binaries) which are not available in the browser.
 *   The web bundle therefore falls back to `react-markdown` — a pure-JS
 *   CommonMark + GFM parser that runs fine on V8/JSC.
 *
 * Streaming behavior:
 *   On web we don't need a native `MarkdownSession` for streaming. The
 *   browser JS engine is fast enough to re-parse the entire markdown string
 *   on every token (react-markdown parses synchronously in <1ms for typical
 *   chat message lengths). The `session` prop is accepted but ignored.
 *
 * API parity:
 *   - `injectCitationLinks` is identical to native (same regex, same
 *     `#kdooref` marker, same `[[N]](url)` output format).
 *   - Citation link routing goes through `router.push('/webview')` on both
 *     platforms.
 *   - Heading sizes, code block styling, blockquote accent color, paragraph
 *     spacing — all match the native `MarkdownRenderer.native.tsx` values.
 */
function MarkdownRendererBase({
  text,
  style,
  sources,
  // On web the session is ignored — react-markdown re-parses on every text
  // change. Declared here so the prop interface matches the native version
  // and callers don't need to branch on Platform.OS.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  session: _session,
}: {
  text: string;
  style?: any;
  sources?: { url: string }[];
  session?: unknown;
}) {
  const colors = useColors();
  const components = useMemo(() => buildMarkdownComponents(colors), [colors]);
  const processedText = useMemo(() => injectCitationLinks(text, sources), [text, sources]);

  return (
    <View style={style}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeStripBlockWhitespace]}
        components={components}
      >
        {processedText}
      </Markdown>
    </View>
  );
}

export const MarkdownRenderer = memo(MarkdownRendererBase);
