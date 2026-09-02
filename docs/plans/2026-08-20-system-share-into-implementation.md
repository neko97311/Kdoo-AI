# 系统分享到 App（Share-into）实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Elioo（kdoo-mobile）能通过系统分享面板接收文本/URL/图片，并直接作为一条用户消息发送到当前 AI 会话（无中转页）。

**Architecture:** 复用已安装的 `expo-sharing@57.0.8` 官方接收能力（iOS ShareExtension + Android `ACTION_SEND` intent + `useIncomingShare`/`getSharedPayloads` API）。在 `app.config.ts` 启用 expo-sharing 接收配置，新增一个 linking-interceptor 分支拦截 `expo-sharing://` hostname 的深链，扩展 `share-intake` store 暂存分享内容，登录态就绪后复用现有 `sendMessage` / `attachmentToContentBlockWithUpload` / `createSessionAsync` 管线发送。**不新增第三方库、不带新页面、不带手写原生代码。**

**Tech Stack:** Expo SDK 56 / RN 0.85 / expo-router 56 / expo-sharing 57 / zustand / jest-expo / pnpm monorepo（`kdoo-client`）

**工作目录:** `/Users/admin/sourcecode/6.ai/kdoo-client/projects/app`

---

## 前置说明（执行前必读）

- **需要原生重建**：改完 `app.config.ts` 后必须 `npx expo prebuild` 并重新做原生（dev-client）构建，接收功能才生效；热重载不生效。真机/模拟器验证必须在同一台装了 iOS ShareIntent / 有相册与浏览器的设备上。
- **复制现有拦截模式**：`utils/linking-interceptor.ts` 已为 `trackplayer://` 实现了一整套 monkey-patch + 私有 listener 通道。本计划为 `expo-sharing` hostname 复刻同一模式（命名用 ShareInto 前缀，避免与 trackplayer 混淆）。
- **现有代码参考**：
  - `utils/linking-interceptor.ts`（拦截模式模板）
  - `stores/share-intake.ts`（暂存/消费模式）
  - `app/share/[id].tsx`（消费 + `addSession` + `triggered` ref 防重入）
  - `app/_layout.tsx:213-266`（登录-resume 消费分支）
  - `services/upload-service.ts:136 attachmentToContentBlockWithUpload`
  - `stores/chat.ts sendMessage / createSessionAsync / currentSessionId`

---

### Task 1: 在 app.config.ts 启用 expo-sharing 接收配置

**Files:**
- Modify: `projects/app/app.config.ts`（`plugins` 数组）

**Step 1:** 在 `plugins` 数组末尾（`expo-media-library` 条目之后逗号追加）新增 expo-sharing 接收配置：

```ts
    [
      'expo-sharing',
      {
        ios: {
          enabled: true,
          activationRule: {
            supportsText: true,
            supportsWebUrlWithMaxCount: 1,
            supportsImageWithMaxCount: 1,
          },
        },
        android: {
          enabled: true,
          singleShareMimeTypes: ['text/*', 'image/*'],
        },
      },
    ],
```

注意保持数组元素逗号风格与现有条目一致（现有条目均以 `],` 结尾）。

**Step 2: 校验 config 无语法错误**

Run: `cd /Users/admin/sourcecode/6.ai/kdoo-client/projects/app && npx expo config --type public`
Expected: 打印含 `expo-sharing` plugin 配置的公开配置，无报错。

**Step 3:**（提示，不阻塞后续 JS 任务）需要 `npx expo prebuild` + 原生重建后接收功能才生效。可在全部 JS 任务完成后统一执行。

---

### Task 2: 扩展类型 —— IncomingShareContent

**Files:**
- Modify: `projects/app/types/index.ts`（在 `Attachment` 接口附近追加）

**Step 1:** 在 `types/index.ts` 中 `Attachment` 接口（约 258-267 行）之后追加类型：

```ts
/**
 * 系统分享进来的内容（Share-into）。
 * - text: 纯文本
 * - url: 网页链接（iOS webURL / Android text 中含 url 时归一为 url）
 * - image: 图片，value 为可访问的 URI（Android content:// 或 iOS 文件路径）
 */
export type IncomingShareContent =
  | { type: 'text'; value: string }
  | { type: 'url'; value: string }
  | { type: 'image'; value: string; mediaType: string; name?: string };
```

**Step 2: 类型检查**

Run: `cd /Users/admin/sourcecode/6.ai/kdoo-client/projects/app && npx tsc --noEmit`
Expected: 无因本类型新增引入的错误。

---

### Task 3: 扩展 share-intake store —— 暂存分享内容

**Files:**
- Modify: `projects/app/stores/share-intake.ts`

**Step 1:** 在现有 `ShareIntakeState` 接口中新增 `pendingContent` 字段与对应 action（保留现有 `pendingToken`/`setPending`/`consume` 不动）：

```ts
import { create } from 'zustand';
import type { IncomingShareContent } from '@/types';

export interface ShareIntakeState {
  /** Share token（原有，fork 用）。 */
  pendingToken: string | null;
  setPending: (token: string) => void;
  consume: () => string | null;

  /** 系统分享进来的待发送内容（未登录时暂存，登录后消费）。 */
  pendingContent: IncomingShareContent | null;
  setPendingContent: (c: IncomingShareContent) => void;
  consumeContent: () => IncomingShareContent | null;
}
```

**Step 2:** 在 store 初始值与 action 中补齐（`consumeContent` 与 `consume` 同样幂等）：

```ts
export const useShareIntakeStore = create<ShareIntakeState>((set, get) => ({
  pendingToken: null,
  setPending: (token) => set({ pendingToken: token }),
  consume: () => {
    const token = get().pendingToken;
    if (token) set({ pendingToken: null });
    return token;
  },
  pendingContent: null,
  setPendingContent: (c) => set({ pendingContent: c }),
  consumeContent: () => {
    const c = get().pendingContent;
    if (c) set({ pendingContent: null });
    return c;
  },
}));
```

**Step 3: 单测**

- Create: `projects/app/__tests__/share-intake.test.ts`

```ts
import { useShareIntakeStore } from '@/stores/share-intake';

beforeEach(() => {
  useShareIntakeStore.setState({ pendingToken: null, pendingContent: null });
});

test('consumeContent is idempotent and returns latest content', () => {
  const { setPendingContent, consumeContent } = useShareIntakeStore.getState();
  setPendingContent({ type: 'text', value: 'hello' });
  expect(consumeContent()).toEqual({ type: 'text', value: 'hello' });
  expect(consumeContent()).toBeNull();
});

test('existing token flow unaffected', () => {
  const { setPending, consume } = useShareIntakeStore.getState();
  setPending('tok');
  expect(consume()).toBe('tok');
  expect(consume()).toBeNull();
});
```

**Step 4: 运行测试验证**

Run: `cd /Users/admin/sourcecode/6.ai/kdoo-client/projects/app && npx jest __tests__/share-intake.test.ts`
Expected: PASS（2 个用例）。

**Step 5: Commit**

```bash
git add projects/app/app.config.ts projects/app/types/index.ts projects/app/stores/share-intake.ts projects/app/__tests__/share-intake.test.ts
git -C /Users/admin/sourcecode/6.ai/kdoo-client commit -m "feat(share-into): enable expo-sharing receive config + intake store types"
```
（注：Task 1-3 一起提交；若 Task 1 的 `npx expo config` 有实际改动文件路径差异再单独调整 add 列表。）

---

### Task 4: linking-interceptor 拦截 expo-sharing hostname

**Files:**
- Modify: `projects/app/utils/linking-interceptor.ts`

**Step 1:** 在文件顶部常量区新增 Scheme 常量与私有 listener 数组（紧随 trackplayer 相关声明）：

```ts
const SHAREINTO_HOSTNAME = 'expo-sharing';
const _shareIntoListeners: Array<() => void> = [];
```

**Step 2:** 在 `getInitialURL` 的 patch 中，`trackplayer` 判断之后追加 share-into 分支（命中时返回 null 阻断 expo-router 路由 404，并触发消费）：

```ts
  Linking.getInitialURL = async (): Promise<string | null> => {
    const url = await _originalGetInitialURL();
    if (!url) return null;
    if (url.startsWith(TRACKPLAYER_SCHEME)) {
      return null;
    }
    if (_isShareIntoUrl(url)) {
      _dispatchShareInto();
      return null;
    }
    return url;
  };
```

**Step 3:** 在 `addEventListener` 的 `wrappedHandler` 中，trackplayer 分支之后追加 share-into 分支：

```ts
      if (_isShareIntoUrl(event.url)) {
        _dispatchShareInto();
        return;
      }
```

**Step 4:** 在文件末尾（TrackPlayer 公开 API 之后）追加 share-into 辅助函数与公开 API：

```ts
function _isShareIntoUrl(url: string): boolean {
  try {
    return new URL(url).hostname === SHAREINTO_HOSTNAME;
  } catch {
    return false;
  }
}

function _dispatchShareInto(): void {
  const snapshot = _shareIntoListeners.slice();
  for (const fn of snapshot) fn();
}

/**
 * 订阅“系统分享进来”事件（expo-sharing 唤醒）。返回取消订阅函数。
 * 消费回调里应调用 sendIncomingShareContent（见 Task 6）。
 */
export function addShareIntoListener(fn: () => void): () => void {
  _shareIntoListeners.push(fn);
  return () => {
    const idx = _shareIntoListeners.indexOf(fn);
    if (idx >= 0) _shareIntoListeners.splice(idx, 1);
  };
}

/** 仅供单元测试：确认某 URL 是否为 share-into 唤醒。 */
export function _isShareIntoUrlForTest(url: string): boolean {
  return _isShareIntoUrl(url);
}
```

**Step 5: 单测**

- Create: `projects/app/__tests__/linking-shareinto.test.ts`

```ts
import { _isShareIntoUrlForTest } from '@/utils/linking-interceptor';

test('identifies expo-sharing hostname URLs', () => {
  expect(_isShareIntoUrlForTest('expo-sharing://hello')).toBe(true);
  expect(_isShareIntoUrlForTest('kdoomobile://share/abc')).toBe(false);
  expect(_isShareIntoUrlForTest('not-a-url')).toBe(false);
  expect(_isShareIntoUrlForTest('https://expo-sharing.com/x')).toBe(false); // 不同 hostname
});
```

**Step 6: 运行测试验证**

Run: `cd /Users/admin/sourcecode/6.ai/kdoo-client/projects/app && npx jest __tests__/linking-shareinto.test.ts`
Expected: PASS。

**Step 7: Commit**

```bash
git add projects/app/utils/linking-interceptor.ts projects/app/__tests__/linking-shareinto.test.ts
git -C /Users/admin/sourcecode/6.ai/kdoo-client commit -m "feat(share-into): intercept expo-sharing wakeup url in linking interceptor"
```

---

### Task 5: 分享内容解析模块（payload → IncomingShareContent）

**Files:**
- Create: `projects/app/utils/share-intake-content.ts`

**Step 1:** 新建解析模块：从 `expo-sharing` 读取 payload 并解析为 `IncomingShareContent`。

```ts
import * as Sharing from 'expo-sharing';
import type { IncomingShareContent } from '@/types';
import { logger } from '@/utils/logger';

/**
 * 读取并解析系统分享进来的内容。
 * 返回 null 表示无可用分享内容（或仅剩不支持的类型）。
 */
export async function resolveIncomingShareContent(): Promise<IncomingShareContent | null> {
  try {
    const resolved = await Sharing.getResolvedSharedPayloadsAsync();
    const payload = resolved[0]; // 首版只取第一条（单分享）
    if (!payload) return null;

    if (payload.contentType === 'image') {
      return {
        type: 'image',
        value: payload.contentUri ?? payload.value,
        mediaType: payload.contentMimeType ?? 'image/*',
        name: payload.originalName ?? undefined,
      };
    }

    // 文本 / URL：contentType 可能是 'text' 或 'website'
    const raw = payload.value.trim();
    if (!raw) return null;
    if (payload.contentType === 'website' || /^https?:\/\//i.test(raw)) {
      return { type: 'url', value: raw };
    }
    return { type: 'text', value: raw };
  } catch (e) {
    logger.warn('ShareInto', 'resolveIncomingShareContent failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** 消费完成后清空 expo-sharing 内的残留 payload，防止重复触发。 */
export function clearIncomingSharePayload(): void {
  try {
    Sharing.clearSharedPayloads();
  } catch (e) {
    logger.warn('ShareInto', 'clearIncomingSharePayload failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
```

**Step 2: 类型/语法检查**（`mutate` 后运行）

Run: `cd /Users/admin/sourcecode/6.ai/kdoo-client/projects/app && npx tsc --noEmit`
Expected: 无错误（若 `getResolvedSharedPayloadsAsync` / `clearSharedPayloads` 在此版本类型签名不同，按 `node_modules/expo-sharing/build/Sharing.types.d.ts` 实际导出名对齐——本计划基于 57.0.8 的 `sharePayloadsAreEqual`/`clearSharedPayloads` 等已存在导出）。

**Step 3: Commit**

```bash
git add projects/app/utils/share-intake-content.ts
git -C /Users/admin/sourcecode/6.ai/kdoo-client commit -m "feat(share-into): resolve incoming share content to typed payload"
```

---

### Task 6: 发送逻辑（当前会话 → 新建 → 暂存）

**Files:**
- Create: `projects/app/utils/share-intake-send.ts`

**Step 1:** 核心发送分发逻辑。参照 `app/share/[id].tsx` 的 `addSession` 用法与 `_layout.tsx` 登录-resume 模式。

```ts
import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { useShareIntakeStore } from '@/stores/share-intake';
import type { IncomingShareContent } from '@/types';
import { attachmentToContentBlockWithUpload } from '@/services/upload-service';
import { logger } from '@/utils/logger';
import { resolveIncomingShareContent, clearIncomingSharePayload } from '@/utils/share-intake-content';

/**
 * 分享内容 → 用户消息 → AI。
 * - 已登录+有当前会话：直接发
 * - 已登录+无会话：自动新建默认会话再发
 * - 未登录：暂存，登录后由 _layout 消费再调本函数
 */
export async function sendIncomingShareContent(): Promise<void> {
  const content = await resolveIncomingShareContent();
  if (!content) return; // 无分享内容，静默忽略

  const isAuthed = useAuthStore.getState().isAuthenticated;
  if (!isAuthed) {
    // 未登录：暂存，等登录态翻转后由根布局消费
    useShareIntakeStore.getState().setPendingContent(content);
    clearIncomingSharePayload();
    return;
  }

  await dispatchToChat(content);
  clearIncomingSharePayload();
}

async function dispatchToChat(content: IncomingShareContent): Promise<void> {
  const chat = useChatStore.getState();
  let sessionId = chat.currentSessionId;

  if (!sessionId) {
    // createSessionAsync 内部已把新会话放入 sessions[] 并把 currentSessionId 设为其 id，
    // 无需再手调 addSession（不同于 fork 场景）。参照 stores/chat.ts:397-415。
    sessionId = await chat.createSessionAsync({ agentId: 'default' });
    if (!sessionId) {
      logger.warn('ShareInto', 'createSessionAsync failed');
      return;
    }
  }

  if (content.type === 'image') {
    const block = await attachmentToContentBlockWithUpload({
      id: `share-${Date.now()}`,
      type: 'image',
      name: content.name ?? 'shared-image',
      uri: content.value,
      mediaType: content.mediaType,
    });
    chat.sendMessage(sessionId, '', [block]);
  } else {
    chat.sendMessage(sessionId, content.value);
  }
}
```

> ⚠️ **实现注意**：给 `dispatchToChat` 加一个模块级 `let sending = false` guard（进入置 true，结束置 false，重复进入直接 return），防止分享唤醒与登录态翻转并发导致重复发送。设计上对 `sendMessage` 发送前先确保 WS 就绪（`sendMessage` 内部已处理断线重连，见 `services/websocket.ts sendChat`）。

**Step 2: 类型/语法检查**

Run: `cd /Users/admin/sourcecode/6.ai/kdoo-client/projects/app && npx tsc --noEmit`
Expected: 无错误。

**Step 3: Commit**

```bash
git add projects/app/utils/share-intake-send.ts
git -C /Users/admin/sourcecode/6.ai/kdoo-client commit -m "feat(share-into): send incoming content to current or new session"
```

---

### Task 7: 接入点 —— 根布局订阅 share-into 唤醒 + 登录-resume 消费

**Files:**
- Modify: `projects/app/app/_layout.tsx`

**Step 1:** import 新增：

```ts
import { addShareIntoListener } from '@/utils/linking-interceptor';
import { sendIncomingShareContent } from '@/utils/share-intake-send';
import { consumeContent } from ... // 复用 useShareIntakeStore
```

**Step 2:** 在 `_layout.tsx` 顶层 effect 中注册 share-into 订阅（`useEffect` 里 `addShareIntoListener(() => { void sendIncomingShareContent(); })`，返回清理函数）。放在现有 `installLinkingInterceptor()` 已调用之后即可。

**Step 3:** 在现有登录-resume 消费分支（约 213-266 行，`consumeShareIntake` 附近）追加内容消费：当 `isAuthenticated` 翻转且 `useShareIntakeStore.getState().consumeContent()` 非空时，调用 `sendIncomingShareContent()`（该函数内部会再次判断登录态并 `dispatchToChat`）。

**Step 4: 语法/类型检查**

Run: `cd /Users/admin/sourcecode/6.ai/kdoo-client/projects/app && npx tsc --noEmit`
Expected: 无错误。

**Step 5: Commit**

```bash
git add projects/app/app/_layout.tsx
git -C /Users/admin/sourcecode/6.ai/kdoo-client commit -m "feat(share-into): wire share-into wakeup and login-resume dispatch in root layout"
```

---

### Task 8: 原生重建 + 真机/模拟器验证

**Files:**
- 无新增代码

**Step 1: prebuild 重新生成原生工程**

Run: `cd /Users/admin/sourcecode/6.ai/kdoo-client/projects/app && npx expo prebuild --clean`
Expected: 重新生成 ios/android 原生目录，`ios/` 下新增 share-extension target，`android/app/src/main/AndroidManifest.xml` 含 `ACTION_SEND` intent-filter。

**Step 2: 原生构建（开发构建）**

Run: `cd /Users/admin/sourcecode/6.ai/kdoo-client && pnpm ios`（或 `pnpm android`）
Expected: 设备/模拟器安装 dev-client。

**Step 3: 端到端验证清单**
- iOS 模拟器/真机：备忘录分享文本 → App 唤起，当前会话出现用户消息 + AI 回复
- iOS：Safari 分享网页 URL → 当前会话出现 URL 消息
- iOS：相册分享图片 → 当前会话出现图片消息（`type:'file'` + image mimeType 渲染）
- Android：浏览器/相册分享 → 同上
- 未登录：分享 → App 唤起 → 登录 → 分享内容自动发到当前会话
- 已登录无会话：分享 → 自动新建会话并发送

**Step 4: 记录结果并收尾**

Run: `cd /Users/admin/sourcecode/6.ai/kdoo-client && git status`
Expected: 无遗留未提交改动。

---

## 完成标准（Definition of Done）

- [ ] `app.config.ts` 含 expo-sharing 接收配置，prebuild 生成 share-extension target / SEND intent-filter
- [ ] `useShareIntakeStore` 的 pendingContent 暂存/消费可单测通过
- [ ] linking-interceptor 能识别 `expo-sharing://` 唤醒且不触发 404
- [ ] 分享内容解析（文本/URL/图片）单测通过
- [ ] 发送逻辑覆盖：当前会话 / 自动新建 / 未登录暂存 三态
- [ ] 根布局登录-resume 消费、热更订阅接入
- [ ] iOS + Android 端到端验证通过（含未登录、无会话边界）
- [ ] 全部单测 + `tsc --noEmit` 通过，无新增依赖、无新增三方库

## 明确不做（YAGNI）
- 不做分享确认/中转页面（用户明确要求静默直接发送）
- 不做多会话目标选择 UI
- 不做多文件/视频/任意文件接收（首版仅文本/URL/单图）
- 不新增第三方库、不手写原生 Share Extension
