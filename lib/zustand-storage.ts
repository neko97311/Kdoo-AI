import type { StateStorage } from 'zustand/middleware';
import { mmkv } from './mmkv';

/**
 * Zustand persist StateStorage adapter backed by MMKV.
 * MMKV is synchronous, so persist reads happen in the same JS tick —
 * this is what makes rehydrate instant on cold start.
 */
export const zustandMmkvStorage: StateStorage = {
  getItem: (name) => mmkv.getString(name) ?? null,
  setItem: (name, value) => mmkv.set(name, value),
  removeItem: (name) => mmkv.delete(name),
};
