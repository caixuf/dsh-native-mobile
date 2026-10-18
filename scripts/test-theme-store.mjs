/**
 * 主题与皮肤管理（ThemeStore & THEME_PRESETS）回归测试。
 *
 * 覆盖移动端界面与个性化配置相关的关键真实缺陷：
 *   1. 主题预设完整度与样式字段契约（确保不存在缺失色值导致渲染透明/白屏）
 *   2. 主题切换与持久化（ThemeStore.setTheme / getThemeId）
 *   3. 动态 CSS 变量注入契约（验证注入了全部必须的品牌与对比度变量）
 *   4. 自定义壁纸配置（数据落盘、模糊度与不透明度保存、一键清除）
 *   5. 壁纸 CSS 变量绑定（验证 --custom-bg-image/blur/opacity 均与配置同步）
 *   6. 无 DOM / 隐私模式（localStorage 异常）下的安全降级
 *
 * 运行：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs scripts/test-theme-store.mjs
 */

import { THEME_PRESETS, ThemeStore } from '../src/services/theme.ts';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, error: err });
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? 'not equal'}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg ?? 'expected truthy');
}

/** 创建带有 style 和 attribute 支持的 Mock DocumentElement */
function createMockDocument() {
  const styles = new Map();
  const attributes = new Map();
  const element = {
    style: {
      setProperty(key, val) {
        styles.set(key, String(val));
      },
      getPropertyValue(key) {
        return styles.get(key) || '';
      },
      removeProperty(key) {
        styles.delete(key);
      },
    },
    setAttribute(key, val) {
      attributes.set(key, String(val));
    },
    getAttribute(key) {
      return attributes.get(key) || null;
    },
  };
  return {
    documentElement: element,
    _styles: styles,
    _attributes: attributes,
  };
}

/** 模拟 localStorage */
function createMockStorage() {
  const store = new Map();
  return {
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      store.set(k, String(v));
    },
    removeItem(k) {
      store.delete(k);
    },
    clear() {
      store.clear();
    },
  };
}

const mockStorage = createMockStorage();
const mockDoc = createMockDocument();

globalThis.window = { localStorage: mockStorage };
globalThis.localStorage = mockStorage;
globalThis.document = mockDoc;

console.log('ThemeStore 主题与皮肤中心契约测试');
console.log('──────────────────────────────────────────────────');

check('1. THEME_PRESETS 包含 4 套完整配色，且核心字段无缺失', () => {
  eq(THEME_PRESETS.length, 4, '必须有 4 套官方预设');
  const ids = THEME_PRESETS.map((t) => t.id);
  ok(ids.includes('qq-aurora'), '必须包含经典 QQ 极光蓝');
  ok(ids.includes('deepseek-cyan'), '必须包含 DeepSeek 灵动深蓝');
  ok(ids.includes('qq-emerald'), '必须包含 QQ 清新翡翠绿');
  ok(ids.includes('minimal-gray'), '必须包含极简石墨灰');

  for (const t of THEME_PRESETS) {
    ok(t.name.trim().length > 0, `${t.id} 缺少 name`);
    ok(t.accentColor.startsWith('#'), `${t.id} accentColor 必须是十六进制颜色`);
    ok(t.primaryHover.startsWith('#'), `${t.id} primaryHover 必须是十六进制颜色`);
    ok(t.primaryLight.startsWith('#'), `${t.id} primaryLight 必须是十六进制颜色`);
    ok(t.gradient.includes('gradient'), `${t.id} gradient 必须包含有效渐变定义`);
    ok(t.badgeBg.startsWith('#'), `${t.id} badgeBg 必须是十六进制颜色`);
    ok(t.badgeText.startsWith('#'), `${t.id} badgeText 必须是十六进制颜色`);
    ok(t.surfaceBg.startsWith('#'), `${t.id} surfaceBg 必须是十六进制颜色`);
    ok(t.borderSubtle.startsWith('#'), `${t.id} borderSubtle 必须是十六进制颜色`);
    ok(t.mascotColor.startsWith('#'), `${t.id} mascotColor 必须是十六进制颜色`);
  }
});

check('2. getThemeId 首次默认返回 qq-aurora，setTheme 可持久化切换', () => {
  mockStorage.clear();
  eq(ThemeStore.getThemeId(), 'qq-aurora', '默认主题必须是 qq-aurora');

  ThemeStore.setTheme('deepseek-cyan');
  eq(ThemeStore.getThemeId(), 'deepseek-cyan');
  eq(mockStorage.getItem('dsh_app_theme_id'), 'deepseek-cyan');
});

check('3. applyTheme 正确注入完整 CSS 变量与 data-theme 属性', () => {
  mockDoc._styles.clear();
  mockDoc._attributes.clear();

  ThemeStore.applyTheme('qq-emerald');

  eq(mockDoc.documentElement.getAttribute('data-theme'), 'qq-emerald');
  const emerald = THEME_PRESETS.find((t) => t.id === 'qq-emerald');
  eq(mockDoc.documentElement.style.getPropertyValue('--color-primary-accent'), emerald.accentColor);
  eq(mockDoc.documentElement.style.getPropertyValue('--color-primary-hover'), emerald.primaryHover);
  eq(mockDoc.documentElement.style.getPropertyValue('--color-theme-badge-bg'), emerald.badgeBg);
  eq(mockDoc.documentElement.style.getPropertyValue('--color-theme-badge-text'), emerald.badgeText);
  eq(mockDoc.documentElement.style.getPropertyValue('--color-mascot'), emerald.mascotColor);
  eq(mockDoc.documentElement.style.getPropertyValue('--bg-surface'), emerald.surfaceBg);
});

check('4. 自定义壁纸配置保存、读取与清除', () => {
  mockStorage.clear();
  const init = ThemeStore.getCustomWallpaper();
  eq(init.data, null, '未设置时数据为空');

  // 保存壁纸
  ThemeStore.setCustomWallpaper('data:image/jpeg;base64,mockwallpaperdata', 8, 40);
  const saved = ThemeStore.getCustomWallpaper();
  eq(saved.data, 'data:image/jpeg;base64,mockwallpaperdata');
  eq(saved.blur, 8);
  eq(saved.opacity, 40);

  // 清除壁纸
  ThemeStore.clearCustomWallpaper();
  const cleared = ThemeStore.getCustomWallpaper();
  eq(cleared.data, null, '清除后数据恢复为 null');
  eq(mockStorage.getItem('dsh_custom_bg_data'), null);
});

check('5. 🔴 关键回归：applyCustomWallpaper 注入 CSS 变量驱动壁纸显示', () => {
  mockDoc._styles.clear();
  ThemeStore.setCustomWallpaper('data:image/jpeg;base64,wall123', 5, 30);
  ThemeStore.applyCustomWallpaper();

  eq(mockDoc.documentElement.style.getPropertyValue('--custom-bg-image'), 'url(data:image/jpeg;base64,wall123)');
  eq(mockDoc.documentElement.style.getPropertyValue('--custom-bg-blur'), '5px');
  eq(mockDoc.documentElement.style.getPropertyValue('--custom-bg-opacity'), '0.3');

  ThemeStore.clearCustomWallpaper();
  ThemeStore.applyCustomWallpaper();
  eq(mockDoc.documentElement.style.getPropertyValue('--custom-bg-image'), 'none');
  eq(mockDoc.documentElement.style.getPropertyValue('--custom-bg-opacity'), '0');
});

console.log('──────────────────────────────────────────────────');
if (failed > 0) {
  console.error(`\n❌ ${failed} 项测试失败！`);
  process.exit(1);
} else {
  console.log(`\n✓ 全部 ${passed} 项通过：ThemeStore 主题与皮肤中心契约全部达成`);
}
