/**
 * Live transcript list for voice call text-mode view.
 * Renders user utterances right-aligned, agent replies left-aligned.
 * Interim segments show a blinking cursor (▍).
 */
import { View, Text, FlatList, StyleSheet } from 'react-native'
import { useEffect, useRef } from 'react'
import { useVoiceStore } from '@/stores/voice'
import { useCallColors } from '@/hooks/useColors'

export function VoiceTranscriptList() {
  const cc = useCallColors()
  const transcripts = useVoiceStore((s) => s.transcripts)
  const listRef = useRef<FlatList>(null)

  // Auto-scroll to bottom when new items arrive
  useEffect(() => {
    if (transcripts.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50)
    }
  }, [transcripts])

  return (
    <FlatList
      ref={listRef}
      data={transcripts}
      keyExtractor={(item) => item.segmentId}
      style={{ width: '100%', height: '100%' }}
      contentContainerStyle={{ paddingVertical: 16, paddingHorizontal: 20 }}
      renderItem={({ item }) => {
        const isUser = item.role === 'user'
        return (
          <View style={[styles.bubbleRow, isUser ? styles.rowRight : styles.rowLeft]}>
            <View
              style={[
                styles.bubble,
                isUser ? styles.userBubble : styles.agentBubble,
                { backgroundColor: isUser ? cc.avatarBg : cc.buttonBg },
              ]}
            >
              <Text style={[styles.text, { color: cc.statusText }]}>
                {item.text}
              </Text>
            </View>
          </View>
        )
      }}
    />
  )
}

const styles = StyleSheet.create({
  bubbleRow: { flexDirection: 'row', width: '100%', marginVertical: 4 },
  rowLeft: { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '80%',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  userBubble: { marginLeft: '20%' },
  agentBubble: { marginRight: '20%' },
  text: { fontSize: 15, lineHeight: 20 },
})
