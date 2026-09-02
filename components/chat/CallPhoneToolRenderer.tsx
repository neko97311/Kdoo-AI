import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useResolvedScheme } from '@/hooks/useColors';
import { useI18n } from '@/hooks/useI18n';
import type { ToolInvocationContent } from '@/types';
import { dialPhoneNumber, extractPhoneNumber } from '@/utils/phone';
import {
  claimToolCallExecution,
  hasToolCallExecuted,
  markToolCallExecuted,
} from '@/lib/db/repositories/tool-exec-repo';

/** Auto-dial only fires for freshly-arrived invocations; older = history. */
const AUTO_DIAL_MAX_AGE_MS = 30_000;

/**
 * Client-executed "Call" tool card. When the agent emits a
 * `callPhoneTool` invocation, this card mounts and dials ONCE with the
 * passed phone number (Android: auto-call; iOS: system confirm dialog).
 *
 * Auto-dial guards - history loads and remounts must NOT re-dial:
 *   1. Message age > 30s -> history message, never auto-dial.
 *   2. toolCallId already claimed this app session (in-memory Set).
 *   3. toolCallId already executed on this device (SQLite
 *      `client_tool_executed` marker - survives cold restarts).
 * A redial button covers retries and manual calls (never guarded).
 */
export function CallPhoneToolRenderer({
  content,
  messageCreatedAt,
}: {
  content: ToolInvocationContent;
  messageCreatedAt?: Date | string;
}) {
  const isDark = useResolvedScheme() === 'dark';
  const { t } = useI18n();
  const phoneNumber = extractPhoneNumber(content.args);
  const triggered = useRef(false);

  const dial = (num: string) => {
    void dialPhoneNumber(num);
  };

  useEffect(() => {
    if (triggered.current || !phoneNumber) return;
    triggered.current = true;

    // Guard 1: history guard. Messages loaded from API / SQLite / MMKV
    // carry an old createdAt - only auto-dial freshly-arrived ones.
    // Missing/unparseable timestamps are treated as FRESH: every history
    // path sets createdAt (NOT NULL in SQLite, always returned by the
    // API), so "missing" can only mean an in-flight live message.
    const created = messageCreatedAt ? new Date(messageCreatedAt).getTime() : NaN;
    if (Number.isFinite(created) && Date.now() - created > AUTO_DIAL_MAX_AGE_MS) return;

    // Guard 2: session claim (sync) - closes the remount race while the
    // async SQLite check below is still in flight.
    if (!claimToolCallExecution(content.toolCallId)) return;

    void (async () => {
      try {
        // Guard 3: device-level marker persisted in SQLite (cold-restart safe).
        if (await hasToolCallExecuted(content.toolCallId)) return;
      } catch {
        // DB hiccup: time guard already passed - keep live-arrival behavior.
      }
      dial(phoneNumber);
      void markToolCallExecuted(content.toolCallId).catch(() => {});
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneNumber]);

  const cardBg = isDark ? '#1a1a2e' : '#f8f9fa';
  const cardBorder = isDark ? '#2a2a3e' : '#e5e7eb';
  const titleColor = isDark ? '#e5e7eb' : '#1e293b';

  return (
    <View style={[styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}>
      <View style={styles.iconCircle}>
        <MaterialCommunityIcons name="phone-outgoing" size={18} color="#16a34a" />
      </View>
      <View style={styles.textCol}>
        <Text style={[styles.number, { color: titleColor }]} numberOfLines={1}>
          {phoneNumber ?? t('call.unknownNumber')}
        </Text>
      </View>
      {phoneNumber ? (
        <Pressable onPress={() => dial(phoneNumber)} hitSlop={8} style={styles.redial}>
          <Ionicons name="call" size={20} color="#16a34a" />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 6,
    marginRight: 4,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(22,163,74,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  textCol: {
    flex: 1,
    gap: 2,
  },
  number: {
    fontSize: 14,
    fontWeight: '600',
  },
  redial: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
