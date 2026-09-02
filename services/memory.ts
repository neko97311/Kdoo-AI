import { api } from './api';
import type { MemoryData } from '@/types';

const BASE_PATH = '/api/user/v1';

/**
 * Fetch the current user's memory data (working memory / template / observations).
 * GET /api/user/v1/memory
 * @returns MemoryData
 */
export async function getMemory(): Promise<MemoryData> {
  return api.get<MemoryData>(`${BASE_PATH}/memory`);
}

/**
 * Overwrite the working memory content (full replacement, not append).
 * PUT /api/user/v1/memory
 * @param workingMemory - The complete working memory text, must be non-empty
 */
export async function updateMemory(workingMemory: string): Promise<null> {
  return api.put<null>(`${BASE_PATH}/memory`, { workingMemory });
}

/**
 * Reset the working memory (clears it to an empty string). Observations are unaffected.
 * POST /api/user/v1/memory/reset
 */
export async function resetMemory(): Promise<null> {
  return api.post<null>(`${BASE_PATH}/memory/reset`);
}
