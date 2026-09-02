# 平台判断优雅化重构 — 方案C（混合方案）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将项目中散落的 `Platform.OS` 判断统一为更优雅的模式：UI 渲染层用 `.web.tsx` / `.native.tsx` 平台扩展文件，服务层用 `isWeb` / `isNative` / `isIOS` 常量。

**Architecture:** 三层改造 — (1) 新建 `utils/platform.ts` 导出平台常量；(2) 服务层/工具层用常量替换 `Platform.OS ===`；(3) ChatBubble 中的 UI 渲染分支拆为 `.web.tsx` / `.native.tsx`。

**Tech Stack:** React Native, Expo SDK 56, TypeScript, Metro bundler (原生支持平台扩展文件)

---

### Task 1: 创建平台常量工具

**Files:**
- Create: `utils/platform.ts`

**Step 1: 创建 utils/platform.ts**

```ts
import { Platform } from 'react-native';

export const isWeb = Platform.OS === 'web';
export const isNative = Platform.OS !== 'web';
export const isIOS = Platform.OS === 'ios';
export const isAndroid = Platform.OS === 'android';
```

**Step 2: 无需单独测试** — 这些是编译时常量，后续 Task 的集成测试覆盖。

**Step 3: Commit**

```
feat: add platform constants utility (utils/platform.ts)
```

---

### Task 2: 服务层/工具层 — 用平台常量简化

将所有 `Platform.OS === 'web'` / `Platform.OS !== 'web'` / `Platform.OS === 'ios'` 替换为常量。

**Files:**
- Modify: `hooks/useTheme.tsx`
- Modify: `utils/attachments.ts`
- Modify: `services/upload-service.ts`
- Modify: `services/voice-service.ts`
- Modify: `services/websocket.ts`
- Modify: `components/chat/ChatInputBar.tsx`
- Modify: `components/chat/ChatHeader.tsx`
- Modify: `components/chat/ChatView.tsx`
- Modify: `components/chat/ChatHome.tsx`
- Modify: `app/(auth)/login.tsx`
- Modify: `app/(auth)/signup.tsx`
- Modify: `app/(auth)/register.tsx`
- Modify: `app/(auth)/forgot-password.tsx`

**Step 1: 批量替换规则**

每个文件的改动模式：

| 原代码 | 新代码 |
|--------|--------|
| `import { ..., Platform } from 'react-native';` | 拆为 `import { ... } from 'react-native';` + `import { isWeb } from '@/utils/platform';` (仅导入需要的常量) |
| `Platform.OS === 'web'` | `isWeb` |
| `Platform.OS !== 'web'` | `isNative` |
| `Platform.OS === 'ios'` | `isIOS` |
| `Platform.OS === 'ios' ? 'padding' : 'height'` | `isIOS ? 'padding' : 'height'` |

**Step 2: 每个文件的具体改动**

#### hooks/useTheme.tsx
```
- import { Appearance, Platform } from 'react-native';
+ import { Appearance } from 'react-native';
+ import { isNative } from '@/utils/platform';

- if (Platform.OS !== 'web' && Appearance.setColorScheme) {
+ if (isNative && Appearance.setColorScheme) {

- if (Platform.OS !== 'web' && nativeColorScheme) {
+ if (isNative && nativeColorScheme) {
```

#### utils/attachments.ts
```
- import { Platform } from 'react-native';
+ import { isWeb } from '@/utils/platform';

- if (Platform.OS === 'web') return true;  (×2处)
+ if (isWeb) return true;

- if (Platform.OS === 'web') {
+ if (isWeb) {
```

#### services/upload-service.ts
```
- import { Platform } from 'react-native';
+ import { isWeb } from '@/utils/platform';

- if (Platform.OS === 'web') {
+ if (isWeb) {
```

#### services/voice-service.ts
```
- import { Platform } from 'react-native';
+ import { isWeb } from '@/utils/platform';

- if (Platform.OS === 'web') {
+ if (isWeb) {

- Platform.OS === 'web' &&
+ isWeb &&
```

#### services/websocket.ts
```
- import { Platform } from 'react-native';  → 保留（还有 console.log(Platform.OS)）
+ import { isWeb } from '@/utils/platform';
  (console.log 中的 Platform.OS 保留不变，那是调试日志)
```

#### components/chat/ChatInputBar.tsx
```
- import { ..., Platform, ... } from 'react-native';
+ import { ..., ... } from 'react-native';
+ import { isWeb, isIOS } from '@/utils/platform';

- if (willBeTextMode && Platform.OS !== 'web') {
+ if (willBeTextMode && !isWeb) {

- if (Platform.OS === 'web') {
+ if (isWeb) {

- behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
+ behavior={isIOS ? 'padding' : 'height'}
```

#### components/chat/ChatHeader.tsx
```
- import { ..., Platform, ... } from 'react-native';
+ import { ..., ... } from 'react-native';
+ import { isWeb } from '@/utils/platform';

- {Platform.OS === 'web' ? (
+ {isWeb ? (
```

#### components/chat/ChatView.tsx
```
+ import { isWeb } from '@/utils/platform';

- ...(Platform.OS === 'web'
+ ...(isWeb
```

#### components/chat/ChatHome.tsx
```
+ import { isWeb } from '@/utils/platform';

- ...(Platform.OS === 'web'
+ ...(isWeb
```

#### app/(auth)/login.tsx
```
- import { ..., Platform, ... } from 'react-native';
+ import { ..., ... } from 'react-native';
+ import { isIOS } from '@/utils/platform';

- behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
+ behavior={isIOS ? 'padding' : 'height'}

- {Platform.OS === 'ios' && (
+ {isIOS && (
```

#### app/(auth)/signup.tsx — 同 login.tsx 模式

#### app/(auth)/register.tsx
```
- import { ..., Platform, ... } from 'react-native';
+ import { ..., ... } from 'react-native';
+ import { isIOS } from '@/utils/platform';

- behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
+ behavior={isIOS ? 'padding' : 'height'}
```

#### app/(auth)/forgot-password.tsx — 同 register.tsx 模式

**Step 3: 验证**

- 确认所有文件不再直接引用 `Platform.OS` 做条件判断（仅保留 `websocket.ts` 中的 console.log 调试输出和 `ChatBubble.tsx` 中的判断 — 后者在 Task 3 处理）
- 运行 `pnpm lint` 确认无报错

**Step 4: Commit**

```
refactor: replace Platform.OS checks with platform constants in service/util layers
```

---

### Task 3: ChatBubble — 拆出 ImagePreviewOverlay 平台扩展文件

将 `ImagePreviewOverlay` 组件从 ChatBubble.tsx 中拆出为 `.web.tsx` / `.native.tsx` 两个文件。

**Files:**
- Create: `components/chat/ImagePreviewOverlay.web.tsx`
- Create: `components/chat/ImagePreviewOverlay.native.tsx`

**Step 1: 创建 ImagePreviewOverlay.web.tsx**

```tsx
import React from 'react';

interface ImagePreviewOverlayProps {
  previewUri: string | null;
  onClose: () => void;
}

export function ImagePreviewOverlay({ previewUri, onClose }: ImagePreviewOverlayProps) {
  if (!previewUri) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        backgroundColor: 'rgba(0,0,0,0.9)',
        display: 'flex', justifyContent: 'center', alignItems: 'center',
      }}
    >
      <div
        onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClose(); }}
        style={{ position: 'absolute', top: 48, right: 16, zIndex: 1, cursor: 'pointer', color: '#fff', fontSize: 28 }}
      >
        ✕
      </div>
      <img
        src={previewUri}
        alt="Preview"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain' }}
      />
    </div>
  );
}
```

**Step 2: 创建 ImagePreviewOverlay.native.tsx**

```tsx
import React from 'react';
import { Modal, Pressable, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface ImagePreviewOverlayProps {
  previewUri: string | null;
  onClose: () => void;
}

export function ImagePreviewOverlay({ previewUri, onClose }: ImagePreviewOverlayProps) {
  if (!previewUri) return null;

  return (
    <Modal
      visible={!!previewUri}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' }}
        onPress={onClose}
      >
        <Pressable onPress={onClose} style={{ position: 'absolute', top: 48, right: 16, zIndex: 1 }}>
          <Ionicons name="close" size={28} color="#fff" />
        </Pressable>
        <Image
          source={{ uri: previewUri }}
          style={{ width: '90%', height: '90%', resizeMode: 'contain' }}
        />
      </Pressable>
    </Modal>
  );
}
```

**Step 3: 修改 ChatBubble.tsx**

删除 `ImagePreviewOverlay` 函数定义（第 507-558 行），改为导入：

```tsx
// 在文件顶部 import 区域添加：
import { ImagePreviewOverlay } from './ImagePreviewOverlay';
```

Metro 会根据平台自动解析 `.web.tsx` 或 `.native.tsx`。

**Step 4: 验证**

- 确认 ChatBubble.tsx 中 `ImagePreviewOverlay` 的定义已删除
- 确认导入语句正确
- `pnpm lint` 通过

**Step 5: Commit**

```
refactor: extract ImagePreviewOverlay into .web.tsx / .native.tsx platform files
```

---

### Task 4: ChatBubble — 拆出 MessageContentRenderer 平台扩展文件

将 ChatBubble 内部 `renderContent` 中散落的 5 处 `Platform.OS === 'web'` 判断（markdown 渲染、image 渲染、file 渲染）拆到平台扩展文件中。

**Files:**
- Create: `components/chat/MarkdownRenderer.web.tsx`
- Create: `components/chat/MarkdownRenderer.native.tsx`
- Create: `components/chat/ImageContent.web.tsx`
- Create: `components/chat/ImageContent.native.tsx`
- Modify: `components/chat/ChatBubble.tsx`

**Step 1: 创建 MarkdownRenderer.web.tsx**

```tsx
import React, { useMemo, useEffect } from 'react';
import { View } from 'react-native';
import MarkdownIt from 'markdown-it';

const mdParser = new MarkdownIt({ typographer: true, breaks: true }).disable(['image', 'table']);

// Web Markdown renderer — renders HTML via dangerouslySetInnerHTML.
export function WebMarkdown({ children }: { children: string }) {
  const html = useMemo(() => mdParser.render(children), [children]);

  useEffect(() => {
    if (document.getElementById('md-web-styles')) return;
    const style = document.createElement('style');
    style.id = 'md-web-styles';
    style.textContent = `
      .md-body {
        color: #1D2129; font-size: 15px; line-height: 24px;
        white-space: pre-wrap; overflow-wrap: break-word; min-width: 0;
      }
      .md-body p { margin: 0 0 8px; }
      .md-body p:last-child { margin-bottom: 0; }
      .md-body strong { font-weight: 700; }
      .md-body em { font-style: italic; }
      .md-body a { color: #2563EB; text-decoration: underline; }
      .md-body code {
        background: rgba(0,0,0,0.06); padding: 2px 6px; border-radius: 4px;
        font-family: monospace; font-size: 13px;
      }
      .md-body pre { margin: 8px 0; }
      .md-body pre code {
        display: block; padding: 12px; background: #1e1e1e;
        color: #d4d4d4; border-radius: 8px; overflow-x: auto;
      }
      .md-body blockquote {
        border-left: 3px solid #d1d5db; padding-left: 12px; margin: 8px 0;
        color: #6b7280;
      }
      .md-body ul, .md-body ol { padding-left: 20px; margin: 4px 0; }
      .md-body li { margin: 2px 0; }
      .md-body h1, .md-body h2, .md-body h3, .md-body h4 {
        font-weight: 700; margin: 12px 0 4px;
      }
      .md-body h1 { font-size: 20px; }
      .md-body h2 { font-size: 18px; }
      .md-body h3 { font-size: 16px; }
      .md-body hr { border: none; border-top: 1px solid #e5e7eb; margin: 12px 0; }
    `;
    document.head.appendChild(style);
  }, []);

  return (
    <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

export function MarkdownRenderer({ text, style }: { text: string; style?: any }) {
  return (
    <View style={style}>
      <WebMarkdown>{text}</WebMarkdown>
    </View>
  );
}
```

注意：这里直接从 ChatBubble.tsx 中搬出 WebMarkdown 函数和 mdParser 实例（web 版本）。CSS 样式也需要完整搬过来 — 实施时需要从 ChatBubble.tsx 第 88-120 行复制完整的 CSS。

**Step 2: 创建 MarkdownRenderer.native.tsx**

```tsx
import React, { Component, type ReactNode } from 'react';
import { View, Text } from 'react-native';
import MarkdownIt from 'markdown-it';

const mdParser = new MarkdownIt({ typographer: true, breaks: true }).disable(['image', 'table']);

// ErrorBoundary for native markdown
class MarkdownErrorBoundary extends Component<
  { children: ReactNode; fallbackText: string },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownErrorBoundary] NativeMarkdown failed, falling back to plain text:', error.message);
  }
  render() {
    if (this.state.hasError) {
      return (
        <Text className="text-body-md leading-6 text-[#1D2129] dark:text-[#e0e0e0]" selectable>
          {this.props.fallbackText}
        </Text>
      );
    }
    return this.props.children;
  }
}

// Lazy-load native markdown renderer
let NativeMarkdown: React.ComponentType<{
  children: string; style?: any; markdownit?: any; mergeStyle?: boolean;
}> | null = null;
try {
  const Mod = require('react-native-markdown-display');
  NativeMarkdown = Mod.default || Mod.Markdown;
} catch (e) {
  console.warn('[MarkdownRenderer] Failed to load native markdown lib:', e);
}

// Native markdown styles — 从 ChatBubble.tsx 搬出
const nativeMarkdownStyles = { /* 从原文件第 133-260 行复制 */ };

export function MarkdownRenderer({ text, style }: { text: string; style?: any }) {
  if (NativeMarkdown) {
    return (
      <MarkdownErrorBoundary fallbackText={text}>
        <View style={style}>
          <NativeMarkdown markdownit={mdParser} style={nativeMarkdownStyles} mergeStyle={true}>
            {text}
          </NativeMarkdown>
        </View>
      </MarkdownErrorBoundary>
    );
  }
  // Fallback: plain text
  return (
    <Text className="text-body-md leading-6 text-[#1D2129] dark:text-[#e0e0e0]" style={style} selectable>
      {text}
    </Text>
  );
}
```

注意：`nativeMarkdownStyles` 需要从 ChatBubble.tsx 第 133-260 行完整搬过来。实施时必须完整复制。

**Step 3: 创建 ImageContent.web.tsx**

```tsx
import React from 'react';

interface ImageContentProps {
  uri: string;
  alt?: string;
  onPress?: (uri: string) => void;
  maxWidth?: number;
}

export function ImageContent({ uri, alt, onPress, maxWidth }: ImageContentProps) {
  return (
    <div
      onClick={() => onPress?.(uri)}
      style={{
        width: '50%',
        maxWidth: maxWidth ?? undefined,
        aspectRatio: 1,
        borderRadius: 8,
        overflow: 'hidden',
        cursor: onPress ? 'pointer' : undefined,
      }}
    >
      <img
        src={uri}
        alt={alt || ''}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    </div>
  );
}
```

**Step 4: 创建 ImageContent.native.tsx**

```tsx
import React from 'react';
import { Pressable, Image, ImageSourcePropType } from 'react-native';

interface ImageContentProps {
  uri: string | ImageSourcePropType;
  alt?: string;
  onPress?: (uri: string) => void;
  maxWidth?: number;
}

export function ImageContent({ uri, alt, onPress, maxWidth }: ImageContentProps) {
  const source = typeof uri === 'string' ? { uri } : uri;
  return (
    <Pressable onPress={() => onPress?.(typeof uri === 'string' ? uri : (uri as any).uri || '')} style={{ width: '50%' }}>
      <Image
        source={source}
        className="rounded-card w-full"
        style={{ aspectRatio: 1, maxWidth: maxWidth, maxHeight: maxWidth }}
        resizeMode="cover"
        accessibilityLabel={alt}
      />
    </Pressable>
  );
}
```

**Step 5: 修改 ChatBubble.tsx**

核心改动：
1. 删除 `MarkdownErrorBoundary` 类定义（搬到 MarkdownRenderer.native.tsx）
2. 删除 `NativeMarkdown` 加载逻辑（第 57-77 行，搬到 MarkdownRenderer.native.tsx）
3. 删除 `WebMarkdown` 函数（第 79-124 行，搬到 MarkdownRenderer.web.tsx）
4. 删除 `nativeMarkdownStyles`（搬到 MarkdownRenderer.native.tsx）
5. 删除 `ImagePreviewOverlay` 函数（已在 Task 3 拆出）
6. 在 `renderContent` 函数中替换平台判断：

```tsx
// 新增 import
import { MarkdownRenderer } from './MarkdownRenderer';
import { ImageContent } from './ImageContent';
import { ImagePreviewOverlay } from './ImagePreviewOverlay';

// renderContent 中的改动：

// 文本渲染（替换第 312-342 行）:
case 'text':
  if (isUser) { /* 保持不变 */ }
  const textStyle = idx > 0 ? { marginTop: 8 } : undefined;
  return <MarkdownRenderer key={idx} text={item.text} style={textStyle} />;

// 图片渲染（替换第 343-371 行）:
case 'image': {
  const imgSrc = authImageSource(item.uri || item.data || '');
  const imgUri = typeof imgSrc === 'object' ? imgSrc.uri : imgSrc;
  return <ImageContent key={idx} uri={imgUri} alt={item.alt} onPress={onImagePress} />;
}

// 文件中的图片（替换第 377-405 行）:
if (fileItem.mediaType?.startsWith('image/')) {
  const fileImgSrc = authImageSource(fileDataUrl || '');
  const fileImgUri = typeof fileImgSrc === 'object' ? fileImgSrc.uri : fileImgUri;
  return <ImageContent key={idx} uri={fileImgUri} alt={fileItem.name} onPress={onImagePress} maxWidth={150} />;
}
```

**Step 6: 验证**

- `pnpm lint` 通过
- 确认 ChatBubble.tsx 不再包含 `Platform.OS` 判断（debug.tsx 中的 `require('react-native')` Linking 调用保留，那是动态 import 且有 catch 兜底）
- 确认新文件的类型导出正确

**Step 7: Commit**

```
refactor: extract MarkdownRenderer and ImageContent into platform-specific files

- MarkdownRenderer.web.tsx: HTML rendering via dangerouslySetInnerHTML
- MarkdownRenderer.native.tsx: react-native-markdown-display with error boundary
- ImageContent.web.tsx: native <img> element
- ImageContent.native.tsx: RN <Image> with Pressable
- ChatBubble.tsx: simplified to use platform-abtracted components
```

---

### Task 5: 最终验证与清理

**Step 1: 全局搜索确认无遗漏**

搜索所有 `.ts` / `.tsx` 文件中的 `Platform.OS`，确认只在以下位置保留：
- `utils/platform.ts` — 常量定义
- `services/websocket.ts` — console.log 调试（可接受）
- `services/voice-service.ts` 的 `isMediaRecorderSupported` — 已用 `isWeb`
- `modules/kdoo-signature/src/KdooSignatureModule.ts` — Android-only 原生模块守卫（可保留原写法）

**Step 2: 运行 lint**

```bash
cd projects/app && pnpm lint
```

Expected: 0 errors

**Step 3: 运行 dev 验证 web 端无崩溃**

```bash
cd projects/app && pnpm web
```

Expected: Web 页面正常加载，无 `setColorScheme is not a function` 或其他平台错误

**Step 4: Commit**

```
chore: verify platform abstraction refactor, all Platform.OS checks accounted for
```

---

## 改动总结

| 文件 | 改动类型 |
|------|----------|
| `utils/platform.ts` | **新建** — 平台常量 |
| `hooks/useTheme.tsx` | 修改 — 用 `isNative` |
| `utils/attachments.ts` | 修改 — 用 `isWeb` |
| `services/upload-service.ts` | 修改 — 用 `isWeb` |
| `services/voice-service.ts` | 修改 — 用 `isWeb` |
| `services/websocket.ts` | 修改 — 用 `isWeb` (保留 Platform.OS 调试用) |
| `components/chat/ChatInputBar.tsx` | 修改 — 用 `isWeb` / `isIOS` |
| `components/chat/ChatHeader.tsx` | 修改 — 用 `isWeb` |
| `components/chat/ChatView.tsx` | 修改 — 用 `isWeb` |
| `components/chat/ChatHome.tsx` | 修改 — 用 `isWeb` |
| `app/(auth)/login.tsx` | 修改 — 用 `isIOS` |
| `app/(auth)/signup.tsx` | 修改 — 用 `isIOS` |
| `app/(auth)/register.tsx` | 修改 — 用 `isIOS` |
| `app/(auth)/forgot-password.tsx` | 修改 — 用 `isIOS` |
| `components/chat/ImagePreviewOverlay.web.tsx` | **新建** |
| `components/chat/ImagePreviewOverlay.native.tsx` | **新建** |
| `components/chat/MarkdownRenderer.web.tsx` | **新建** |
| `components/chat/MarkdownRenderer.native.tsx` | **新建** |
| `components/chat/ImageContent.web.tsx` | **新建** |
| `components/chat/ImageContent.native.tsx` | **新建** |
| `components/chat/ChatBubble.tsx` | 修改 — 大幅瘦身，删除平台判断 |
