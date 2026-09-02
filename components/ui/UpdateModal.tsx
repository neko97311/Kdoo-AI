import { View, Text, Pressable, Modal, Linking, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useI18n } from '@/hooks/useI18n';
import { useResolvedScheme } from '@/hooks/useColors';

interface UpdateModalProps {
  visible: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  downloadUrl?: string | null;
  onDismiss: () => void;
}

export function UpdateModal({
  visible,
  currentVersion,
  latestVersion,
  releaseNotes,
  downloadUrl,
  onDismiss,
}: UpdateModalProps) {
  const isDark = useResolvedScheme() === 'dark';
  const { t } = useI18n();

  const handleDownload = async () => {
    if (downloadUrl) {
      try {
        await Linking.openURL(downloadUrl);
      } catch (e) {
        console.warn('[UpdateModal] failed to open URL:', e);
      }
    }
    onDismiss();
  };

  const hasDownload = Boolean(downloadUrl);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }}
        onPress={onDismiss}
      >
        <View
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}
        >
          <Pressable
            className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#1a1b1e] px-6 pt-6 pb-5 active:scale-[0.98]"
            onPress={(e) => e.stopPropagation?.()}
          >
            {/* Icon */}
            <View className="items-center mb-4">
              <View
                className={`w-12 h-12 rounded-full items-center justify-center ${
                  isDark ? 'bg-[#4648d4]/20' : 'bg-[#4648d4]/10'
                }`}
              >
                <Ionicons name="cloud-download-outline" size={24} color="#4648d4" />
              </View>
            </View>

            {/* Title */}
            <Text className="text-base font-semibold text-center text-[#191c1e] dark:text-[#e6e8ea] mb-2">
              {t('update.title')}
            </Text>

            {/* Version info */}
            <Text className="text-sm text-center text-[#464554] dark:text-[#9a99a9] mb-3">
              {t('update.versionInfo', { current: currentVersion, latest: latestVersion })}
            </Text>

            {/* Release notes */}
            {releaseNotes ? (
              <ScrollView
                className="max-h-40 mb-5 rounded-lg bg-[#f7f9fb] dark:bg-[#0f1117] p-3"
                showsVerticalScrollIndicator
              >
                <Text className="text-xs font-semibold text-[#464554] dark:text-[#9a99a9] mb-1">
                  {t('update.releaseNotesLabel')}
                </Text>
                <Text className="text-sm text-[#191c1e] dark:text-[#e6e8ea] leading-5">
                  {releaseNotes}
                </Text>
              </ScrollView>
            ) : (
              <View className="mb-5" />
            )}

            {/* Buttons */}
            {hasDownload ? (
              <>
                <Pressable
                  className="w-full h-12 bg-[#4648d4] rounded-full items-center justify-center mb-2.5 active:opacity-90"
                  onPress={handleDownload}
                >
                  <Text className="text-sm font-semibold text-white">{t('update.download')}</Text>
                </Pressable>
                <Pressable
                  className="w-full h-12 rounded-full items-center justify-center active:opacity-70"
                  onPress={onDismiss}
                >
                  <Text className="text-sm font-medium text-[#464554] dark:text-[#9a99a9]">
                    {t('update.later')}
                  </Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                className="w-full h-12 bg-[#4648d4] rounded-full items-center justify-center active:opacity-90"
                onPress={onDismiss}
              >
                <Text className="text-sm font-semibold text-white">{t('update.gotIt')}</Text>
              </Pressable>
            )}
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}
