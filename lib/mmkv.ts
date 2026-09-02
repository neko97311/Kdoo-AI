import { Platform } from 'react-native';

// Web fallback: MMKV 无 web 原生实现，用 localStorage（同步 API，符合 persist 要求）
// Native: 使用 react-native-mmkv，ID 标识 chat 数据分区
// 内存兜底: dev build 未包含 MMKV 原生代码时降级为内存存储（不持久化，但不崩溃）
const CHAT_MMKV_ID = 'kdoo-chat-storage';

interface SyncKV {
  getString: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
  delete: (key: string) => void;
  clearAll: () => void;
  getAllKeys: () => string[];
}

/** 内存兜底实现 — dev build 缺 MMKV 原生模块时使用 */
function createMemoryStorage(): SyncKV {
  const map = new Map<string, string>();
  return {
    getString: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
    clearAll: () => map.clear(),
    getAllKeys: () => Array.from(map.keys()),
  };
}

let storage: SyncKV;

if (Platform.OS === 'web') {
  storage = {
    getString: (k) => localStorage.getItem(k) ?? undefined,
    set: (k, v) => localStorage.setItem(k, v),
    delete: (k) => localStorage.removeItem(k),
    clearAll: () => localStorage.clear(),
    getAllKeys: () => Object.keys(localStorage),
  };
} else {
  try {
    // v4.x API: createMMKV 替代了 v3 的 new MMKV()
    // 动态 require 避免在 web 平台加载原生模块
    const { createMMKV } = require('react-native-mmkv');
    if (typeof createMMKV !== 'function') {
      throw new Error('createMMKV unavailable — native module not linked');
    }
    const instance = createMMKV({ id: CHAT_MMKV_ID });
    // 诊断日志：确认 MMKV 原生实例创建成功（非内存兜底）
    console.log(`[mmkv] ✅ Native MMKV instance created: id="${CHAT_MMKV_ID}", keys=${instance.getAllKeys().length}`);
    storage = {
      getString: (k) => instance.getString(k),
      set: (k, v) => instance.set(k, v),
      // v4.x: delete() 改名为 remove()
      delete: (k) => void instance.remove(k),
      clearAll: () => instance.clearAll(),
      getAllKeys: () => instance.getAllKeys(),
    };
  } catch (e) {
    // dev build 未重新编译（prebuild）时，原生模块不存在
    // 降级为内存存储：本次会话内功能正常，重启丢失（可接受优于崩溃）
    console.warn(
      '[mmkv] Native MMKV unavailable, falling back to in-memory storage. ' +
        'Run `pnpm android:clean && pnpm android` to rebuild with MMKV native code.',
      e,
    );
    storage = createMemoryStorage();
  }
}

export const mmkv = storage;
