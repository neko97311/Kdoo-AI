import { useEffect, useState } from 'react';
import { isWeb } from '@/utils/platform';
import { View, Text, Pressable, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import { useAuthStore } from '@/stores/auth';
import { resolveAvatarUrl } from '@/services/user';

interface ChatHeaderProps {
  onMenuPress?: () => void;
  onRightPress?: () => void;
  title?: string;
  rightIcon?: 'avatar' | 'more' | 'play';
  /** Auto-play TTS state - only used when rightIcon='play' */
  isAutoPlay?: boolean;
  /** Toggle handler - only used when rightIcon='play' */
  onToggleAutoPlay?: () => void;
  /**
   * Share the current session. When provided, renders a share button to the
   * LEFT of the right-side icon (keeps existing icons' positions stable).
   */
  onSharePress?: () => void;
  /** Accessibility label for the share button (i18n). */
  shareLabel?: string;
}

export function ChatHeader({
  onMenuPress,
  onRightPress,
  title = 'KDOO AI',
  rightIcon = 'more',
  isAutoPlay = false,
  onToggleAutoPlay,
  onSharePress,
  shareLabel,
}: ChatHeaderProps) {
  const user = useAuthStore((s) => s.user);

  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);

  // Reset error state when avatar changes (e.g. re-upload)
  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [user?.avatar]);

  const displayName = user?.displayName || user?.username;
  const initials = displayName ? displayName.slice(0, 2).toUpperCase() : 'K';

  const showFallback = !user?.avatar || avatarLoadFailed;

  return (
    <View
      className="flex-row justify-between items-center px-4 h-14 w-full bg-aura-surface border-b border-aura-outline-variant"
    >
      <Pressable
        className="p-2 rounded-full active:opacity-70"
        onPress={onMenuPress}
        style={{ minWidth: 44, minHeight: 44 }}
      >
        <Ionicons name="menu" size={24} className="text-aura-on-surface" />
      </Pressable>

      <View className="flex-1 items-center justify-center overflow-hidden px-2">
        {isWeb ? (
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              fontSize: 20,
              lineHeight: 28,
              fontWeight: '600',
              backgroundImage: 'linear-gradient(90deg, #1D4ED8, #3B82F6)',
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              color: 'transparent',
            } as any}
          >
            {title}
          </Text>
        ) : (
          <View className="flex-row items-center justify-center">
            <MaskedView
              maskElement={
                <View style={{ backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                  <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={{ fontSize: 20, lineHeight: 28, fontWeight: '600', color: '#000' }}
                  >
                    {title}
                  </Text>
                </View>
              }
            >
              <LinearGradient
                colors={['#1D4ED8', '#3B82F6']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
              >
                <Text
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  style={{ fontSize: 20, lineHeight: 28, fontWeight: '600', color: '#000', opacity: 0 }}
                >
                  {title}
                </Text>
              </LinearGradient>
            </MaskedView>
          </View>
        )}
      </View>

      {onSharePress ? (
        <Pressable
          className="p-2 rounded-full active:opacity-70"
          onPress={onSharePress}
          accessibilityLabel={shareLabel}
          accessibilityRole="button"
          style={{ minWidth: 44, minHeight: 44 }}
        >
          <Ionicons name="share-outline" size={24} className="text-aura-on-surface-variant" />
        </Pressable>
      ) : null}

      {rightIcon === 'avatar' ? (
        <Pressable
          className="p-2 rounded-full active:opacity-70"
          onPress={onRightPress}
          style={{ minWidth: 44, minHeight: 44 }}
        >
          {showFallback ? (
            <LinearGradient
              colors={['#1D4ED8', '#2563EB']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text className="text-xs font-bold text-white">{initials}</Text>
            </LinearGradient>
          ) : (
            <Image
              source={{ uri: resolveAvatarUrl(user.avatar) }}
              style={{ width: 32, height: 32, borderRadius: 16 }}
              onError={() => setAvatarLoadFailed(true)}
            />
          )}
        </Pressable>
      ) : rightIcon === 'play' ? (
        <Pressable
          className="p-2 rounded-full active:opacity-70"
          onPress={onToggleAutoPlay}
          style={{ minWidth: 44, minHeight: 44 }}
        >
          <Ionicons
            name={isAutoPlay ? 'volume-high' : 'volume-mute'}
            size={24}
            color={isAutoPlay ? '#1D4ED8' : '#86909C'}
          />
        </Pressable>
      ) : (
        <Pressable
          className="p-2 rounded-full active:opacity-70"
          onPress={onRightPress}
          style={{ minWidth: 44, minHeight: 44 }}
        >
          <Ionicons name="ellipsis-vertical" size={24} className="text-aura-on-surface-variant" />
        </Pressable>
      )}
    </View>
  );
}
