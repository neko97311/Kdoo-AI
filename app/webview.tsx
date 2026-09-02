import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  Share,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { WebView } from 'react-native-webview';
import { useI18n } from '@/hooks/useI18n';

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function WebViewHeader({
  onClose,
  onShare,
  shareLabel,
}: {
  onClose: () => void;
  onShare: () => void;
  shareLabel: string;
}) {
  return (
    <View className="flex-row justify-between items-center px-5 pb-3 bg-aura-surface border-b border-aura-outline-variant">
      <Pressable
        accessibilityLabel="Close"
        accessibilityRole="button"
        className="p-2 -ml-2 rounded-full"
        onPress={onClose}
      >
        <Ionicons name="close" size={24} className="text-aura-on-surface-variant" />
      </Pressable>
      <View className="w-10" />
      <Pressable
        accessibilityLabel={shareLabel}
        accessibilityRole="button"
        className="p-2 -mr-2 rounded-full"
        onPress={onShare}
      >
        <Ionicons name="share-outline" size={24} className="text-aura-primary" />
      </Pressable>
    </View>
  );
}

export default function WebViewScreen() {
  const { t } = useI18n();
  const params = useLocalSearchParams<{ url?: string | string[] }>();
  const rawUrl = useMemo(() => {
    const value = Array.isArray(params.url) ? params.url[0] : params.url;
    return value ?? '';
  }, [params.url]);

  const url = useMemo(() => normalizeUrl(rawUrl), [rawUrl]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [actionSheetVisible, setActionSheetVisible] = useState(false);

  const handleClose = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }, []);

  const handleCopyLink = useCallback(async () => {
    if (!url) return;
    setActionSheetVisible(false);
    await Clipboard.setStringAsync(url);
  }, [url]);

  const handleSystemShare = useCallback(async () => {
    if (!url) return;
    setActionSheetVisible(false);
    try {
      await Share.share({
        message: url,
        url,
        title: t('webview.title'),
      });
    } catch {
      // user cancelled the system share sheet — no-op
    }
  }, [url, t]);

  const handleWebViewError = useCallback((event: { nativeEvent: { description?: string } }) => {
    console.warn('[webview] load error:', event.nativeEvent.description ?? 'unknown');
    setLoadFailed(true);
  }, []);

  const handleWebViewHttpError = useCallback(
    (event: { nativeEvent: { statusCode?: number; url?: string } }) => {
      console.warn(
        '[webview] http error:',
        event.nativeEvent.statusCode,
        event.nativeEvent.url,
      );
      setLoadFailed(true);
    },
    [],
  );

  const handleRetry = useCallback(() => {
    setLoadFailed(false);
    setReloadKey((k) => k + 1);
  }, []);

  const renderInvalid = () => (
    <View className="flex-1 bg-aura-surface">
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-5 pb-3 bg-aura-surface border-b border-aura-outline-variant">
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          className="p-2 -ml-2 rounded-full"
          onPress={handleClose}
        >
          <Ionicons name="close" size={24} className="text-aura-on-surface-variant" />
        </Pressable>
        <View className="flex-1" />
      </View>
      <View className="flex-1 items-center justify-center px-8">
        <Ionicons
          name="alert-circle-outline"
          size={48}
          className="text-aura-on-surface-variant mb-3"
        />
        <Text className="text-base font-semibold text-aura-on-surface text-center mb-1">
          {t('webview.invalidUrl')}
        </Text>
        <Text className="text-sm text-aura-on-surface-variant text-center">
          {t('webview.invalidUrlHint')}
        </Text>
      </View>
    </View>
  );

  if (!url) {
    return renderInvalid();
  }

  return (
    <View className="flex-1 bg-aura-surface">
      <Stack.Screen options={{ headerShown: false }} />
      <WebViewHeader
        onClose={handleClose}
        onShare={() => setActionSheetVisible(true)}
        shareLabel={t('webview.share')}
      />

      {loadFailed ? (
        <View className="flex-1 items-center justify-center px-8">
          <Ionicons
            name="cloud-offline-outline"
            size={56}
            className="text-aura-on-surface-variant mb-4"
          />
          <Text className="text-base font-semibold text-aura-on-surface mb-3 text-center">
            {t('webview.loadFailed')}
          </Text>
          <Pressable
            className="mt-1 px-5 py-2 rounded-full bg-aura-primary"
            onPress={handleRetry}
          >
            <Text className="text-sm font-semibold text-white">{t('webview.retry')}</Text>
          </Pressable>
        </View>
      ) : (
        <WebView
          key={reloadKey}
          source={{ uri: url }}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          startInLoadingState
          renderLoading={() => (
            <View className="absolute inset-0 items-center justify-center bg-aura-surface">
              <ActivityIndicator size="small" color="#6B7280" />
            </View>
          )}
          onError={handleWebViewError}
          onHttpError={handleWebViewHttpError}
          allowsBackButtonNavigation={false}
          style={{ flex: 1, backgroundColor: 'transparent' }}
        />
      )}

      <Modal
        visible={actionSheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setActionSheetVisible(false)}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <Pressable
            style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.5)' }}
            onPress={() => setActionSheetVisible(false)}
          />
          <View className="bg-aura-surface-container rounded-t-3xl px-6 pt-6 pb-8 max-w-md mx-auto w-full">
            <View className="w-12 h-1.5 bg-aura-outline-variant rounded-full mx-auto mb-6" />
            <Pressable
              className="flex-row items-center gap-4 p-4 rounded-xl"
              onPress={handleCopyLink}
            >
              <Ionicons name="link" size={20} className="text-aura-on-surface" />
              <Text className="text-sm font-medium text-aura-on-surface flex-1">
                {t('webview.copyLink')}
              </Text>
            </Pressable>
            <Pressable
              className="flex-row items-center gap-4 p-4 rounded-xl"
              onPress={handleSystemShare}
            >
              <Ionicons name="share-social-outline" size={20} className="text-aura-on-surface" />
              <Text className="text-sm font-medium text-aura-on-surface flex-1">
                {t('webview.share')}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}
