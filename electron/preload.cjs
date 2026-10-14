/**
 * 渲染进程 ↔ 主进程的**唯一**桥（`contextIsolation: true` + `nodeIntegration: false`）。
 *
 * 暴露面刻意只有三个成员（`window.dshDesktop`），因为这是安全边界：
 * 渲染进程里跑的是网页代码（可能来自 dev server），
 * 多暴露一个 `ipcRenderer` 就等于把整个主进程交出去。
 *
 * 通道名必须与 electron/main.cjs 里的常量**逐字一致**：
 *   - 上行 `dsh:notify-approval`   （渲染进程 → 主进程：弹一条审批通知）
 *   - 下行 `dsh:approval-action`   （主进程 → 渲染进程：用户在通知上做了什么）
 * 通道名写错的表现同样是**静默**（send 到没人听的通道，不报错），
 * 所以 scripts/test-desktop-notify.mjs 会把这条链路一起钉住。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const NOTIFY_CHANNEL = 'dsh:notify-approval';
const APPROVAL_ACTION_CHANNEL = 'dsh:approval-action';

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
 * @returns {{ eventId: string, title: string, body: string, kind: 'approval'|'question' } | null}
 */
function normalizeApprovalPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const { eventId, title, body, kind } = payload;
  // eventId 是点名要校验的那一个：没有它，用户点了通知我们也说不清是批哪一条。
  if (typeof eventId !== 'string' || eventId.trim() === '') return null;

  return {
    eventId: eventId.trim(),
    // 标题/正文允许缺失 —— 主进程那侧（notification-options.cjs）有兜底文案，
    // 这里只保证类型是字符串，不退化成 "[object Object]"。
    title: typeof title === 'string' ? title : '',
    body: typeof body === 'string' ? body : '',
    kind: kind === 'question' ? 'question' : 'approval',
  };
}

/** 下行负载同样校验：回调拿到的必须是 { eventId: string, allow: boolean|null }。 */
function normalizeActionPayload(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.eventId !== 'string' || data.eventId.trim() === '') return null;
  const allow = data.allow === true ? true : data.allow === false ? false : null;
  return { eventId: data.eventId.trim(), allow };
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
   * @param {(action: {eventId: string, allow: boolean|null}) => void} cb
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

  /** 渲染进程可能需要按平台调整提示文案（如「在通知上点允许」只对 macOS 成立）。 */
  platform: process.platform,
});