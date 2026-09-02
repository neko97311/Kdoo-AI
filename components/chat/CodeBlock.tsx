import { useState } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { useI18n } from '@/hooks/useI18n';

interface CodeBlockProps {
  language: string;
  code: string;
}

export function CodeBlock({ language, code }: CodeBlockProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View className="bg-[#2d3133] rounded-lg overflow-hidden">
      <View className="flex-row justify-between items-center px-3 py-1.5 bg-[#2d3133]/80 border-b border-[#c7c4d7]/20">
        <Text className="text-[#eff1f3] text-xs font-medium">{language}</Text>
        <Pressable onPress={handleCopy}>
          <Text className="text-[#eff1f3] text-xs font-medium">
            {copied ? t('codeBlock.copied') : t('codeBlock.copy')}
          </Text>
        </Pressable>
      </View>
      {/*
        Wrap code in a horizontal ScrollView so long lines scroll instead of
        expanding the bubble past its maxWidth. flexGrow:0 prevents the inner
        content from forcing the parent bubble to grow taller than needed.
      */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ padding: 12 }}
      >
        <Text
          className="text-[#eff1f3] font-mono text-sm"
          selectable
        >
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}