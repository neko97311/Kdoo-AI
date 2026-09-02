import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useI18n } from '@/hooks/useI18n';

interface SearchKeywordsChipsProps {
  /** Decomposed search keywords from SearXNG pipeline. */
  keywords: string[];
  /** Whether sources have arrived yet. When true, shows a "searching" indicator. */
  searching?: boolean;
}

/**
 * Renders SearXNG-decomposed search keywords as wrapping chips.
 * Aligned with web's ChatAIMessage keyword chips block.
 *
 * Per design decision P2: only `keywords` array is shown — no `userKeyword` highlighting.
 */
export function SearchKeywordsChips({ keywords, searching }: SearchKeywordsChipsProps) {
  const { t } = useI18n();

  if (!keywords || keywords.length === 0) return null;

  return (
    <View className="mt-1.5 mb-0.5">
      <View className="flex-row items-center gap-1.5 mb-1.5 px-0.5">
        <Ionicons
          name="search-outline"
          size={14}
          className="text-aura-outline"
        />
        <Text className="text-label-sm font-medium text-aura-outline">
          {t('searchFeature.searchKeywords')}
        </Text>
        {searching && (
          <Text className="text-label-xs text-aura-outline ml-1">
            {t('searchFeature.searching')}
          </Text>
        )}
      </View>
      {/*
        flexWrap on a plain View (not ScrollView): chips wrap to the next line
        when they exceed the bubble width. This fixes three issues at once:
        1. Web: horizontal ScrollView didn't wrap, chips overflowed the bubble.
        2. Android: long single keyword expanded the chip past bubble width.
        3. Removing nested ScrollView eliminates the Android measurement loop
           (RN issues #21436/#32990) that previously needed nestedScrollEnabled.

        maxWidth per chip: prevents a single long keyword (e.g. a full sentence
        decomposed by SearXNG) from dominating the row. Text wraps inside chip.
      */}
      <View className="flex-row flex-wrap gap-1.5 px-0.5">
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
    </View>
  );
}
