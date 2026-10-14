/**
 * 原生壳桥接（Android WebView / Electron）。
 *
 * ## 为什么需要它
 *
 * 产品核心场景是「电脑端等你授权 → 手机立刻收到并当场处理」。
 * 但**网页本身撑不住这个场景**：
 *
 * - Android：`onPause()` 一到，WebView 的 JS 定时器与 WebSocket 就被系统挂起，
 *   锁屏/切后台即断连。所以真正的守护交给**原生前台服务**
 *   （`ApprovalRelayService`），网页只负责在连接成功时把凭据交给它。
 * - Electron：窗口通常藏在托盘里，网页不在看。审批通知由**主进程**发
 *   （`electron/main.cjs`），网页只负责递消息、并在用户点了通知后执行应答。
 *
 * ## 一个必须守住的语义
 *
 * 通知被**点击**（`allow === null`）只表示「把窗口拿到我面前」，
 * **绝不等于同意**。把点击当成批准，就是"用户只瞄了一眼，工具就执行了"。
 *
 * ## 降级
 *
 * 两个壳都不在（普通浏览器打开）时，所有方法都是安全的空操作，
 * `platform === 'web'`，调用方据此如实展示「后台收不到提醒」。
 */

export type NativePlatform = 'android' | 'electron' | 'web';

export interface NativeApprovalPayload {
  eventId: string;
  title: string;
  body: string;
  kind: 'approval' | 'question';
  /** 真主机审批载荷里带的会话 id —— 桌面壳据此把窗口跳到出事的那个会话。 */
  sessionId?: string | null;
}

export interface NativeDecision {
  eventId: string;
  /** true=允许，false=拒绝，**null=只是点了通知把它拉到前台**（不是同意）。 */
  allow: boolean | null;
  /** 事件类型（桌面壳透传）。 */
  kind?: 'approval' | 'question';
  sessionId?: string | null;
}

/** 上报给桌面壳的连接状态（驱动托盘 tooltip）。 */
export interface NativeRelayReport {
  connected: boolean;
  host?: string;
  pending?: number;
}

export interface NativeRelayStatus {
  available: boolean;
  platform: NativePlatform;
  /** 中继是否已配置（有主机与令牌）。 */
  configured: boolean;
  /** stopped | connecting | handshaking | connected | retrying | auth-failed */
  state: string;
  notificationsEnabled: boolean;
  clientId: string | null;
  lastError: string | null;
  label: string;
}

/** Android 壳通过 `addJavascriptInterface(NativeBridge, "DSHNative")` 注入。 */
interface AndroidBridge {
  setConnection(baseUrl: string, token: string, label: string): string;
  clearConnection(): string;
  reconnect(): string;
  status(): string;
  isAnswered(eventId: string): boolean;
  /** 上报当前路由与抽屉开合（壳的返回键判定要用）。 */
  setRoute(json: string): string;
  /** 消费式取待处理深链（通知点击带进来的会话 id）。 */
  takePendingDeepLink(): string;
  /** 打开系统通知设置页。 */
  openNotificationSettings(): string;
}

/** 壳会调用的两个 window 钩子（由网页安装）。 */
declare global {
  interface Window {
    dshHandleBack?: () => boolean;
    dshNativeOnDeepLink?: (link: { eventId?: string; sessionId?: string }) => boolean;
  }
}

/** Electron 壳通过 preload 的 contextBridge 注入。 */
interface DesktopBridge {
  notifyApproval(payload: NativeApprovalPayload): boolean;
  onApprovalAction(cb: (payload: NativeDecision) => void): () => void;
  /** 上报连接状态（托盘 tooltip + 菜单）。 */
  reportRelayStatus(payload: NativeRelayReport): boolean;
  /** 托盘菜单点了"重新连接"。 */
  onReconnectRequest(cb: (info: { reason: string }) => void): () => void;
  platform: string;
}

function androidBridge(): AndroidBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { DSHNative?: AndroidBridge }).DSHNative;
  return bridge && typeof bridge.setConnection === 'function' ? bridge : null;
}

function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { dshDesktop?: DesktopBridge }).dshDesktop;
  return bridge && typeof bridge.notifyApproval === 'function' ? bridge : null;
}

function parseStatus(raw: string | undefined): Partial<NativeRelayStatus> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<NativeRelayStatus>;
  } catch {
    // 原生返回了非 JSON —— 如实当成"状态未知"，不要假装已连接。
    return {};
  }
}

const EMPTY_STATUS: NativeRelayStatus = {
  available: false,
  platform: 'web',
  configured: false,
  state: 'stopped',
  notificationsEnabled: false,
  clientId: null,
  lastError: null,
  label: '',
};

export const NativeBridge = {
  platform(): NativePlatform {
    if (androidBridge()) return 'android';
    if (desktopBridge()) return 'electron';
    return 'web';
  },

  /**
   * 是否有「App 不在前台也能收到审批」的能力。
   *
   * 普通浏览器打开网页时这是 **false** —— 用户有权知道这一点，
   * 而不是以为锁屏也能收到。
   */
  supportsBackgroundAlerts(): boolean {
    return androidBridge() !== null || desktopBridge() !== null;
  },

  /**
   * 把当前连接交给原生中继（Android）。
   *
   * 幂等：重复调用只是让它重新加载配置并重连，可以放心在每次连接时调用。
   */
  publishConnection(baseUrl: string, token: string, label: string): NativeRelayStatus | null {
    const bridge = androidBridge();
    if (!bridge) return null;
    try {
      return { ...EMPTY_STATUS, ...parseStatus(bridge.setConnection(baseUrl, token, label)) };
    } catch (err) {
      console.warn('[native] setConnection 失败', err);
      return null;
    }
  },

  /** 忘记主机 / 登出时停掉中继并清掉原生侧凭据。 */
  clearConnection(): void {
    const bridge = androidBridge();
    if (!bridge) return;
    try {
      bridge.clearConnection();
    } catch (err) {
      console.warn('[native] clearConnection 失败', err);
    }
  },

  /** 用户点「重试」时强制中继重连。 */
  reconnect(): NativeRelayStatus | null {
    const bridge = androidBridge();
    if (!bridge) return null;
    try {
      return { ...EMPTY_STATUS, ...parseStatus(bridge.reconnect()) };
    } catch {
      return null;
    }
  },

  /** 中继状态；没有原生壳时返回 unavailable。 */
  status(): NativeRelayStatus {
    const platform = this.platform();
    const bridge = androidBridge();
    if (!bridge) {
      // Electron 也有后台提醒能力（主进程发通知），但没有"中继服务"状态可查。
      return {
        ...EMPTY_STATUS,
        available: platform === 'electron',
        platform,
        state: platform === 'electron' ? 'desktop' : 'stopped',
      };
    }
    try {
      return { ...EMPTY_STATUS, platform, ...parseStatus(bridge.status()) };
    } catch {
      return { ...EMPTY_STATUS, platform };
    }
  },

  /**
   * 该待办是否已经在原生侧（通知栏）被处理过。
   *
   * 网页端据此收起已经答过的弹窗 —— 否则会出现「通知栏点过了，App 里还挂着让我点」，
   * 用户会怀疑到底批没批，甚至重复应答。
   */
  isAnsweredElsewhere(eventId: string): boolean {
    const bridge = androidBridge();
    if (!bridge) return false;
    try {
      return bridge.isAnswered(eventId) === true;
    } catch {
      return false;
    }
  },

  /**
   * 发起一条桌面通知（Electron）。
   *
   * @returns 是否成功交给主进程；false 表示壳不支持或载荷非法。
   */
  notifyApproval(payload: NativeApprovalPayload): boolean {
    const bridge = desktopBridge();
    if (!bridge) return false;
    try {
      return bridge.notifyApproval(payload) === true;
    } catch (err) {
      console.warn('[native] notifyApproval 失败', err);
      return false;
    }
  },

  /**
   * 订阅桌面通知上的用户决定。
   *
   * @returns 取消订阅函数。**注意 `allow === null` 只表示"点了通知"**。
   */
  onApprovalAction(cb: (payload: NativeDecision) => void): () => void {
    const bridge = desktopBridge();
    if (!bridge || typeof bridge.onApprovalAction !== 'function') return () => undefined;
    try {
      const off = bridge.onApprovalAction((payload) => {
        if (!payload || typeof payload.eventId !== 'string') return;
        cb({
          eventId: payload.eventId,
          allow: payload.allow ?? null,
          // kind/sessionId 必须透传：桌面壳靠它把窗口跳到出事的那个会话，
          // 丢掉就退化成"只把窗口拿到面前"。
          kind: payload.kind,
          sessionId: payload.sessionId ?? null,
        });
      });
      return typeof off === 'function' ? off : () => undefined;
    } catch (err) {
      console.warn('[native] onApprovalAction 订阅失败', err);
      return () => undefined;
    }
  },

  /** 把连接状态上报给桌面壳（托盘 tooltip/菜单用）。非 Electron 环境是空操作。 */
  reportRelayStatus(payload: NativeRelayReport): boolean {
    const bridge = desktopBridge();
    if (!bridge || typeof bridge.reportRelayStatus !== 'function') return false;
    try {
      return bridge.reportRelayStatus(payload) === true;
    } catch {
      return false;
    }
  },

  /** 订阅桌面托盘菜单的"重新连接"。 */
  onReconnectRequest(cb: (info: { reason: string }) => void): () => void {
    const bridge = desktopBridge();
    if (!bridge || typeof bridge.onReconnectRequest !== 'function') return () => undefined;
    try {
      const off = bridge.onReconnectRequest((info) => cb({ reason: info?.reason ?? 'unknown' }));
      return typeof off === 'function' ? off : () => undefined;
    } catch {
      return () => undefined;
    }
  },

  // ── Android 壳：返回键 / 路由上报 / 深链 / 通知设置 ───────────────────────

  /**
   * 把当前路由告诉原生壳。
   *
   * 壳的返回键策略依赖它：不知道路由就只能在"问网页"和"退出"之间二选一。
   * 之前 `onBackPressed` 直接 `super` → **在会话列表按返回就退出 App**（真机实测）。
   */
  setRoute(state: { route: string; drawerOpen: boolean }): void {
    const bridge = androidBridge();
    if (!bridge || typeof bridge.setRoute !== 'function') return;
    try {
      bridge.setRoute(JSON.stringify(state));
    } catch {
      /* 上报失败不影响网页 */
    }
  },

  /**
   * 安装返回键处理器。壳会调 `window.dshHandleBack()`：
   * 返回 `true` = 网页处理了（关抽屉/回上一级）；`false` = 在根页面，交给壳。
   */
  installBackHandler(handler: () => boolean): void {
    if (typeof window === 'undefined' || !androidBridge()) return;
    window.dshHandleBack = () => {
      try {
        return handler() === true;
      } catch (err) {
        console.warn('[native] 返回键处理失败', err);
        return false;
      }
    };
  },

  /**
   * 安装深链处理器（点通知进来时跳到对应会话）。
   * 返回 true 表示已处理，壳才会消费掉这条深链。
   */
  installDeepLinkHandler(handler: (link: { eventId?: string; sessionId?: string }) => boolean): void {
    if (typeof window === 'undefined' || !androidBridge()) return;
    window.dshNativeOnDeepLink = (link) => {
      try {
        return handler(link ?? {}) === true;
      } catch (err) {
        console.warn('[native] 深链处理失败', err);
        return false;
      }
    };
  },

  /** 消费式取待处理深链（页面刚启动、壳还没推时用）。 */
  takePendingDeepLink(): { pending: boolean; eventId?: string; sessionId?: string } | null {
    const bridge = androidBridge();
    if (!bridge || typeof bridge.takePendingDeepLink !== 'function') return null;
    try {
      const parsed = JSON.parse(bridge.takePendingDeepLink() || '{}') as {
        pending?: boolean;
        eventId?: string;
        sessionId?: string;
      };
      return { pending: parsed.pending === true, eventId: parsed.eventId, sessionId: parsed.sessionId };
    } catch {
      return null;
    }
  },

  /** 打开系统通知设置页（通知未授权时给用户一个真正的入口）。 */
  openNotificationSettings(): boolean {
    const bridge = androidBridge();
    if (!bridge || typeof bridge.openNotificationSettings !== 'function') return false;
    try {
      const raw = bridge.openNotificationSettings() || '{}';
      return JSON.parse(raw)?.ok !== false;
    } catch {
      return false;
    }
  },
};