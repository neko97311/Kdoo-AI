import { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useI18n } from '@/hooks/useI18n';
import type { SourceLink } from '@/types';

interface SearchMetaPanelProps {
  /** Decomposed search keywords from SearXNG pipeline. */
  keywords: string[];
  /** Search reference sources from SearXNG results. */
  sources: SourceLink[];
  /** When true, keywords have arrived but sources haven't — show loading state. */
  loading?: boolean;
}

/**
 * Collapsible panel that wraps search keywords + reference sources.
 *
 * Replaces the old always-visible `SearchKeywordsChips` + `SourceLinks` pair
 * with a single toggle button (default collapsed). The toggle label shows a
 * compact count summary — segments for empty data are omitted entirely:
 *   - keywords only:  "3 keywords"
 *   - sources only:   "5 results"
 *   - both:           "3 keywords · 5 results"
 *   - loading state:  "3 keywords · searching..."
 *
 * Aligned with the web client's `ChatAIMessage.vue` `showSources` toggle.
 */
export function SearchMetaPanel({ keywords, sources, loading }: SearchMetaPanelProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const hasKeywords = keywords && keywords.length > 0;
  const hasSources = sources && sources.length > 0;

  // Nothing to render — skip the panel entirely.
  if (!hasKeywords && !hasSources && !loading) return null;

  // ─── Build the compact summary label ──────────────────────
  const segments: string[] = [];
  if (hasKeywords) {
    segments.push(t('searchFeature.keywordsCount', { count: keywords.length }));
  }
  if (loading) {
    segments.push(t('searchFeature.searching'));
  } else if (hasSources) {
    segments.push(t('searchFeature.resultsCount', { count: sources.length }));
  }
  const summary = segments.join(' · ');

  const handleOpenUrl = (url: string) => {
    router.push({ pathname: '/webview', params: { url } });
  };

  return (
    <View className="mt-1.5 mb-0.5">
      {/* Toggle button — minimalist neutral style (Doubao-inspired): no bright
          blue background tint, low-emphasis outline text, thin outline border.
          Icon and text share a single muted tone so the panel reads as metadata. */}
      <Pressable
        className="flex-row items-center gap-1.5 px-2 py-1.5 rounded-full bg-transparent border border-aura-outline-variant dark:border-white/10 active:opacity-70 self-start"
        onPress={() => setExpanded((v) => !v)}
        hitSlop={6}
      >
        <Ionicons
          name="search-outline"
          size={13}
          className="text-aura-outline"
        />
        <Text className="text-label-sm font-medium text-aura-outline">
          {summary}
        </Text>
        <Ionicons
          name={expanded ? 'chevron-down' : 'chevron-forward'}
          size={12}
          className="text-aura-outline"
        />
      </Pressable>

      {/* Expanded content — keywords chips + sources list */}
      {expanded && (
        <View className="mt-2">
          {/* Keywords chips — wraps to next line on overflow.
              Neutral surface tone (aura-surface-container) replaces the
              previous sky tint so keywords read as metadata, not badges. */}
          {hasKeywords && (
            <View className="flex-row flex-wrap gap-1.5 px-0.5 mb-2">
              {keywords.map((kw, idx) => (
                <View
                  key={`${kw}-${idx}`}
                  className="px-2.5 py-1 rounded-full bg-aura-surface-container dark:bg-white/5 border border-aura-outline-variant dark:border-white/10"
                  style={{ maxWidth: 240 }}
                >
                  <Text className="text-label-sm text-aura-on-surface-variant dark:text-aura-on-surface-variant">
                    {kw}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {/* Sources loading indicator */}
          {loading && (
            <View className="flex-row items-center gap-2 px-2 py-1.5">
              <ActivityIndicator size="small" color="#86909C" />
              <Text className="text-label-sm text-aura-outline">
                {t('searchFeature.searchingSources')}
              </Text>
            </View>
          )}

          {/* Sources list — numbered clickable rows.
              Replaces the previous sky-tinted card with a neutral surface;
              links are still underlined but use a subtle outline tint instead
              of sky so the visual hierarchy matches Doubao's reference design. */}
          {hasSources && (
            <View className="rounded-card border border-aura-outline-variant/60 dark:border-white/10 bg-aura-surface-container/50 dark:bg-white/5 overflow-hidden">
              {/* Header */}
              <View className="flex-row items-center gap-1.5 px-3 py-1.5 border-b border-aura-outline-variant/60 dark:border-white/10">
                <Ionicons
                  name="book-outline"
                  size={14}
                  className="text-aura-outline"
                />
                <Text className="text-label-sm font-medium text-aura-on-surface-variant dark:text-aura-on-surface-variant flex-1">
                  {t('searchFeature.referenceCount', { count: sources.length })}
                </Text>
              </View>

              {/* Source rows */}
              <View className="px-3 py-1.5 gap-1">
                {sources.map((src, idx) => (
                  <Pressable
                    key={src.id || idx}
                    className="flex-row items-start gap-2 py-1 active:opacity-70"
                    onPress={() => handleOpenUrl(src.url)}
                  >
                    <Text className="text-label-sm font-mono text-aura-outline mt-0.5">
                      [{idx + 1}]
                    </Text>
                    <Text
                      className="text-body-sm text-aura-on-surface-variant dark:text-aura-on-surface-variant flex-1 underline decoration-aura-outline-variant"
                      numberOfLines={2}
                    >
                      {src.title}
                    </Text>
                    <Ionicons
                      name="open-outline"
                      size={12}
                      className="text-aura-outline mt-1"
                    />
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
