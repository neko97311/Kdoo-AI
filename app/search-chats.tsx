import { useState, useMemo } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, Modal } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useChatStore } from '@/stores/chat';
import { useResolvedScheme } from '@/hooks/useColors';
import { useI18n } from '@/hooks/useI18n';
import {
  getTimeGroup,
  timeGroupOrder,
  formatRelativeTime,
} from '@/utils/time';
import type { TimeGroup } from '@/utils/time';

export default function SearchChatsScreen() {
  const router = useRouter();
  const { t } = useI18n();
  const isDark = useResolvedScheme() === 'dark';
  const iconColor = isDark ? '#e6e8ea' : '#464554';
  const menuIconColor = isDark ? '#4E5969' : '#4E5969';
  const sessions = useChatStore((s) => s.sessions);
  const setCurrentSession = useChatStore((s) => s.setCurrentSession);
  const togglePinSession = useChatStore((s) => s.togglePinSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const deleteSessionAsync = useChatStore((s) => s.deleteSessionAsync);
  const updateSessionAsync = useChatStore((s) => s.updateSessionAsync);
  const [searchQuery, setSearchQuery] = useState('');

  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);

  const filteredSessions = sessions.filter((s) =>
    s.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group filtered sessions by time
  const grouped = useMemo(() => {
    const groups: Record<TimeGroup, typeof sessions> = {
      today: [], yesterday: [], last7: [], lastMonth: [], older: [],
    };
    filteredSessions.forEach((s) => {
      groups[getTimeGroup(s.updatedAt)].push(s);
    });
    return groups;
  }, [filteredSessions]);

  const handleSelectItem = (id: string) => {
    setCurrentSession(id);
    router.replace('/');
  };

  const handlePin = (id: string) => {
    togglePinSession(id);
    setMenuSessionId(null);
  };

  const handleRenamePress = (session: typeof sessions[0]) => {
    setMenuSessionId(null);
    setRenameText(session.title);
    setRenameSessionId(session.id);
  };

  const handleRenameConfirm = () => {
    if (renameSessionId && renameText.trim()) {
      renameSession(renameSessionId, renameText.trim());
      updateSessionAsync(renameSessionId, { name: renameText.trim() });
      setRenameSessionId(null);
      setRenameText('');
    }
  };

  const handleDelete = (id: string) => {
    setMenuSessionId(null);
    setDeleteSessionId(id);
  };

  const handleDeleteConfirm = () => {
    if (deleteSessionId) {
      deleteSessionAsync(deleteSessionId);
      setDeleteSessionId(null);
    }
  };

  return (
    <View className="flex-1 bg-aura-surface">
      <View className="flex-row items-center gap-4 px-5 h-16">
        <Pressable className="p-2 rounded-full active:opacity-70" onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#1D4ED8" />
        </Pressable>
        <View className="flex-1 flex-row items-center gap-2 bg-[#f0f1f3] dark:bg-[#222326] rounded-full px-4 h-14 border border-[#eceef0] dark:border-[#2a2b2f]">
          <TextInput
            className="flex-1 bg-transparent text-base text-[#191c1e] dark:text-[#e6e8ea] h-full"
            placeholder={t('searchChats.placeholder')}
            placeholderTextColor={isDark ? '#9a99a9' : '#4E5969'}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          <Ionicons name="search" size={20} color={isDark ? '#9a99a9' : '#4E5969'} />
        </View>
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="px-5 pt-4 pb-2">
          <Text className="text-xl font-semibold text-[#191c1e] dark:text-[#e6e8ea]">{t('searchChats.recentConversations')}</Text>
        </View>

        <View className="px-5 pb-8">
          {filteredSessions.length === 0 ? (
            <View className="py-12 items-center">
              <Ionicons name="chatbubbles-outline" size={48} color={isDark ? '#2a2b2f' : '#c7c4d7'} />
              <Text className="text-base text-[#464554] dark:text-[#9a99a9] mt-4">
                {searchQuery ? t('searchChats.noMatching') : t('searchChats.noConversations')}
              </Text>
            </View>
          ) : (
            timeGroupOrder.map((group) => {
              const items = grouped[group];
              if (items.length === 0) return null;
              return (
                <View key={group} className="mb-4">
                  <Text className="text-xs font-semibold text-[#464554] dark:text-[#9a99a9] uppercase tracking-wider mb-1">
                    {t('time.' + group)}
                  </Text>
                  {items.map((session) => (
                    <View
                      key={session.id}
                      className="flex-row items-center mb-0.5"
                    >
                      <Pressable
                        className="flex-1 px-4 py-3 rounded-xl active:bg-aura-outline/20"
                        onPress={() => handleSelectItem(session.id)}
                      >
                        <Text className="text-base text-[#191c1e] dark:text-[#e6e8ea] mb-0.5" numberOfLines={1}>
                          {session.title}
                        </Text>
                        {session.lastMessage && (
                          <Text className="text-xs text-[#464554] dark:text-[#9a99a9]" numberOfLines={1}>
                            {session.lastMessage}
                          </Text>
                        )}
                        <Text className="text-[10px] text-[#464554] dark:text-[#9a99a9] mt-1">
                          {formatRelativeTime(session.updatedAt)}
                        </Text>
                      </Pressable>
                      <Pressable
                        className="p-2 rounded-full active:bg-black/5 mr-2"
                        onPress={() => setMenuSessionId(session.id)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="ellipsis-vertical" size={16} color={iconColor} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              );
            })
          )}
        </View>
      </ScrollView>

      {/* 3-dot action menu */}
      <Modal visible={!!menuSessionId} transparent animationType="fade" onRequestClose={() => setMenuSessionId(null)}>
        <Pressable className="flex-1 bg-[#00000066]" onPress={() => setMenuSessionId(null)} />
        <View className="absolute" style={{ top: '35%', left: 24, right: 24 }}>
          <View className="bg-white dark:bg-[#1a1b1e] rounded-2xl shadow-lg overflow-hidden">
            {menuSessionId && (() => {
              const session = sessions.find(s => s.id === menuSessionId);
              if (!session) return null;
              return (
                <>
                  <Pressable
                    className="flex-row items-center gap-4 px-5 py-4 active:bg-black/5 dark:active:bg-white/5"
                    onPress={() => handlePin(session.id)}
                    style={{ minHeight: 52 }}
                  >
                    <Ionicons name="pin-outline" size={20} color={iconColor} />
                    <Text className="text-base text-[#191c1e] dark:text-[#e6e8ea]">
                      {session.isPinned ? t('chatDrawer.unpin') : t('chatDrawer.pin')}
                    </Text>
                  </Pressable>
                  <View className="h-px bg-[#eceef0] dark:bg-[#2a2b2f] mx-4" />
                  <Pressable
                    className="flex-row items-center gap-4 px-5 py-4 active:bg-black/5 dark:active:bg-white/5"
                    onPress={() => handleRenamePress(session)}
                    style={{ minHeight: 52 }}
                  >
                    <Ionicons name="create-outline" size={20} color={iconColor} />
                    <Text className="text-base text-[#191c1e] dark:text-[#e6e8ea]">{t('chatDrawer.rename')}</Text>
                  </Pressable>
                  <View className="h-px bg-[#eceef0] dark:bg-[#2a2b2f] mx-4" />
                  <Pressable
                    className="flex-row items-center gap-4 px-5 py-4 active:bg-red-50 dark:active:bg-red-900/20"
                    onPress={() => handleDelete(session.id)}
                    style={{ minHeight: 52 }}
                  >
                    <Ionicons name="trash-outline" size={20} color="#F53F3F" />
                    <Text className="text-base text-[#F53F3F]">{t('chatDrawer.delete')}</Text>
                  </Pressable>
                </>
              );
            })()}
          </View>
        </View>
      </Modal>

      {/* Rename modal */}
      <Modal visible={!!renameSessionId} transparent animationType="fade" onRequestClose={() => setRenameSessionId(null)}>
        <Pressable className="flex-1 bg-[#00000066]" onPress={() => setRenameSessionId(null)} />
        <View className="absolute" style={{ top: '35%', left: 24, right: 24 }}>
          <View className="bg-white dark:bg-[#1a1b1e] rounded-2xl shadow-lg p-6">
            <Text className="text-xl font-semibold text-[#191c1e] dark:text-[#e6e8ea] mb-4">{t('chatDrawer.rename')}</Text>
            <TextInput
              className="border border-[#c7c4d7] dark:border-[#2a2b2f] rounded-xl px-4 py-3 text-base text-[#191c1e] dark:text-[#e6e8ea]"
              value={renameText}
              onChangeText={setRenameText}
              placeholder={t('chatDrawer.renamePlaceholder')}
              autoFocus
              selectTextOnFocus
            />
            <View className="flex-row justify-end gap-3 mt-4">
              <Pressable
                className="px-5 py-3 rounded-xl active:bg-black/5"
                onPress={() => { setRenameSessionId(null); setRenameText(''); }}
              >
                <Text className="text-base text-[#86909C]">{t('chatDrawer.cancel')}</Text>
              </Pressable>
              <Pressable
                className="px-5 py-3 rounded-xl bg-aura-primary active:opacity-80"
                onPress={handleRenameConfirm}
              >
                <Text className="text-base font-bold text-white">{t('chatDrawer.confirm')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal visible={!!deleteSessionId} transparent animationType="fade" onRequestClose={() => setDeleteSessionId(null)}>
        <Pressable className="flex-1 bg-[#00000066]" onPress={() => setDeleteSessionId(null)} />
        <View className="absolute" style={{ top: '35%', left: 24, right: 24 }}>
          <View className="bg-white dark:bg-[#1a1b1e] rounded-2xl shadow-lg p-6">
            <Text className="text-xl font-semibold text-[#191c1e] dark:text-[#e6e8ea] mb-2">{t('chatDrawer.deleteConfirmTitle')}</Text>
            <Text className="text-base text-[#464554] dark:text-[#9a99a9] mb-6">{t('chatDrawer.deleteConfirmMessage')}</Text>
            <View className="flex-row justify-end gap-3">
              <Pressable
                className="px-5 py-3 rounded-xl active:bg-black/5"
                onPress={() => setDeleteSessionId(null)}
              >
                <Text className="text-base text-[#86909C]">{t('chatDrawer.cancel')}</Text>
              </Pressable>
              <Pressable
                className="px-5 py-3 rounded-xl bg-[#F53F3F] active:opacity-80"
                onPress={handleDeleteConfirm}
              >
                <Text className="text-base font-bold text-white">{t('chatDrawer.delete')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
