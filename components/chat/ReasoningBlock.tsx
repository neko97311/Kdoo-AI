import { useState, useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ReasoningContent } from '@/types';

interface ReasoningBlockProps {
  content: ReasoningContent;
}

export function ReasoningBlock({ content }: ReasoningBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const isStreaming = content.state === 'streaming';

  return (
    <View className="mt-1.5 mb-0.5">
      {/* Toggle button — minimalist neutral style (Doubao-inspired): no bright
          background tint, low-emphasis text and icon, thin outline border.
          Streaming state is conveyed through the icon spin alone. */}
      <Pressable
        className="flex-row items-center gap-1.5 px-2 py-1.5 rounded-full bg-transparent border border-aura-outline-variant dark:border-white/10 active:opacity-70 self-start"
        onPress={() => setExpanded(!expanded)}
        hitSlop={6}
      >
        <Ionicons
          name={isStreaming ? 'sync-outline' : 'bulb-outline'}
          size={13}
          className="text-aura-outline"
        />
        <Text className="text-label-sm font-medium text-aura-outline">
          {isStreaming ? 'Thinking...' : 'Thought'}
        </Text>
        <Ionicons
          name={expanded ? 'chevron-down' : 'chevron-forward'}
          size={12}
          className="text-aura-outline"
        />
      </Pressable>

      {/* Collapsible content — rendered with low-emphasis onSurfaceVariant text
          so the reasoning trace reads as supporting metadata, not the main reply. */}
      {expanded && content.text ? (
        <View className="mt-2 px-3 pb-2.5">
          <Text
            className="text-body-md text-aura-on-surface-variant dark:text-aura-on-surface-variant leading-5"
            selectable
          >
            {content.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
