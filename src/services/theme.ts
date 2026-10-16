/**
 * 主题与皮肤管理中心 (Theme & Skin Center)
 *
 * 仿照现代 QQ 及 DeepSeek 品牌质感，提供现代多套精致配色与一键换肤体验。
 */

export interface ThemeConfig {
  id: string;
  name: string;
  description: string;
  accentColor: string;
  gradient: string;
  previewColor: string;
  badgeBg: string;
  badgeText: string;
  dark?: boolean;
}

export const THEME_PRESETS: ThemeConfig[] = [
  {
    id: 'qq-aurora',
    name: '经典 QQ 极光蓝',
    description: '现代 QQ 标志性灵动极光天蓝，活力轻快、清晰通透',
    accentColor: '#0C7FF2',
    gradient: 'linear-gradient(135deg, #12B7F5 0%, #0C7FF2 100%)',
    previewColor: '#0C7FF2',
    badgeBg: '#E8F4FD',
    badgeText: '#0C7FF2',
  },
  {
    id: 'deepseek-cyan',
    name: 'DeepSeek 灵动深蓝',
    description: 'DeepSeek 官方 AI 智能科技蓝，深邃沉稳、灵动高光',
    accentColor: '#4D6BFE',
    gradient: 'linear-gradient(135deg, #38BDF8 0%, #4D6BFE 60%, #1D4ED8 100%)',
    previewColor: '#4D6BFE',
    badgeBg: '#EEF2FF',
    badgeText: '#4D6BFE',
  },
  {
    id: 'qq-emerald',
    name: 'QQ 清新翡翠绿',
    description: '清新温润的竹青嫩绿，宁静护眼、柔和舒适',
    accentColor: '#10B981',
    gradient: 'linear-gradient(135deg, #34D399 0%, #059669 100%)',
    previewColor: '#10B981',
    badgeBg: '#ECFDF5',
    badgeText: '#047857',
  },
  {
    id: 'minimal-gray',
    name: '极简石墨灰',
    description: '纯粹克制的纯白与深石墨灰，纯净专注、无扰生产力',
    accentColor: '#18181B',
    gradient: 'linear-gradient(135deg, #27272A 0%, #18181B 100%)',
    previewColor: '#18181B',
    badgeBg: '#F4F4F6',
    badgeText: '#18181B',
  },
];

const THEME_STORAGE_KEY = 'dsh_app_theme_id';

export class ThemeStore {
  public static getThemeId(): string {
    if (typeof window === 'undefined' || !window.localStorage) return 'qq-aurora';
    return localStorage.getItem(THEME_STORAGE_KEY) || 'qq-aurora';
  }

  public static setTheme(id: string) {
    if (typeof window === 'undefined' || !window.localStorage) return;
    localStorage.setItem(THEME_STORAGE_KEY, id);
    this.applyTheme(id);
  }

  public static applyTheme(id: string = this.getThemeId()) {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-theme', id);

    const theme = THEME_PRESETS.find((t) => t.id === id) || THEME_PRESETS[0];

    // 动态注入主题颜色变量
    root.style.setProperty('--color-primary-accent', theme.accentColor);
    root.style.setProperty('--gradient-primary', theme.gradient);
    root.style.setProperty('--color-theme-badge-bg', theme.badgeBg);
    root.style.setProperty('--color-theme-badge-text', theme.badgeText);

    if (id === 'qq-aurora') {
      root.style.setProperty('--color-primary-blue', '#0C7FF2');
      root.style.setProperty('--bg-surface', '#f5f7fa');
      root.style.setProperty('--color-border-subtle', '#e5e9f0');
    } else if (id === 'deepseek-cyan') {
      root.style.setProperty('--color-primary-blue', '#4D6BFE');
      root.style.setProperty('--bg-surface', '#f8faff');
      root.style.setProperty('--color-border-subtle', '#e0e7ff');
    } else if (id === 'qq-emerald') {
      root.style.setProperty('--color-primary-blue', '#10B981');
      root.style.setProperty('--bg-surface', '#f6fbf9');
      root.style.setProperty('--color-border-subtle', '#d1fae5');
    } else {
      root.style.setProperty('--color-primary-blue', '#2563eb');
      root.style.setProperty('--bg-surface', '#f4f4f6');
      root.style.setProperty('--color-border-subtle', '#e4e4e7');
    }
  }
}
