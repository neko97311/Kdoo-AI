import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useI18n } from '@/hooks/useI18n';
import type { SourceLink } from '@/types';

interface SourceLinksProps {
  /** Search reference sources from SearXNG results. */
  sources: SourceLink[];
  /** When true, keywords have arrived but sources haven't — show loading state. */
  loading?: boolean;
}

/**
 * Renders SearXNG search reference sources as a numbered, clickable list.
 * Aligned with web's ChatAIMessage "References" block.
 *
 * Per design decision P3: all sources are expanded by default (no collapse).
 * Per design decision P4: `loading` replaces the search timer — shows a spinner
 * while we wait for `data-search-results` after `data-search-keywords` arrived.
 */
export function SourceLinks({ sources, loading }: SourceLinksProps) {
  const { t } = useI18n();

  // Loading state: keywords arrived, sources pending.
  if (loading) {
    return (
      <View className="mt-2 flex-row items-center gap-2 px-2 py-1.5">
        <ActivityIndicator size="small" color="#0284c7" />
        <Text className="text-label-sm text-sky-700 dark:text-sky-300">
          {t('searchFeature.searchingSources')}
        </Text>
      </View>
    );
  }

  if (!sources || sources.length === 0) return null;

  const handleOpen = (url: string) => {
    router.push({ pathname: '/webview', params: { url } });
  };

  return (
    <View className="mt-2 rounded-card border border-sky-200/40 dark:border-sky-800/40 bg-sky-50/40 dark:bg-sky-950/20 overflow-hidden">
      {/* Header */}
      <View className="flex-row items-center gap-1.5 px-3 py-1.5 border-b border-sky-200/40 dark:border-sky-800/40">
        <Ionicons
          name="book-outline"
          size={14}
          className="text-sky-700 dark:text-sky-400"
        />
        <Text className="text-label-sm font-medium text-sky-800 dark:text-sky-300 flex-1">
          {t('searchFeature.referenceCount', { count: sources.length })}
        </Text>
      </View>

      {/* Source list */}
      <View className="px-3 py-1.5 gap-1">
        {sources.map((src, idx) => (
          <Pressable
            key={src.id || idx}
            className="flex-row items-start gap-2 py-1 active:opacity-70"
            onPress={() => handleOpen(src.url)}
          >
            <Text className="text-label-sm font-mono text-sky-500 dark:text-sky-400 mt-0.5">
              [{idx + 1}]
            </Text>
            <Text
              className="text-body-sm text-sky-900 dark:text-sky-100 flex-1 underline decoration-sky-300/60"
              numberOfLines={2}
            >
              {src.title}
            </Text>
            <Ionicons
              name="open-outline"
              size={12}
              className="text-sky-400 dark:text-sky-500 mt-1"
            />
          </Pressable>
        ))}
      </View>
    </View>
  );
}
