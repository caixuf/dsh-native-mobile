/**
 * OTA 自更新（前端侧）。
 *
 * ## 为什么需要它
 *
 * 用户原话：「要 app 支持 ota 升级，不然每次我插线你安装太麻烦了吧」。
 * 之前每次发版都得：找数据线 → 插电脑 → 开发机 `adb install -r`。
 * 现在变成：App 内点「检查更新」→ 下载 → 拉起系统安装器。
 *
 * ## 数据来源
 *
 * GitHub Releases API（`/repos/caixuf/dsh-native-mobile/releases/latest`）。
 * 仓库是 public，不需要令牌；但有 60 次/小时的匿名限流，
 * 所以**检查结果要缓存**，不要每次打开关于页都打一发。
 *
 * ## 与前端的边界（每条都对应一个真实的静默失败）
 *
 * 1. **不在原生壳里时（浏览器/桌面版）没有 OTA**
 *    `window.DSHNative?.otaDownload` 不存在 → 只能给出下载链接让用户手动装，
 *    不能假装"已是最新"（旧版的检查按钮就是个假的 setTimeout）。
 *
 * 2. **必须比 versionCode，不能比 versionName 字符串**
 *    `1.10.0` 按字符串比会小于 `1.9.0`。原生 `appVersion()` 直接给 versionCode。
 *
 * 3. **下载完成不等于能装**
 *    Android 8+ 需要「安装未知应用」授权。未授权时系统静默吞掉安装页，
 *    所以 `otaInstall()` 返回 `needPermission=true` 时必须引导去授权页。
 *
 * 4. **APK 资产名随版本变**
 *    Release 里的资产名是 `dsh-mobile-v<version>.apk`，
 *    不能写死，要按 `browser_download_url` 里 `endsWith('.apk')` 挑。
 */

import { APP_VERSION } from '../version';

const REPO = 'caixuf/dsh-native-mobile';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_CACHE_KEY = 'dsh.ota.lastCheck.v1';
const CHECK_CACHE_MS = 10 * 60 * 1000; // 10 分钟内不重复打 API（匿名限流 60/h）

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
  /** GitHub 的资产摘要形如 `sha256:abcd…`；没有则为 null。 */
  sha256: string | null;
}

export interface UpdateInfo {
  /** 最新版本的语义化版本号（去掉前导 v）。 */
  latestVersion: string;
  /** 最新 versionCode（从 tag 或资产名推导不出来 → 由原生侧比对，这里只给版本名）。 */
  notes: string;
  publishedAt: string;
  htmlUrl: string;
  apk: ReleaseAsset | null;
}

export interface OtaProgress {
  ok: boolean;
  phase?: 'accepted' | 'downloading' | 'done' | 'error';
  bytes?: number;
  total?: number;
  percent?: number;
  message?: string;
  path?: string;
}

interface NativeOta {
  appVersion?: () => string;
  otaDownload?: (url: string, sha256: string | null) => string;
  otaInstall?: () => string;
  otaCanInstall?: () => boolean;
  otaOpenInstallSettings?: () => string;
  otaPendingApk?: () => string;
  otaClear?: () => string;
}

function nativeOta(): NativeOta | null {
  if (typeof window === 'undefined') return null;
  const n = (window as unknown as { DSHNative?: NativeOta }).DSHNative;
  return n && typeof n.otaDownload === 'function' ? n : null;
}

/** 当前壳是否支持 OTA（浏览器里为 false）。 */
export function otaSupported(): boolean {
  return nativeOta() !== null;
}

/** 当前安装的 versionName / versionCode。浏览器里返回构建期常量。 */
export function currentAppVersion(): { versionName: string | null; versionCode: number | null; canInstall: boolean } {
  const n = nativeOta();
  if (n?.appVersion) {
    try {
      const parsed = JSON.parse(n.appVersion()) as {
        ok?: boolean;
        versionName?: string;
        versionCode?: number;
        canInstall?: boolean;
      };
      if (parsed?.ok) {
        return {
          versionName: parsed.versionName ?? null,
          versionCode: typeof parsed.versionCode === 'number' ? parsed.versionCode : null,
          canInstall: parsed.canInstall !== false,
        };
      }
    } catch {
      /* 落到下面的兜底 */
    }
  }
  return { versionName: null, versionCode: null, canInstall: true };
}

/** 语义化版本比较：`1.10.0` > `1.9.0`（按数字段比，不能按字符串比）。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function pickApkAsset(assets: Array<Record<string, unknown>>): ReleaseAsset | null {
  for (const raw of assets) {
    const name = String(raw?.name ?? '');
    if (!name.endsWith('.apk')) continue;
    const digest = typeof raw?.digest === 'string' ? raw.digest : null;
    return {
      name,
      size: typeof raw?.size === 'number' ? raw.size : 0,
      url: String(raw?.browser_download_url ?? ''),
      // digest 形如 "sha256:abc…"
      sha256: digest && digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : null,
    };
  }
  return null;
}

/**
 * 查最新 Release 并判断是否需要更新。
 *
 * @param force 忽略 10 分钟缓存（用户手动点「检查更新」时传 true）
 */
export async function checkForUpdate(force = false): Promise<{
  ok: boolean;
  error?: string;
  info?: UpdateInfo;
  hasUpdate?: boolean;
}> {
  // 缓存：避免频繁打开关于页就把匿名限流打满
  if (!force) {
    try {
      const cached = localStorage.getItem(CHECK_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as { at: number; payload: unknown };
        if (Date.now() - parsed.at < CHECK_CACHE_MS && parsed.payload) {
          return parsed.payload as Awaited<ReturnType<typeof checkForUpdate>>;
        }
      }
    } catch {
      /* 缓存坏了就当没有 */
    }
  }

  let result: Awaited<ReturnType<typeof checkForUpdate>>;
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      result = { ok: false, error: `查询失败：HTTP ${res.status}` };
    } else {
      const json = (await res.json()) as Record<string, unknown>;
      const tag = String(json.tag_name ?? '');
      const latestVersion = tag.replace(/^v/i, '');
      const info: UpdateInfo = {
        latestVersion,
        notes: String(json.body ?? '').slice(0, 2000),
        publishedAt: String(json.published_at ?? ''),
        htmlUrl: String(json.html_url ?? ''),
        apk: pickApkAsset(Array.isArray(json.assets) ? (json.assets as Array<Record<string, unknown>>) : []),
      };
      // 版本比较：优先用原生返回的 versionName（真实安装版本）；
      // 在浏览器里跑时退回构建期常量（与 build.gradle 同源的 version.ts）。
      const mine = currentAppVersion().versionName || APP_VERSION;
      const hasUpdate = mine ? compareVersions(latestVersion, mine) > 0 : false;
      result = { ok: true, info, hasUpdate };
    }
  } catch (err) {
    result = { ok: false, error: `网络错误：${(err as Error)?.message || '未知'}` };
  }

  try {
    localStorage.setItem(CHECK_CACHE_KEY, JSON.stringify({ at: Date.now(), payload: result }));
  } catch {
    /* 存不进去也不影响本次结果 */
  }
  return result;
}

/** 开始下载（进度通过 window.dshOtaProgress 回调）。 */
export function startDownload(asset: ReleaseAsset): { ok: boolean; error?: string } {
  const n = nativeOta();
  if (!n?.otaDownload) return { ok: false, error: '当前环境不支持 OTA（需要用手机 App）' };
  try {
    const raw = n.otaDownload(asset.url, asset.sha256);
    const parsed = JSON.parse(raw) as { ok?: boolean; message?: string; error?: string };
    return { ok: parsed?.ok !== false, error: parsed?.error || parsed?.message };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || '调用原生下载失败' };
  }
}

/** 拉起安装器。`needPermission=true` 表示要先去授权。 */
export function installUpdate(): { ok: boolean; needPermission?: boolean; message?: string } {
  const n = nativeOta();
  if (!n?.otaInstall) return { ok: false, message: '当前环境不支持安装' };
  try {
    const parsed = JSON.parse(n.otaInstall()) as { ok?: boolean; needPermission?: boolean; message?: string; error?: string };
    return {
      ok: parsed?.ok === true,
      needPermission: parsed?.needPermission === true,
      message: parsed?.message || parsed?.error,
    };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message };
  }
}

export function canInstallPackages(): boolean {
  const n = nativeOta();
  if (!n?.otaCanInstall) return true;
  try {
    return n.otaCanInstall();
  } catch {
    return true;
  }
}

export function openInstallSettings(): void {
  try {
    nativeOta()?.otaOpenInstallSettings?.();
  } catch {
    /* 打不开就只能提示用户手动去系统设置 */
  }
}

export function hasPendingApk(): boolean {
  const n = nativeOta();
  if (!n?.otaPendingApk) return false;
  try {
    const parsed = JSON.parse(n.otaPendingApk()) as { present?: boolean };
    return parsed?.present === true;
  } catch {
    return false;
  }
}

export function clearPendingApk(): void {
  try {
    nativeOta()?.otaClear?.();
  } catch {
    /* ignore */
  }
}

/**
 * 注册下载进度回调（原生侧 `evaluateJavascript` 会调它）。
 *
 * 返回取消注册函数 —— 组件卸载时必须调用，否则旧组件的 setState 会打在
 * 已卸载的组件上（React 18 会警告，且可能更新到一个已经不显示的界面）。
 */
export function onOtaProgress(handler: (p: OtaProgress) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const w = window as unknown as { dshOtaProgress?: (json: string) => void };
  const prev = w.dshOtaProgress;
  w.dshOtaProgress = (json: string) => {
    try {
      handler(JSON.parse(json) as OtaProgress);
    } catch {
      /* 坏帧忽略 */
    }
  };
  return () => {
    w.dshOtaProgress = prev;
  };
}
