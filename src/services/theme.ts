/**
 * 主题与皮肤管理中心 (Theme & Skin Center)
 *
 * 仿照现代 QQ 及 DeepSeek 品牌质感，提供现代多套精致配色与一键换肤体验。
 * 兼备本地自定义壁纸上传、Canvas 自动压缩与轻量化落盘。
 */

export interface ThemeConfig {
  id: string;
  name: string;
  description: string;
  accentColor: string;
  primaryHover: string;
  primaryLight: string;
  gradient: string;
  previewColor: string;
  badgeBg: string;
  badgeText: string;
  /** 承载白字的深变体（白字对比度 ≥4.5:1）；accent 太浅时用它。 */
  primaryDeep?: string;
  surfaceBg: string;
  borderSubtle: string;
  mascotColor: string;
}

export const THEME_PRESETS: ThemeConfig[] = [
  {
    id: 'qq-aurora',
    name: '经典 QQ 极光蓝',
    description: '现代 QQ 标志性灵动极光天蓝，活力轻快、清晰通透',
    accentColor: '#0C7FF2',
    primaryHover: '#0066FF',
    primaryLight: '#E8F4FD',
    gradient: 'linear-gradient(135deg, #12B7F5 0%, #0C7FF2 100%)',
    previewColor: '#0C7FF2',
    badgeBg: '#E8F4FD',
    badgeText: '#0C7FF2',
    primaryDeep: '#0A6BC4',
    surfaceBg: '#F5F7FA',
    borderSubtle: '#E5E9F0',
    mascotColor: '#0C7FF2',
  },
  {
    id: 'deepseek-cyan',
    name: 'DeepSeek 灵动深蓝',
    description: 'DeepSeek 官方 AI 智能科技蓝，深邃沉稳、灵动高光',
    accentColor: '#4D6BFE',
    primaryHover: '#3851E0',
    primaryLight: '#EEF2FF',
    gradient: 'linear-gradient(135deg, #38BDF8 0%, #4D6BFE 60%, #1D4ED8 100%)',
    previewColor: '#4D6BFE',
    badgeBg: '#EEF2FF',
    badgeText: '#4D6BFE',
    primaryDeep: '#3B54D9',
    surfaceBg: '#F8FAFF',
    borderSubtle: '#E0E7FF',
    mascotColor: '#4D6BFE',
  },
  {
    id: 'qq-emerald',
    name: 'QQ 清新翡翠绿',
    description: '清新温润的竹青嫩绿，宁静护眼、柔和舒适',
    accentColor: '#10B981',
    primaryHover: '#059669',
    primaryLight: '#ECFDF5',
    gradient: 'linear-gradient(135deg, #34D399 0%, #059669 100%)',
    previewColor: '#10B981',
    badgeBg: '#ECFDF5',
    badgeText: '#047857',
    primaryDeep: '#047857',
    surfaceBg: '#F6FBF9',
    borderSubtle: '#D1FAE5',
    mascotColor: '#10B981',
  },
  {
    id: 'minimal-gray',
    name: '极简石墨灰',
    description: '纯粹克制的纯白与深石墨灰，纯净专注、无扰生产力',
    accentColor: '#18181B',
    primaryHover: '#09090B',
    primaryLight: '#F4F4F6',
    gradient: 'linear-gradient(135deg, #27272A 0%, #18181B 100%)',
    previewColor: '#18181B',
    badgeBg: '#F4F4F6',
    badgeText: '#18181B',
    primaryDeep: '#18181B',
    surfaceBg: '#F4F4F6',
    borderSubtle: '#E4E4E7',
    mascotColor: '#3F3F46',
  },
];

const THEME_STORAGE_KEY = 'dsh_app_theme_id';
const WALLPAPER_DATA_KEY = 'dsh_custom_bg_data';
const WALLPAPER_BLUR_KEY = 'dsh_custom_bg_blur';
const WALLPAPER_OPACITY_KEY = 'dsh_custom_bg_opacity';

export interface CustomWallpaperConfig {
  data: string | null;
  blur: number; // 0 - 20 px
  opacity: number; // 0 - 80 %
}

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

  public static getCustomWallpaper(): CustomWallpaperConfig {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { data: null, blur: 0, opacity: 15 };
    }
    const data = localStorage.getItem(WALLPAPER_DATA_KEY);
    const blur = Number(localStorage.getItem(WALLPAPER_BLUR_KEY) || '0');
    const opacity = Number(localStorage.getItem(WALLPAPER_OPACITY_KEY) || '25');
    return { data, blur, opacity };
  }

  public static setCustomWallpaper(data: string | null, blur = 0, opacity = 25) {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (data) {
      localStorage.setItem(WALLPAPER_DATA_KEY, data);
    } else {
      localStorage.removeItem(WALLPAPER_DATA_KEY);
    }
    localStorage.setItem(WALLPAPER_BLUR_KEY, String(blur));
    localStorage.setItem(WALLPAPER_OPACITY_KEY, String(opacity));
    this.applyCustomWallpaper();
  }

  public static clearCustomWallpaper() {
    this.setCustomWallpaper(null, 0, 25);
  }

  /**
   * 将用户选择的图片进行高保真 Canvas 等比压缩，控制体积在 300KB 内，
   * 严格避免 localStorage 5MB 限制被撑爆。
   */
  public static async compressImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const maxDim = 1080;
          let w = img.width;
          let h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) {
              h = Math.round((h * maxDim) / w);
              w = maxDim;
            } else {
              w = Math.round((w * maxDim) / h);
              h = maxDim;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Canvas context not available'));
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          // 压缩为 JPEG，品质 0.82
          const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
          resolve(dataUrl);
        };
        img.onerror = () => reject(new Error('图片加载解析失败'));
        img.src = String(e.target?.result || '');
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }

  public static applyCustomWallpaper() {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const { data, blur, opacity } = this.getCustomWallpaper();

    if (data) {
      root.style.setProperty('--custom-bg-image', `url(${data})`);
      root.style.setProperty('--custom-bg-blur', `${blur}px`);
      root.style.setProperty('--custom-bg-opacity', `${opacity / 100}`);
    } else {
      root.style.setProperty('--custom-bg-image', 'none');
      root.style.setProperty('--custom-bg-blur', '0px');
      root.style.setProperty('--custom-bg-opacity', '0');
    }
  }

  public static applyTheme(id: string = this.getThemeId()) {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-theme', id);

    const theme = THEME_PRESETS.find((t) => t.id === id) || THEME_PRESETS[0];

    // 动态注入主题颜色变量
    root.style.setProperty('--color-primary-accent', theme.accentColor);
    root.style.setProperty('--color-primary-hover', theme.primaryHover);
    root.style.setProperty('--color-primary-light', theme.primaryLight);
    root.style.setProperty('--gradient-primary', theme.gradient);
    root.style.setProperty('--color-theme-badge-bg', theme.badgeBg);
    root.style.setProperty('--color-theme-badge-text', theme.badgeText);
    root.style.setProperty('--color-primary-deep', theme.primaryDeep || theme.accentColor);
    root.style.setProperty('--color-primary-blue', theme.accentColor);
    root.style.setProperty('--bg-surface', theme.surfaceBg);
    root.style.setProperty('--color-border-subtle', theme.borderSubtle);
    root.style.setProperty('--color-mascot', theme.mascotColor);

    // 同步应用壁纸
    this.applyCustomWallpaper();
  }
}
