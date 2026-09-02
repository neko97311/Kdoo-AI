import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';
import { useNewsStore } from '@/stores/news';

const BASE_PATH = '/api/user/v1';
const NEWS_LAST_FETCH_KEY = 'news_last_fetch_date';
const NEWS_CLICKED_IDS_KEY = 'news_clicked_ids';

export interface NewsItem {
  id: string;
  titleEn: string;
  titleZh: string;
  titlePt: string;
}

/** 拉取今日新闻 — api.get 自动解构 {code,data} 包装，返回 data 数组，失败返回 null */
export async function fetchTodayNews(): Promise<NewsItem[] | null> {
  return api.get<NewsItem[]>(`${BASE_PATH}/news/today`);
}

/** 上报新闻点击事件给后端（用于数据统计），body 空，失败静默 */
export async function reportNewsClick(newsId: string): Promise<void> {
  try {
    await api.post(`${BASE_PATH}/news/articles/${newsId}/usage`, {});
  } catch (e) {
    // 静默失败，不影响用户体验
  }
}

/**
 * 按 locale 选新闻标题，空则 fallback English
 * locale: 'zh' -> titleZh, 'pt' -> titlePt, 其他 -> titleEn
 */
export function getNewsTitle(item: NewsItem, locale: string): string {
  let title: string;
  if (locale === 'zh') title = item.titleZh;
  else if (locale === 'pt') title = item.titlePt;
  else title = item.titleEn;
  if (!title || !title.trim()) title = item.titleEn;
  return title;
}

// ──────────────────── Persistence helpers ────────────────────

export async function getLastFetchDate(): Promise<string | null> {
  return AsyncStorage.getItem(NEWS_LAST_FETCH_KEY);
}

export async function setLastFetchDate(date: string): Promise<void> {
  await AsyncStorage.setItem(NEWS_LAST_FETCH_KEY, date);
}

export async function getClickedIds(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(NEWS_CLICKED_IDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function setClickedIds(ids: string[]): Promise<void> {
  await AsyncStorage.setItem(NEWS_CLICKED_IDS_KEY, JSON.stringify(ids));
}

export async function addClickedId(id: string): Promise<void> {
  const ids = await getClickedIds();
  if (!ids.includes(id)) {
    ids.push(id);
    await setClickedIds(ids);
  }
}

/**
 * 公共函数：把 newsId 标记为已点击（fire-and-forget，全部不等待）。
 *
 * 给两处入口复用：
 * 1. ChatHome 新闻卡点击（useNewsRecommendations.handleNewsClick）
 * 2. 推送 new_chat 通知点击（executeNavigationAction）
 *
 * 三件事：
 * - 内存 store.addClicked（同步）
 * - AsyncStorage 持久化（不等待）
 * - 后台上报 POST /news/articles/:id/usage（不等待，失败静默）
 */
export function markNewsClicked(newsId: string): void {
  useNewsStore.getState().addClicked(newsId);
  void addClickedId(newsId);
  void reportNewsClick(newsId);
}
