import { useEffect, useMemo } from 'react';
import { useI18n } from '@/hooks/useI18n';
import {
  fetchTodayNews,
  markNewsClicked,
  getLastFetchDate,
  setLastFetchDate,
  getClickedIds,
  setClickedIds as persistSetClickedIds,
  getNewsTitle,
  type NewsItem,
} from '@/services/news';
import { useNewsStore } from '@/stores/news';

/** 剩余未点击新闻少于此阈值时，后台静默重新拉取 */
const REFRESH_THRESHOLD = 3;

/** YYYY-MM-DD 格式的今天日期 */
function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * App 启动 / 登录成功后调用：按需拉取今日新闻。
 *
 * - force=true：强制重新拉取 + 重置 clicked（用于登录/切账号场景，避免沿用前一用户数据）
 * - 跨日或首次（lastFetch !== today）：fetchTodayNews + 写入 store + 持久化 lastFetch + 清空 clicked
 * - 今天已拉过（lastFetch === today）：恢复 clickedIds 到内存；若 newsList 内存为空（冷启动）也重新拉一次填充
 *
 * 失败静默（不抛出，不影响 app 启动）。
 */
export async function initNewsIfNeeded(force = false): Promise<void> {
  const today = getTodayDate();
  const lastFetch = await getLastFetchDate();

  if (force || lastFetch !== today) {
    // 强制 / 跨日 / 首次拉取 → 重新拉 + 清空 clicked
    const news = await fetchTodayNews();
    if (news && news.length > 0) {
      const store = useNewsStore.getState();
      store.setNewsList(news);
      store.resetClicked();
      await persistSetClickedIds([]);
      await setLastFetchDate(today);
    }
    return;
  }

  // 今天已拉过：恢复 clicked 到内存 store
  const clickedIds = await getClickedIds();
  if (clickedIds.length > 0) {
    useNewsStore.getState().setClickedIds(clickedIds);
  }

  // 冷启动后内存 newsList 为空 → 重新拉一次填充内存
  if (useNewsStore.getState().newsList.length === 0) {
    const news = await fetchTodayNews();
    if (news && news.length > 0) {
      useNewsStore.getState().setNewsList(news);
    }
  }
}

/**
 * ChatHome 用：从 newsList 过滤 clicked 后随机取最多 2 条。
 *
 * - recommendations: NewsItem[] — 过滤 clicked + Fisher-Yates shuffle 取前 2 条
 * - handleNewsClick(item): 记录点击（store + AsyncStorage）
 * - getNewsTitleForLocale(item): 按当前 locale 取标题（空则 fallback English）
 *
 * 副作用：剩余未点击 < REFRESH_THRESHOLD 时，后台静默刷新 newsList（不阻塞 UI）。
 */
export function useNewsRecommendations() {
  const { locale } = useI18n();
  const newsList = useNewsStore((s) => s.newsList);
  const clickedIds = useNewsStore((s) => s.clickedIds);

  // 过滤 clicked + 随机取最多 2 条
  const recommendations = useMemo(() => {
    const unclicked = newsList.filter((item) => !clickedIds.includes(item.id));
    // Fisher-Yates shuffle
    const shuffled = [...unclicked];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, 2);
  }, [newsList, clickedIds]);

  // 剩余未点击 < 阈值时，后台静默刷新（不阻塞当前渲染）
  useEffect(() => {
    const remaining = newsList.length - clickedIds.length;
    if (newsList.length > 0 && remaining < REFRESH_THRESHOLD) {
      fetchTodayNews()
        .then((news) => {
          if (news && news.length > 0) {
            useNewsStore.getState().setNewsList(news);
          }
        })
        .catch(() => {
          // 静默失败，不影响 UI
        });
    }
  }, [newsList.length, clickedIds.length]);

  const handleNewsClick = (item: NewsItem): void => {
    markNewsClicked(item.id);
  };

  const getNewsTitleForLocale = (item: NewsItem): string => {
    return getNewsTitle(item, locale);
  };

  return { recommendations, handleNewsClick, getNewsTitleForLocale };
}
