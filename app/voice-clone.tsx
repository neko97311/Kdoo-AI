// 向后兼容的路由壳：原本是独立录音页面，现改造为半屏弹层组件。
// 真正的 UI 在 components/voice/VoiceCloneSheet.tsx。本文件保留路径是为了
// 兼容任何遗留的 /voice-clone 跳转（含 voice-settings 的 retry）。
import { useRouter } from 'expo-router';
import { VoiceCloneSheet } from '@/components/voice/VoiceCloneSheet';

export default function VoiceCloneScreen() {
  const router = useRouter();
  return <VoiceCloneSheet visible onClose={() => router.back()} />;
}
