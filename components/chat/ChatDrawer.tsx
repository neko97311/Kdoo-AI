import { useState, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Modal,
  TextInput,
  Platform,
  Image,
  Animated,
} from 'react-native';
import { ChatListSkeleton } from '@/components/chat/ChatListSkeleton';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';
import { resolveAvatarUrl } from '@/services/user';
import { useSessionShare } from '@/hooks/useSessionShare';
import { useI18n } from '@/hooks/useI18n';
import { useSheetSlideAnimation } from '@/hooks/useSheetSlideAnimation';
import {
  getTimeGroup,
  timeGroupOrder,
} from '@/utils/time';
import type { TimeGroup } from '@/utils/time';

interface ChatDrawerProps {
  visible: boolean;
  onClose: () => void;
  isLoading?: boolean;
}

export function ChatDrawer({ visible, onClose, isLoading }: ChatDrawerProps) {
  // Individual selectors — NOT useChatStore() destructure.
  // REASON: ChatDrawer is ALWAYS MOUNTED (parent app/index.tsx renders it
  // unconditionally; the `visible` prop only toggles Modal display). A
  // no-selector full subscription re-renders ChatDrawer on EVERY store
  // change. During WS streaming, updateStreamingContent fires setState on
  // every token (updating `messages`), which re-renders ChatDrawer's entire
  // subtree (sessions.filter/map + 4 Modal elements) on every token — even
  // though the drawer is closed. This is a residual hot path that blocks
  // the JS thread during streaming.
  //
  // Individual selectors subscribe to specific slices. `sessions` array
  // reference is stable during streaming (updateStreamingContent only
  // mutates `messages`, never `sessions`), so this selector does NOT
  // trigger re-renders on token updates. Actions are stable references.
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const setCurrentSession = useChatStore((s) => s.setCurrentSession);
  const togglePinSession = useChatStore((s) => s.togglePinSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const deleteSessionAsync = useChatStore((s) => s.deleteSessionAsync);
  const updateSessionAsync = useChatStore((s) => s.updateSessionAsync);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useI18n();

  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);

  const menuSheetTranslateY = useSheetSlideAnimation(!!menuSessionId);
  const renameSheetTranslateY = useSheetSlideAnimation(!!renameSessionId);
  const deleteSheetTranslateY = useSheetSlideAnimation(!!deleteSessionId);

  // ── Avatar (moved here from ChatHeader right side) ──
  const user = useAuthStore((s) => s.user);
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);
  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [user?.avatar]);
  const displayName = user?.displayName || user?.username;
  const initials = displayName ? displayName.slice(0, 2).toUpperCase() : 'K';
  const showAvatarFallback = !user?.avatar || avatarLoadFailed;

  const pinnedSessions = sessions.filter((s) => s.isPinned);
  const recentSessions = sessions.filter((s) => !s.isPinned);

  const handleNewChat = () => {
    setCurrentSession(null);
    onClose();
  };

  const handleSelectSession = (id: string) => {
    setCurrentSession(id);
    onClose();
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

  const handleDelete = (session: typeof sessions[0]) => {
    setMenuSessionId(null);
    setDeleteSessionId(session.id);
  };

  const handleDeleteConfirm = () => {
    if (deleteSessionId) {
      deleteSessionAsync(deleteSessionId);
      setDeleteSessionId(null);
    }
  };

  // Share flow: create the share link on the server, then hand it to the
  // system share sheet (useSessionShare, shared with ChatHeader's share button).
  const shareSession = useSessionShare();
  const handleShare = (session: typeof sessions[0]) => {
    setMenuSessionId(null);
    shareSession(session.id, session.title);
  };

  const renderSessionItem = (session: typeof sessions[0]) => {
    const isPinned = session.isPinned;
    return (
      <Pressable
        key={session.id}
        className={`flex-row items-center justify-between px-4 py-3 rounded-card ${session.id === currentSessionId ? 'bg-aura-primary/10' : 'active:bg-black/5'
          }`}
        onPress={() => handleSelectSession(session.id)}
        style={{ minHeight: 44 }}
      >
        <View className="flex-1 pr-2">
          <View className="flex-row items-center gap-2">
            <Text className="text-body-md text-aura-on-surface flex-1" numberOfLines={1}>
              {session.title}
            </Text>
          </View>
          {session.lastMessage && (
            <Text className="text-label-sm text-aura-outline mt-0.5" numberOfLines={1}>
              {session.lastMessage}
            </Text>
          )}
        </View>
        <Pressable
          className="p-2 rounded-full active:bg-black/5"
          onPress={() => setMenuSessionId(session.id)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
            <Ionicons name="ellipsis-vertical" size={16} className="text-aura-outline" />
         </Pressable>
       </Pressable>
     );
   };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable className="flex-1 bg-[#00000066]" onPress={onClose} />

      <View
        className="absolute top-0 left-0 h-full w-[280px] bg-aura-surface-container border-r border-aura-outline-variant shadow-lg"
      >
        {/* Content */}
        <View className="flex-1 p-4" style={{ paddingTop: insets.top + 16 }}>
          {/* Search bar — top of drawer */}
          <Pressable
            className="flex-row items-center gap-3 px-4 h-12 bg-aura-surface-container-high rounded-2xl active:bg-aura-outline/20 mb-4"
            onPress={() => { onClose(); router.push('/search-chats'); }}
          >
            <Ionicons name="search" size={20} className="text-aura-on-surface-variant" />
            <Text className="text-body-md text-aura-on-surface-variant">{t('chatDrawer.searchChats')}</Text>
          </Pressable>

          {/* New Chat */}
          <Pressable
            className="flex-row items-center gap-3 px-4 py-3 rounded-card active:opacity-80"
            onPress={handleNewChat}
            style={{ minHeight: 44 }}
          >
            <Ionicons name="add" size={20} color="#1D4ED8" />
            <Text className="text-body-md font-bold text-aura-primary">{t('chatDrawer.newChat')}</Text>
          </Pressable>

            {/* Sessions list */}
            <ScrollView showsVerticalScrollIndicator={false} className="flex-1 mt-2">
              {sessions.length === 0 && isLoading ? (
                <ChatListSkeleton />
              ) : sessions.length === 0 ? (
              <View className="py-8 items-center">
                <Ionicons name="chatbubbles-outline" size={48} className="text-aura-outline-variant" />
                <Text className="text-label-sm text-aura-outline mt-2">{t('chatDrawer.noConversations')}</Text>
              </View>
            ) : (
              <>
                {pinnedSessions.length > 0 && (
                   <View className="mb-4 pb-4 border-b border-[#0000000F] dark:border-[#2a2b2f]">
                    <Text className="text-label-sm font-bold text-aura-outline uppercase tracking-wider px-4 py-2 font-mono">
                      {t('chatDrawer.pinned')}
                    </Text>
                    {pinnedSessions.map((session) => renderSessionItem(session))}
                  </View>
                )}

                {recentSessions.length > 0 && (
                  (() => {
                    const grouped: Record<TimeGroup, typeof sessions> = {
                      today: [], yesterday: [], last7: [], lastMonth: [], older: [],
                    };
                    recentSessions.forEach((s) => {
                      grouped[getTimeGroup(s.updatedAt)].push(s);
                    });

                    return timeGroupOrder.map((group) => {
                      const items = grouped[group];
                      if (items.length === 0) return null;
                      return (
                        <View key={group} className={group !== timeGroupOrder[0] ? 'mt-4' : ''}>
                          <Text className="text-label-sm font-bold text-aura-outline uppercase tracking-wider px-4 py-2 font-mono">
                            {t('time.' + group)}
                          </Text>
                          {items.map((session) => renderSessionItem(session))}
                        </View>
                      );
                    });
                  })()
                )}
              </>
            )}
          </ScrollView>
        </View>

        {/* Footer: avatar + username display. Fixed at bottom. */}
        <View
          className="px-4 pt-3 border-t border-aura-outline-variant/30"
          style={{ paddingBottom: insets.bottom + 12 }}
        >
          <View className="flex-row items-center gap-3">
            {showAvatarFallback ? (
              <LinearGradient
                colors={['#1D4ED8', '#2563EB']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }}
              >
                <Text className="text-sm font-bold text-white">{initials}</Text>
              </LinearGradient>
            ) : (
              <Image
                source={{ uri: resolveAvatarUrl(user.avatar) }}
                style={{ width: 40, height: 40, borderRadius: 20 }}
                onError={() => setAvatarLoadFailed(true)}
              />
            )}
            <Text className="text-body-sm text-aura-on-surface flex-1" numberOfLines={1}>
              {user?.displayName || user?.username || user?.email || 'Guest'}
            </Text>
          </View>
        </View>
      </View>

      {/* Action menu — bottom sheet */}
      <Modal visible={!!menuSessionId} transparent animationType="fade" onRequestClose={() => setMenuSessionId(null)}>
        <Pressable className="flex-1 bg-[#00000066]" onPress={() => setMenuSessionId(null)} />
        <Animated.View
          className="absolute bottom-0 left-0 right-0"
          style={{ paddingBottom: insets.bottom, transform: [{ translateY: menuSheetTranslateY }] }}
        >
          <View className="bg-aura-surface-container rounded-t-2xl overflow-hidden">
            <View className="items-center pt-3 pb-2">
              <View className="w-10 h-1 rounded-full bg-aura-outline-variant" />
            </View>
            {menuSessionId && (() => {
              const session = sessions.find(s => s.id === menuSessionId);
              if (!session) return null;
              return (
                <>
                  <Pressable
                    className="flex-row items-center gap-4 px-5 py-4 active:bg-black/5"
                    onPress={() => handlePin(session.id)}
                    style={{ minHeight: 52 }}
                  >
                    <MaterialCommunityIcons
                      name={session.isPinned ? 'pin-off' : 'pin'}
                      size={22}
                      className="text-aura-outline"
                    />
                    <Text className="text-body-md text-aura-on-surface">
                      {session.isPinned ? t('chatDrawer.unpin') : t('chatDrawer.pin')}
                    </Text>
                  </Pressable>
                    <View className="h-px bg-aura-outline-variant mx-4" />
                  <Pressable
                    className="flex-row items-center gap-4 px-5 py-4 active:bg-black/5"
                    onPress={() => handleRenamePress(session)}
                    style={{ minHeight: 52 }}
                  >
                    <Ionicons name="create-outline" size={20} className="text-aura-on-surface-variant" />
                    <Text className="text-body-md text-aura-on-surface">{t('chatDrawer.rename')}</Text>
                  </Pressable>
                  <View className="h-px bg-[#0000000F] mx-4" />
                  <Pressable
                    className="flex-row items-center gap-4 px-5 py-4 active:bg-black/5"
                    onPress={() => handleShare(session)}
                    style={{ minHeight: 52 }}
                  >
                    <Ionicons name="share-outline" size={20} className="text-aura-on-surface-variant" />
                    <Text className="text-body-md text-aura-on-surface">{t('chatDrawer.share')}</Text>
                  </Pressable>
                  <View className="h-px bg-[#0000000F] mx-4" />
                  <Pressable
                    className="flex-row items-center gap-4 px-5 py-4 active:bg-red-50"
                    onPress={() => handleDelete(session)}
                    style={{ minHeight: 52, paddingBottom: 8 }}
                  >
                    <Ionicons name="trash-outline" size={20} color="#F53F3F" />
                    <Text className="text-body-md text-aura-error">{t('chatDrawer.delete')}</Text>
                  </Pressable>
                </>
              );
            })()}
          </View>
        </Animated.View>
      </Modal>

      {/* Rename — bottom sheet */}
      <Modal visible={!!renameSessionId} transparent animationType="fade" onRequestClose={() => setRenameSessionId(null)}>
        <Pressable className="flex-1 bg-[#00000066]" onPress={() => setRenameSessionId(null)} />
        <Animated.View
          className="absolute bottom-0 left-0 right-0"
          style={{ paddingBottom: insets.bottom, transform: [{ translateY: renameSheetTranslateY }] }}
        >
          <View className="bg-aura-surface-container rounded-t-2xl p-6">
            <View className="items-center -mt-2 mb-3">
              <View className="w-10 h-1 rounded-full bg-aura-outline-variant" />
            </View>
            <Text className="text-headline-sm text-aura-on-surface mb-4">{t('chatDrawer.rename')}</Text>
            <TextInput
              className="border border-[#0000001A] dark:border-[#2a2b2f] rounded-xl px-4 py-3 text-body-md text-aura-on-surface"
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
                <Text className="text-body-md text-aura-outline">{t('chatDrawer.cancel')}</Text>
              </Pressable>
              <Pressable
                className="px-5 py-3 rounded-xl bg-aura-primary active:opacity-80"
                onPress={handleRenameConfirm}
              >
                <Text className="text-body-md font-bold text-white">{t('chatDrawer.confirm')}</Text>
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </Modal>

      {/* Delete confirmation — bottom sheet */}
      <Modal visible={!!deleteSessionId} transparent animationType="fade" onRequestClose={() => setDeleteSessionId(null)}>
        <Pressable className="flex-1 bg-[#00000066]" onPress={() => setDeleteSessionId(null)} />
        <Animated.View
          className="absolute bottom-0 left-0 right-0"
          style={{ paddingBottom: insets.bottom, transform: [{ translateY: deleteSheetTranslateY }] }}
        >
          <View className="bg-aura-surface-container rounded-t-2xl p-6">
            <View className="items-center -mt-2 mb-3">
              <View className="w-10 h-1 rounded-full bg-aura-outline-variant" />
            </View>
            <Text className="text-headline-sm text-aura-on-surface mb-2">{t('chatDrawer.deleteConfirmTitle')}</Text>
            <Text className="text-body-md text-aura-outline mb-6">{t('chatDrawer.deleteConfirmMessage')}</Text>
            <View className="flex-row justify-end gap-3">
              <Pressable
                className="px-5 py-3 rounded-xl active:bg-black/5"
                onPress={() => setDeleteSessionId(null)}
              >
                <Text className="text-body-md text-aura-outline">{t('chatDrawer.cancel')}</Text>
              </Pressable>
              <Pressable
                className="px-5 py-3 rounded-xl bg-aura-error active:opacity-80"
                onPress={handleDeleteConfirm}
              >
                <Text className="text-body-md font-bold text-white">{t('chatDrawer.delete')}</Text>
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </Modal>
    </Modal>
  );
}
