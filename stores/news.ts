import { create } from 'zustand';
import type { NewsItem } from '@/services/news';

interface NewsState {
  newsList: NewsItem[];
  clickedIds: string[];
  setNewsList: (items: NewsItem[]) => void;
  setClickedIds: (ids: string[]) => void;
  addClicked: (id: string) => void;
  resetClicked: () => void;
}

export const useNewsStore = create<NewsState>((set) => ({
  newsList: [],
  clickedIds: [],
  setNewsList: (items) => set({ newsList: items }),
  setClickedIds: (ids) => set({ clickedIds: ids }),
  addClicked: (id) =>
    set((s) => ({
      clickedIds: s.clickedIds.includes(id) ? s.clickedIds : [...s.clickedIds, id],
    })),
  resetClicked: () => set({ clickedIds: [] }),
}));
