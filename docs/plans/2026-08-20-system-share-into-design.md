# 系统分享到 App（Share-into）设计

日期：2026-08-20
状态：已批准（待实现）

## 1. 需求

用户从系统其他 App（Safari、相册、文件、微信等）通过系统分享面板，将 **文本 / URL / 图片** 分享到本 App（Elioo / kdoo-mobile）。App 被唤起后，将分享内容**直接作为一条用户消息发送到当前 AI 对话会话**，无需中转页面。

### 明确的行为边界（已与需求方确认）
- **已登录 + 存在当前会话** → 直接发送到当前会话
- **已登录 + 无当前会话** → 自动新建默认会话，再发送
- **未登录** → 暂存，登录成功后再发送到当前会话（复用现有 share-intake 暂存模式）
- **不需要新页面** —— 收到分享直接消费，静默完成发送

## 2. 核心结论

项目已安装 **`expo-sharing@57.0.8`**（`projects/app/package.json`），该版本在官方层面原生支持"接收分享"（iOS Share Extension 目标 + Android `ACTION_SEND` intent-filter + `useIncomingShare()` / `getSharedPayloads()` / `getResolvedSharedPayloadsAsync()` API + config plugin）。

- 现有 `patches/expo-sharing@57.0.8.patch` 只影响**分享出去**方向（Android `content://` URI 的 FileProvider 处理），**不影响**接收功能。
- **无需新增任何第三方库、无需手写原生模块。**
- 所有 AI 消息发送均复用项目已验证的现有管线（`sendMessage` / `attachmentToContentBlockWithUpload` / `createSessionAsync`）。

## 3. 架构

```
其他App 分享(文本/URL/图片)
        │
        ▼
iOS ShareExtension / Android ACTION_SEND intent   ← 原生层（expo-sharing config plugin）
        │  唤起 app，带 expo-sharing 深度链接 (hostname='expo-sharing')
        ▼
utils/linking-interceptor.ts 拦截 + pending-navigation 注入
        │
        ▼
share-intake store 扩展（暂存 content payload，登录后消费）
        │
        ▼
消费回调：发送到当前会话 / 新建默认会话 / 暂存待登录
        │
        ▼
sendMessage(sessionId, text)  ── 文本/URL
sendMessage(sessionId, '', attachmentToContentBlockWithUpload(...))  ── 图片
```

## 4. 分节设计

### 4.1 原生配置（`app.config.ts`）

给 plugins 数组追加 `expo-sharing` 接收配置（幂等，与现有 config-plugin 风格一致）：

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

- 该 plugin 生成 iOS share-extension target（`ShareIntoViewController.swift`）与 Android `ACTION_SEND` intent-filter。
- 需要 `npx expo prebuild` 后重新做**原生构建**（dev-client 重建）才生效；热重载不生效。
- iOS main-target 从 share-extension 唤醒依赖 Apple 非官方 hack（Expo 标记为 experimental），与其它同类库一致，不影响上架。

### 4.2 深度链接拦截（`utils/linking-interceptor.ts` + lint pending-navigation）

expo-sharing 接收功能通过 app scheme 唤起并携带 hostname=`expo-sharing` 的 deep link。在现有 `installLinkingInterceptor()` 拦截逻辑中增加分支：命中 `expo-sharing` hostname 时，不当作导航，而是触发分享消费逻辑（通过同步 store / 事件）。

- 若使用 Expo Router 的 `+native-intent.ts`（SDK 56 需验证），可作为替代/补充；首版优先走现有 linking-interceptor，最小改动。

### 4.3 分享 payload 消费（store 扩展）

扩展/复用 `stores/share-intake.ts`，从"仅 token"扩展为"content payload"暂存：

```ts
export type IncomingShareContent =
  | { type: 'text'; value: string }
  | { type: 'url'; value: string }
  | { type: 'image'; value: string; mediaType: string; name?: string };
```

- 从 `getSharedPayloads()` 读取原始 payload（`SharePayload[]`：`{ value, shareType, mimeType }`）。
- 文本/URL：`shareType==='text'` 时 `value` 即文本；URL 可从 `shareType==='url'` 或从文本中提取（如需）。
- 图片：`shareType==='image'`，`value` 为 `content://`（Android）或 app-group 文件 URI（iOS）；用 `getResolvedSharedPayloadsAsync()` 解析得到 `contentUri`。
- 消费后 `clearSharedPayloads()` 清空，防空转（复制 `app/share/[id].tsx` 的 `triggered` ref 防重入模式）。

### 4.4 AI 消息注入（复用现有管线）

消费回调按状态分发：

1. **已登录 + `currentSessionId` 存在** → 直接发：
   - 文本/URL：`useChatStore.getState().sendMessage(currentSessionId, text)`
   - 图片：构造 `Attachment{ id, type:'image', name, uri: contentUri, mediaType }` → `attachmentToContentBlockWithUpload(attachment)` → `sendMessage(currentSessionId, '', [block])`
2. **已登录 + 无当前会话** → `createSessionAsync({ agentId: <默认agent> })` → `addSession(session)` → 再走第 1 步（参照 `app/share/[id].tsx` 的 `addSession` 用法，避免 Gate cleanup 把新会话置空）。
3. **未登录** → `setPendingShareContent(content)` 暂存；根布局在 `isAuthenticated` 翻转后消费（复用现有效率，参照 4.3 节的登录-resume 逻辑），随后按 1/2 分发。

### 4.5 错误处理

- payload 解析失败、发送失败 → 静默 toast（复用 `useToastStore`），不打断用户。
- 空 payload / 非支持类型 → 直接忽略。
- 防重入：消费回调用同步 guard，避免 share 唤醒与登录态翻转同时触发两次发送。

### 4.6 测试

- **单元测试**：payload 解析（text/url/image）、store 暂存/消费/幂等、`Attachment → WsContentBlock` 转换。
- **真机/模拟器（iOS + Android）**：从相册分享图片、从 Safari 分享 URL、从备忘录分享文本 → 验证当前会话出现对应用户消息并收到 AI 回复。
- **登录态**：未登录分享 → 登录 → 自动发送；已登录无会话分享 → 自动新建会话并发送。

## 5. 变更清单（实现范围）

| 文件 | 变更 |
|------|------|
| `app.config.ts` | plugins 追加 `expo-sharing` 接收配置 |
| `stores/share-intake.ts` | 扩展：新增 `IncomingShareContent` + pending content 暂存/消费 |
| `utils/linking-interceptor.ts` | 拦截 `expo-sharing` hostname，触发消费 |
| `app/_layout.tsx` | 登录-resume 分支：消费 pending content 后发送（可选，视 store 集成方式） |
| `services/` 或新 `utils/share-intake-send.ts` | 消费分发逻辑（登录/无会话/新建默认会话） |
| `types/index.ts` | （如需）`IncomingShareContent` 类型 |
| 测试文件 | 对应单测 |

## 6. 明确不做（YAGNI）

- 不做分享确认/中转 UI（用户明确要求静默直接发送）。
- 不做多会话目标选择。
- 不做多文件/视频/文件接收（首版仅文本/URL/单图）。
- 不新增第三方库、不手写原生 Share Extension。
