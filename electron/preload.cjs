/**
 * 渲染进程 ↔ 主进程的**唯一**桥（`contextIsolation: true` + `nodeIntegration: false`）。
 *
 * 暴露面刻意只有五个成员（`window.dshDesktop`），因为这是安全边界：
 * 渲染进程里跑的是网页代码（可能来自 dev server），
 * 多暴露一个 `ipcRenderer` 就等于把整个主进程交出去。
 *
 * 通道名必须与 electron/main.cjs 里的常量**逐字一致**：
 *   - 上行 `dsh:notify-approval`   （渲染进程 → 主进程：弹一条审批通知）
 *   - 下行 `dsh:approval-action`   （主进程 → 渲染进程：用户在通知上做了什么 + 深链字段）
 *   - 上行 `dsh:relay-status`      （渲染进程 → 主进程：连接状态 + 待审批数，喂托盘 tooltip）
 *   - 下行 `dsh:relay-reconnect`   （主进程 → 渲染进程：用户点了托盘「重新连接」）
 * 通道名写错的表现同样是**静默**（send 到没人听的通道，不报错），
 * 所以 scripts/test-desktop-notify.mjs 会把这条链路一起钉住。
 *
 * ⚠️ 本文件**不 require 项目内的 CJS 模块**：preload 可能运行在沙箱渲染进程里，
 * 那时 `require` 只能加载 electron 与少量内建模块，引本地文件会在运行时直接失败
 * （同样是「不报错也不生效」）。所以这里只做**类型级**归一化，
 * 真正的校验/拼装在主进程侧用纯模块 desktop-state.cjs 再走一遍。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const NOTIFY_CHANNEL = 'dsh:notify-approval';
const APPROVAL_ACTION_CHANNEL = 'dsh:approval-action';
const RELAY_STATUS_CHANNEL = 'dsh:relay-status';
const RELAY_RECONNECT_CHANNEL = 'dsh:relay-reconnect';

/**
 * 校验并归一化上行负载；非法输入返回 `null` 表示**丢弃**。
 *
 * 为什么在 preload 就挡一层：渲染进程的任何代码（包括被注入的脚本）都能调
 * `window.dshDesktop.notifyApproval(...)`。往主进程塞 `{eventId: {}}`、
 * `{eventId: null}` 这类值，轻则通知点不开（点回去对不上事件），
 * 重则主进程回调里抛异常 —— 而主进程抛异常会连带影响托盘与长连接。
 * 所以宁可**在这里丢掉**，也不要把不确定性送过边界。
 *
 * @param {unknown} payload
 * @returns {{ eventId: string, title: string, body: string, kind: 'approval'|'question',
 *             sessionId: string | null } | null}
 */
function normalizeApprovalPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const { eventId, title, body, kind, sessionId } = payload;
  // eventId 是点名要校验的那一个：没有它，用户点了通知我们也说不清是批哪一条。
  if (typeof eventId !== 'string' || eventId.trim() === '') return null;

  return {
    eventId: eventId.trim(),
    // 标题/正文允许缺失 —— 主进程那侧（notification-options.cjs）有兜底文案，
    // 这里只保证类型是字符串，不退化成 "[object Object]"。
    title: typeof title === 'string' ? title : '',
    body: typeof body === 'string' ? body : '',
    kind: kind === 'question' ? 'question' : 'approval',
    // 深链字段：主进程把它原样带回 `dsh:approval-action`，渲染进程据此跳到
    // 对应会话的待审批项。缺失归一化成 null（空串会骗过 `if (sessionId)`）。
    sessionId: typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : null,
  };
}

/**
 * 下行负载校验：回调拿到的必须是
 * `{ eventId: string, allow: boolean|null, kind, sessionId }`。
 *
 * `allow` 的三态是协议的一部分，**不许压缩**：
 * `null` = 只是点了一下通知正文（只聚焦窗口，待办保持可见），
 * 把它写成 `false` 会变成「用户没决定，但待办被拒掉了」。
 * kind/sessionId 是 2026-10-15 新增的深链字段，老渲染进程只读 eventId/allow，
 * 多出来的字段对它无害（向后兼容）。
 */
function normalizeActionPayload(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.eventId !== 'string' || data.eventId.trim() === '') return null;
  const allow = data.allow === true ? true : data.allow === false ? false : null;
  return {
    eventId: data.eventId.trim(),
    allow,
    kind: data.kind === 'question' ? 'question' : 'approval',
    sessionId: typeof data.sessionId === 'string' && data.sessionId.trim() !== ''
      ? data.sessionId.trim()
      : null,
  };
}

/** 上行中继状态：只保留主进程 tooltip 需要的那三个字段，多余的一律丢掉。 */
function normalizeRelayStatusPayload(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  return {
    connected: raw.connected === true,
    host: typeof raw.host === 'string' ? raw.host.trim() : '',
    pending:
      typeof raw.pending === 'number' && Number.isFinite(raw.pending) && raw.pending > 0
        ? Math.floor(raw.pending)
        : 0,
  };
}

contextBridge.exposeInMainWorld('dshDesktop', {
  /**
   * 请求主进程弹一条桌面通知（审批 / 提问）。
   * 返回 false = 负载非法、已被丢弃（**不抛异常**：抛进渲染进程会打断 UI 流程，
   * 而「通知没弹出来」不该让渲染进程崩）。
   */
  notifyApproval(payload) {
    const clean = normalizeApprovalPayload(payload);
    if (!clean) {
      console.warn('[dshDesktop] notifyApproval 负载非法（eventId 缺失或非字符串），已丢弃');
      return false;
    }
    ipcRenderer.send(NOTIFY_CHANNEL, clean);
    return true;
  },

  /**
   * 订阅「用户在系统通知上做了决定」。
   * @param {(action: {eventId: string, allow: boolean|null, kind: 'approval'|'question',
   *                  sessionId: string|null}) => void} cb
   * @returns {() => void} 取消订阅函数 —— 组件卸载时必须调，否则监听器会累积
   *          （React 严格模式下 effect 跑两次，不返回 unsubscribe 就会双份处理）。
   */
  onApprovalAction(cb) {
    if (typeof cb !== 'function') return () => {};

    const listener = (_event, data) => {
      const action = normalizeActionPayload(data);
      if (!action) return; // 坏数据不往渲染进程里灌
      cb(action);
    };

    ipcRenderer.on(APPROVAL_ACTION_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(APPROVAL_ACTION_CHANNEL, listener);
    };
  },

  /**
   * 上报当前连接状态 → 主进程写进托盘 tooltip。
   *
   * `connected` 必须是布尔值：负载非法时**直接丢弃**（返回 false），
   * 而不是发一条「未连接」把上一次真实状态覆盖掉 ——
   * 错的状态比旧的状态更危险（用户会去排查一个根本不存在的断线）。
   *
   * @param {{connected: boolean, host?: string, pending?: number}} payload
   * @returns {boolean} true = 已上报；false = 负载非法，什么都没发
   */
  reportRelayStatus(payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.connected !== 'boolean') {
      console.warn('[dshDesktop] reportRelayStatus 负载非法（connected 必须是 boolean），已丢弃');
      return false;
    }
    ipcRenderer.send(RELAY_STATUS_CHANNEL, normalizeRelayStatusPayload(payload));
    return true;
  },

  /**
   * 订阅「用户在托盘菜单上点了重新连接」。
   * 主进程只发信号，真正的重连仍在渲染进程侧完成（状态机在那边）。
   * @param {(info: {reason: string}) => void} cb
   * @returns {() => void} 取消订阅函数（同 onApprovalAction，必须调）
   */
  onReconnectRequest(cb) {
    if (typeof cb !== 'function') return () => {};

    const listener = (_event, data) => {
      const reason = data && typeof data.reason === 'string' && data.reason !== '' ? data.reason : 'tray';
      cb({ reason });
    };

    ipcRenderer.on(RELAY_RECONNECT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(RELAY_RECONNECT_CHANNEL, listener);
    };
  },

  /** 渲染进程可能需要按平台调整提示文案（如「在通知上点允许」只对 macOS 成立）。 */
  platform: process.platform,
});