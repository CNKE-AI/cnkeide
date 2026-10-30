import { create } from 'zustand';
import type { StatsDashboard, StatsQuery, StatsRange, StatsSessionPage, StatsSortBy } from '../global';

/**
 * 统计看板状态。
 *
 * 数据全部由主进程的统计模型算好后下发（stats:dashboard / stats:sessions），
 * 这里只保存「筛选条件 + 结果」，切换范围/工作区/排序都重新拉一次，
 * 保证图表与历史记录列表始终来自同一次聚合结果，不会各算各的。
 */
interface StatsState {
  range: StatsRange;
  workspaceId: string;
  keyword: string;
  sortBy: StatsSortBy;
  page: number;
  pageSize: number;

  dashboard: StatsDashboard | null;
  pageData: StatsSessionPage | null;

  loading: boolean;
  error: string;
  /** 上次成功刷新的时间戳，工具栏用于显示"数据截至" */
  refreshedAt: number;

  setRange: (range: StatsRange) => void;
  setWorkspace: (id: string) => void;
  setKeyword: (kw: string) => void;
  setSortBy: (sortBy: StatsSortBy) => void;
  setPage: (page: number) => void;
  refresh: () => Promise<void>;
}

export const useStatsStore = create<StatsState>((set, get) => ({
  range: '30d',
  workspaceId: 'all',
  keyword: '',
  sortBy: 'updatedAt',
  page: 1,
  pageSize: 10,

  dashboard: null,
  pageData: null,

  loading: false,
  error: '',
  refreshedAt: 0,

  setRange: (range) => {
    set({ range, page: 1 });
    void get().refresh();
  },
  setWorkspace: (workspaceId) => {
    set({ workspaceId, page: 1 });
    void get().refresh();
  },
  setKeyword: (keyword) => {
    set({ keyword, page: 1 });
    void get().refresh();
  },
  setSortBy: (sortBy) => {
    set({ sortBy, page: 1 });
    void get().refresh();
  },
  setPage: (page) => {
    set({ page });
    void get().refresh();
  },

  refresh: async () => {
    const { range, workspaceId, keyword, sortBy, page, pageSize } = get();
    const filter: StatsQuery = { range, workspaceId, keyword, sortBy };
    set({ loading: true, error: '' });
    try {
      const [dash, list] = await Promise.all([
        window.cnke.stats.dashboard(filter),
        window.cnke.stats.sessions({ ...filter, page, pageSize }),
      ]);
      if (!dash.success || !dash.data) throw new Error(dash.error || '统计模型未返回数据');
      if (!list.success || !list.data) throw new Error(list.error || '历史记录读取失败');
      set({
        dashboard: dash.data,
        pageData: list.data,
        loading: false,
        refreshedAt: Date.now(),
        // 后端分页可能收敛页码（如删到只剩 1 页），这里跟随真实页码
        page: list.data.page,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));
