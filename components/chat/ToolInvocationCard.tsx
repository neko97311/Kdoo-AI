import { useMemo } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useResolvedScheme } from '@/hooks/useColors';
import { McpWebView } from './McpWebView';
import type { ToolInvocationContent, McpToolCallPayload } from '@/types';

interface ToolInvocationCardProps {
  content: ToolInvocationContent;
  onApprove?: (toolCallId: string) => void;
  onDeny?: (toolCallId: string) => void;
  /** Callback when the MCP app requests a server-side tool call */
  onMcpToolCall?: (params: McpToolCallPayload) => void;
}

type StateStyle = { label: string; icon: string; color: string; bg: string; border: string };
type StateStyleDark = { color: string; bg: string; border: string };

const STATE_CONFIG: Record<string, StateStyle> = {
  'input-streaming': {
    label: 'Preparing input...',
    icon: 'hourglass-outline',
    color: '#6B7280',
    bg: '#F3F4F6',
    border: '#E5E7EB',
  },
  'input-available': {
    label: 'Ready to execute',
    icon: 'play-outline',
    color: '#2563EB',
    bg: '#EFF6FF',
    border: '#BFDBFE',
  },
  'approval-requested': {
    label: 'Awaiting approval',
    icon: 'shield-checkmark-outline',
    color: '#B45309',
    bg: '#FFFBEB',
    border: '#FDE68A',
  },
  'output-available': {
    label: 'Completed',
    icon: 'checkmark-circle-outline',
    color: '#059669',
    bg: '#F0FDF4',
    border: '#A7F3D0',
  },
  'output-error': {
    label: 'Error',
    icon: 'alert-circle-outline',
    color: '#DC2626',
    bg: '#FEF2F2',
    border: '#FECACA',
  },
  'output-denied': {
    label: 'Denied',
    icon: 'close-circle-outline',
    color: '#6B7280',
    bg: '#F3F4F6',
    border: '#E5E7EB',
  },
};

const STATE_DARK: Record<string, StateStyleDark> = {
  'input-streaming': { color: '#9CA3AF', bg: '#1f2937', border: '#374151' },
  'input-available': { color: '#60a5fa', bg: '#1e2a3e', border: '#1e40af' },
  'approval-requested': { color: '#fbbf24', bg: '#2a2210', border: '#78350f' },
  'output-available': { color: '#34d399', bg: '#0d2818', border: '#065f46' },
  'output-error': { color: '#f87171', bg: '#2a1010', border: '#7f1d1d' },
  'output-denied': { color: '#9CA3AF', bg: '#1f2937', border: '#374151' },
};

export function ToolInvocationCard({ content, onApprove, onDeny, onMcpToolCall }: ToolInvocationCardProps) {
  const state = content.state || 'input-streaming';
  const cfg = STATE_CONFIG[state] || STATE_CONFIG['input-streaming'];
  const darkCfg = STATE_DARK[state] || STATE_DARK['input-streaming'];
  const needsApproval = state === 'approval-requested';
  const hasResult = content.result !== undefined;
  const hasError = state === 'output-error';

  // Progress: shown for long-running tools (e.g., image generation)
  const hasProgress = !!content.progress && content.progress.max > 0;
  const progressPercent = hasProgress
    ? Math.min(100, Math.round((content.progress!.value / content.progress!.max) * 100))
    : 0;
  const progressLabel = hasProgress && content.progress!.step
    ? `${content.progress!.step}… ${progressPercent}%`
    : hasProgress
      ? `${progressPercent}%`
      : null;

  // MCP structured content: render interactive WebView when available
  const resourceUri = content.structuredContent?.resourceUri;
  const hasStructuredContent = typeof resourceUri === 'string' && resourceUri.length > 0;

  // Defensive: ensure all rendered values are strings
  const safeToolName = typeof content.toolName === 'string'
    ? content.toolName
    : String((content.toolName as any)?.name ?? JSON.stringify(content.toolName) ?? 'tool');

  // Memoize toolInput/toolResult objects to keep stable references across renders.
  // Without this, new object literals on every render trigger useEffect loops in McpWebView.
  const toolInput = useMemo(
    () => (content.args ? { toolName: safeToolName, input: content.args } : undefined),
    [safeToolName, content.args],
  );
  const toolResult = useMemo(
    () => (content.result !== undefined ? { toolName: safeToolName, result: content.result } : undefined),
    [safeToolName, content.result],
  );

  const isDark = useResolvedScheme() === 'dark';

  // ── MCP interactive tool: simplified card — tool name + iframe only ──
  if (hasStructuredContent) {
    return (
      <View
        className="mt-1.5 rounded-card overflow-hidden"
        style={{
          backgroundColor: isDark ? '#1a1a2e' : '#f8f9fa',
          borderWidth: 1,
          borderColor: isDark ? '#2a2a3e' : '#e5e7eb',
        }}
      >
        {/* Minimal header: tool name only */}
        <View className="flex-row items-center gap-1.5 px-3 py-1.5">
          <Ionicons name="cube-outline" size={13} color={isDark ? '#9CA3AF' : '#6B7280'} />
          <Text className="text-label-sm font-mono text-aura-outline">
            {safeToolName}
          </Text>
        </View>

        {/* Interactive iframe */}
        <View className="px-1 pb-1">
          <McpWebView
            resourceUri={resourceUri!}
            toolCallId={content.toolCallId}
            toolInput={toolInput}
            toolResult={toolResult}
            onToolCall={onMcpToolCall}
          />
        </View>

        {/* Error output (shown only on actual error) */}
        {hasError && content.errorText ? (
          <View className="px-3 pb-2">
            <View className="bg-aura-error-container rounded p-2">
              <Text className="text-body-sm font-mono text-aura-error" selectable>
                {typeof content.errorText === 'string' ? content.errorText : JSON.stringify(content.errorText)}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    );
  }

  // ── Regular tool invocation: full status card ──
  const bgColor = isDark ? darkCfg.bg : cfg.bg;
  const borderColor = isDark ? darkCfg.border : cfg.border;
  const textColor = isDark ? darkCfg.color : cfg.color;

  return (
    <View
      className="mt-1.5 rounded-card overflow-hidden"
      style={{
        backgroundColor: bgColor,
        borderWidth: 1,
        borderColor: borderColor,
      }}
    >
      {/* Header */}
      <View className="flex-row items-center gap-2 px-3 py-2">
        <Ionicons name={cfg.icon as any} size={15} color={textColor} />
        <View className="flex-1">
          <Text className="text-label-sm font-medium" style={{ color: textColor }}>
            {progressLabel ?? cfg.label}
          </Text>
          <Text className="text-label-xs text-aura-outline font-mono mt-0.5">
            {safeToolName}
          </Text>
        </View>
      </View>

      {/* Progress bar */}
      {hasProgress ? (
        <View className="px-3 pb-2">
          <View
            className="h-2 rounded-full overflow-hidden"
            style={{ backgroundColor: isDark ? '#374151' : '#E5E7EB' }}
          >
            <View
              className="h-full rounded-full"
              style={{
                width: `${progressPercent}%`,
                backgroundColor: textColor,
              }}
            />
          </View>
        </View>
      ) : null}

      {/* Args */}
      {content.args ? (
        <View className="px-3 pb-2">
          <Text className="text-label-xs font-medium text-aura-outline mb-1">Input:</Text>
          <View className="bg-aura-surface-container-high/50 rounded p-2">
            <Text className="text-body-sm font-mono text-aura-on-surface-variant" selectable>
              {formatValue(content.args)}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Result output */}
      {hasResult ? (
        <View className="px-3 pb-2">
          <Text className="text-label-xs font-medium text-aura-outline mb-1">Result:</Text>
          <View className="bg-aura-surface-container-high/50 rounded p-2" style={{ maxHeight: 200 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text className="text-body-sm font-mono text-aura-on-surface-variant" selectable>
                {formatValue(content.result)}
              </Text>
            </ScrollView>
          </View>
        </View>
      ) : null}

      {/* Error output */}
      {hasError && content.errorText ? (
        <View className="px-3 pb-2">
          <Text className="text-label-xs font-medium text-aura-error mb-1">Error:</Text>
          <View className="bg-aura-error-container rounded p-2">
            <Text className="text-body-sm font-mono text-aura-error" selectable>
              {typeof content.errorText === 'string' ? content.errorText : JSON.stringify(content.errorText)}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Approval buttons */}
      {needsApproval ? (
        <View className="flex-row gap-2 px-3 pb-2.5">
          <Pressable
            className="flex-1 flex-row items-center justify-center gap-1.5 py-2 rounded-lg bg-aura-error-container border border-aura-error/30 active:opacity-80"
            onPress={() => onDeny?.(content.toolCallId)}
          >
            <Ionicons name="close-outline" size={16} className="text-aura-error" />
            <Text className="text-label-sm font-medium text-aura-error">Deny</Text>
          </Pressable>
          <Pressable
            className="flex-1 flex-row items-center justify-center gap-1.5 py-2 rounded-lg bg-aura-primary active:opacity-80"
            onPress={() => onApprove?.(content.toolCallId)}
          >
            <Ionicons name="checkmark-outline" size={16} color="#FFFFFF" />
            <Text className="text-label-sm font-medium text-white">Approve</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return value;
    }
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}
