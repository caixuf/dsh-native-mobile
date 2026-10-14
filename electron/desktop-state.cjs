/**
 * 桌面壳状态与窗口几何的**纯函数**模块 —— 故意不 `require('electron')`。
 *
 * ## 为什么单独拆出来
 *
 * 托盘状态、托盘菜单、窗口位置记忆、单实例唤回、通知深链，这五件事有一个共同点：
 * **它们出错时都不报错**。
 *
 *   · tooltip 文案拼错 → 托盘照常显示，只是永久写着错误的连接状态；
 *   · 窗口坐标存了但屏幕被拔掉 → 窗口被恢复到屏幕外，
 *     用户点托盘图标「什么都没发生」（窗口其实存在，只是看不见）；
 *   · 单实例第二个进程只 `createWindow()` → 窗口还被隐藏着，
 *     用户以为程序没反应，于是反复双击图标；
 *   · 通知深链丢了 sessionId → 窗口弹出来了，但停在错误的会话上，
 *     用户还得自己找那条待审批；
 *   · 深链把 `allow: null`（只是点了一下通知）读成 `false` → 用户没同意却被当成拒绝。
 *
 * 这些都是「看着正常、实际失效」。拆成纯模块之后，
 * `node scripts/test-desktop-notify.mjs` 可以在**没有显示器、没有 Electron、
 * 没有系统通知服务**的环境里逐条钉死（同 notification-options.cjs 的做法）。
 *
 * ## 本模块的承诺
 *
 *   · 任何输入（`null` / 字符串 / 负尺寸 / 坐标 99999 / 损坏 JSON）都**不抛异常**；
 *   · 越界坐标**绝不**原样返回 —— 宁可回落居中，也不能把窗口放到用户看不见的地方；
 *   · 返回对象字段永远有定义，没有 `undefined` 漏给调用方去猜。
 */

'use strict';

/** 主窗口默认几何：main.cjs 用它建窗，也用它做越界后的回落。 */
const DEFAULT_WINDOW = Object.freeze({
  width: 440,
  height: 920,
  minWidth: 380,
  minHeight: 700,
});

/**
 * 判定「窗口还在用户看得见的地方」所需的最小重叠像素。
 * 80px 大致是一个标题栏的高度：只要还有这么多落在某块屏幕内，
 * 用户就抓得住窗口把它拖回来；低于这个值基本等价于「窗口丢了」。
 */
const MIN_VISIBLE_PX = 80;

/** 窗口几何的持久化文件名（放在 userData 下，与 main.cjs 共用同一个常量）。 */
const WINDOW_STATE_FILE = 'window-state.json';

/** 托盘 tooltip 前缀 —— 托盘菜单与通知文案保持同一套措辞。 */
const TOOLTIP_PREFIX = 'DSH 远程控制';

/**
 * 托盘菜单的固定三项。
 *
 * `id` 是 main.cjs 派发 click 用的键，`label` 是用户看到的字。
 * 放在这里而不是散在 main.cjs 里，是为了让「菜单必须有退出入口」这件事可测 ——
 * 常驻应用丢掉了退出项，用户就只能去杀进程。
 */
const TRAY_MENU_ITEMS = Object.freeze([
  Object.freeze({ id: 'show', label: '显示主窗口' }),
  Object.freeze({ id: 'reconnect', label: '重新连接' }),
  Object.freeze({ id: 'quit', label: '退出' }),
]);

// ── 基础工具 ────────────────────────────────────────────────────────────────

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 只接受**非空字符串**；数字 / null / {} 一律视为缺失（调用方传错类型时不猜）。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

function roundInt(value) {
  return Math.round(value);
}

/**
 * 归一化一块矩形区域。
 *
 * 同时接受三种输入，因为调用方拿到的形状不统一：
 *   · `{x,y,width,height}`                —— 内部算出来的工作区；
 *   · Electron `Display`（有 workArea）   —— `screen.getAllDisplays()`；
 *   · 兜底形状（只有 bounds）             —— 旧版 / 伪造输入。
 *
 * 三者都非法返回 `null`：调用方按「没有显示器信息」处理，
 * 而不是猜一个 0,0 把窗口扔到主屏左上角。
 */
function normalizeArea(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (
    isFiniteNumber(raw.x) &&
    isFiniteNumber(raw.y) &&
    isFiniteNumber(raw.width) &&
    isFiniteNumber(raw.height) &&
    raw.width > 0 &&
    raw.height > 0
  ) {
    return { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
  }
  return normalizeArea(raw.workArea) || normalizeArea(raw.bounds);
}

/**
 * 取显示器的工作区。
 *
 * `workArea` 是排除了任务栏 / Dock 的区域，优先用它（见 normalizeArea 的顺序）。
 */
function workAreaOf(display) {
  return normalizeArea(display);
}

/** 把任意输入归一化成合法几何；非法返回 `null`（调用方据此走回落）。 */
function normalizeBounds(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { x, y, width, height } = raw;
  if (![x, y, width, height].every(isFiniteNumber)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x: roundInt(x), y: roundInt(y), width: roundInt(width), height: roundInt(height) };
}

/** 尺寸归一化：非法值用默认值，且不许小于最小尺寸（否则窗口小到抓不住）。 */
function normalizeWindowDefaults(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const pick = (key, fallback) =>
    isFiniteNumber(source[key]) && source[key] > 0 ? roundInt(source[key]) : fallback;
  const minWidth = pick('minWidth', DEFAULT_WINDOW.minWidth);
  const minHeight = pick('minHeight', DEFAULT_WINDOW.minHeight);
  return {
    width: Math.max(pick('width', DEFAULT_WINDOW.width), minWidth),
    height: Math.max(pick('height', DEFAULT_WINDOW.height), minHeight),
    minWidth,
    minHeight,
  };
}

/**
 * 把尺寸夹到 [min, max]。
 *
 * `max` 是工作区尺寸。工作区比最小尺寸还小的极端情况（小屏 / 伪造输入）
 * 以工作区为准：窗口比屏幕还大同样会让用户抓不住窗口。
 */
function clampSize(value, min, max) {
  const size = isFiniteNumber(value) && value > 0 ? roundInt(value) : min;
  if (!isFiniteNumber(max) || max <= 0) return Math.max(min, size);
  if (max < min) return Math.max(1, roundInt(max));
  return Math.min(Math.max(size, min), roundInt(max));
}

/** 两个一维区间（起点 + 长度）的重叠长度，不相交时为 0。 */
function overlapLength(aStart, aSize, bStart, bSize) {
  return Math.max(0, Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart));
}

// ── §1 托盘状态 ─────────────────────────────────────────────────────────────

/**
 * 归一化渲染进程上报的中继状态（**不可信负载**）。
 *
 * `pending` 只接受有限数值并向下取整：`NaN` / `Infinity` / `'3'` / `-5`
 * 都会被压成 `0`，否则 tooltip 会出现「待审批 NaN」这种把错误写在脸上的文案。
 *
 * @param {unknown} payload `{ connected: boolean, host?: string, pending?: number }`
 * @returns {{ connected: boolean, host: string, pending: number }}
 */
function normalizeRelayStatus(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const pending =
    isFiniteNumber(raw.pending) && raw.pending > 0 ? Math.floor(raw.pending) : 0;
  return {
    connected: raw.connected === true,
    host: nonEmptyString(raw.host),
    pending,
  };
}

/**
 * 托盘 tooltip 文案。
 *
 * 例：`DSH 远程控制 · 已连接 · 192.168.1.8:8787 · 待审批 3`
 *
 * 待审批数**不因「未连接」而隐藏**：那几条审批是本地已收到的事件，
 * 断线时更需要把这个数字摆在用户眼前，而不是替他判断「反正连不上就不显示了」。
 *
 * @param {unknown} payload
 * @returns {string}
 */
function buildRelayStatusText(payload) {
  const status = normalizeRelayStatus(payload);
  const parts = [TOOLTIP_PREFIX, status.connected ? '已连接' : '未连接'];
  if (status.host) parts.push(status.host);
  if (status.pending > 0) parts.push(`待审批 ${status.pending}`);
  return parts.join(' · ');
}

/**
 * 托盘菜单模型（纯数据，交给 main.cjs 拼成 Electron 的 Menu）。
 * 返回**深拷贝**：调用方改 label 不该污染模块常量。
 *
 * @returns {Array<{ id: 'show'|'reconnect'|'quit', label: string }>}
 */
function buildTrayMenuModel() {
  return TRAY_MENU_ITEMS.map((item) => ({ ...item }));
}

// ── §3 窗口状态记忆 ─────────────────────────────────────────────────────────

/**
 * 归一化磁盘上的窗口状态。
 * @param {unknown} raw
 * @returns {{ bounds: {x:number,y:number,width:number,height:number}, maximized: boolean } | null}
 */
function normalizeStoredWindowState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const bounds = normalizeBounds(raw.bounds);
  if (!bounds) return null;
  return { bounds, maximized: raw.maximized === true };
}

/**
 * 解析 window-state.json 的**文本**。
 * 文件损坏 / 被手改成非法 JSON / 内容不是对象，一律返回 `null` 走回落，
 * **绝不抛异常** —— 一个坏掉的配置文件不该让应用起不来。
 *
 * @param {unknown} text
 * @returns {{ bounds: object, maximized: boolean } | null}
 */
function parseWindowStateFile(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return normalizeStoredWindowState(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * 序列化待落盘的窗口状态；输入非法时返回 `''`（调用方据此跳过写盘）。
 * @returns {string}
 */
function serializeWindowState(bounds, maximized) {
  const state = normalizeStoredWindowState({ bounds, maximized });
  if (!state) return '';
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * 判断窗口几何是否还落在**任意一块**显示器的可见区域内。
 *
 * 逐块显示器求重叠；只要有一块的横向与纵向重叠都达到阈值就算可见。
 * 阈值取 `min(MIN_VISIBLE_PX, 窗口自身尺寸)`：小窗口不该被一个绝对像素值一票否决。
 *
 * @param {unknown} bounds
 * @param {unknown} displays Electron `screen.getAllDisplays()` 的形状
 * @returns {boolean}
 */
function isBoundsVisible(bounds, displays, minVisiblePx) {
  const clean = normalizeBounds(bounds);
  if (!clean) return false;
  const min =
    isFiniteNumber(minVisiblePx) && minVisiblePx >= 0 ? minVisiblePx : MIN_VISIBLE_PX;
  const areas = (Array.isArray(displays) ? displays : []).map(workAreaOf).filter(Boolean);
  for (const area of areas) {
    const w = overlapLength(clean.x, clean.width, area.x, area.width);
    const h = overlapLength(clean.y, clean.height, area.y, area.height);
    if (w >= Math.min(min, clean.width) && h >= Math.min(min, clean.height)) return true;
  }
  return false;
}

/** 在默认尺寸与工作区之间取一个居中矩形（屏幕拔掉后的回落目标）。 */
function centerBounds(size, area) {
  const width = clampSize(size.width, size.minWidth, area.width);
  const height = clampSize(size.height, size.minHeight, area.height);
  return {
    x: roundInt(area.x + (area.width - width) / 2),
    y: roundInt(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

/** 恢复保存的几何时，夹一下尺寸，但不移动 x/y（可见性已经校验过）。 */
function fitBoundsToArea(bounds, area, size) {
  const clean = normalizeBounds(bounds);
  return {
    x: clean.x,
    y: clean.y,
    width: clampSize(clean.width, size.minWidth, area.width),
    height: clampSize(clean.height, size.minHeight, area.height),
  };
}

/** 找出与窗口重叠最多的那块屏幕 —— 决定恢复时按哪块屏幕的尺寸夹边界。 */
function areaWithMaxOverlap(bounds, areas) {
  let best = areas[0];
  let bestScore = -1;
  for (const area of areas) {
    const score = Math.min(
      overlapLength(bounds.x, bounds.width, area.x, area.width),
      overlapLength(bounds.y, bounds.height, area.y, area.height),
    );
    if (score > bestScore) {
      bestScore = score;
      best = area;
    }
  }
  return best;
}

/**
 * 决定这次建窗用哪个几何。
 *
 * 三条出口：
 *   · `restored`           保存的坐标仍在某块屏幕内 → 原样恢复（尺寸夹到工作区）；
 *   · `out-of-bounds`      屏幕被拔掉 / 分辨率变小 → **回落为主屏居中**，绝不猜到屏幕外；
 *   · `no-saved-state` / `invalid-saved-state` / `no-display` → 首启用默认居中。
 *
 * `bounds` 为 `null` 表示「没有任何显示器信息」：此时把定位交给 Electron
 * （不传 x/y，它会自己居中），好过在这里编一个 0,0。
 *
 * @param {unknown} saved 已解析的窗口状态（可为 null）
 * @param {unknown} displays
 * @param {unknown} defaults `DEFAULT_WINDOW`
 * @returns {{ bounds: {x:number,y:number,width:number,height:number} | null,
 *             maximized: boolean, restored: boolean,
 *             reason: 'restored'|'out-of-bounds'|'no-saved-state'|'invalid-saved-state'|'no-display' }}
 */
function resolveWindowState(saved, displays, defaults) {
  const size = normalizeWindowDefaults(defaults);
  const entries = (Array.isArray(displays) ? displays : [])
    .filter((display) => display && typeof display === 'object')
    .map((display) => ({ area: workAreaOf(display), isPrimary: display.isPrimary === true }))
    .filter((entry) => entry.area);

  if (entries.length === 0) {
    return { bounds: null, maximized: false, restored: false, reason: 'no-display' };
  }

  const areas = entries.map((entry) => entry.area);
  const stored = normalizeStoredWindowState(saved);

  if (stored && isBoundsVisible(stored.bounds, areas)) {
    return {
      bounds: fitBoundsToArea(stored.bounds, areaWithMaxOverlap(stored.bounds, areas), size),
      maximized: stored.maximized,
      restored: true,
      reason: 'restored',
    };
  }

  const primary = (entries.find((entry) => entry.isPrimary) || entries[0]).area;
  const reason =
    saved == null ? 'no-saved-state' : stored ? 'out-of-bounds' : 'invalid-saved-state';
  return { bounds: centerBounds(size, primary), maximized: false, restored: false, reason };
}

// ── §2 通知深链 ─────────────────────────────────────────────────────────────

/**
 * 归一化一条审批事件的深链字段。
 *
 * `sessionId` 是「点通知后该跳到哪个会话」的唯一依据；缺失时返回 `null`
 * 而不是空串，让渲染进程能用 `if (action.sessionId)` 明确区分（空串会骗过真值判断）。
 * kind 沿用 notification-options.cjs 的口径：未知一律按 approval（宁可多响，不可漏批）。
 *
 * @param {unknown} raw
 * @returns {{ eventId: string, kind: 'approval'|'question', sessionId: string | null } | null}
 *           eventId 缺失/非法时返回 null（没有它，用户点了通知我们也说不清是批哪一条）
 */
function normalizeDeepLink(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const eventId = nonEmptyString(source.eventId);
  if (!eventId) return null;
  return {
    eventId,
    kind: source.kind === 'question' ? 'question' : 'approval',
    sessionId: nonEmptyString(source.sessionId) || null,
  };
}

/**
 * 构造回送渲染进程的决定负载（`dsh:approval-action`）。
 *
 * 🔴 `allow` 的三态语义是协议的一部分，不许被压成布尔：
 *   · `true`  → 用户在通知上点了「允许一次」；
 *   · `false` → 点了「拒绝」；
 *   · `null`  → 只是点了一下通知正文（或未知按钮）：**只聚焦窗口，
 *               渲染进程保持待办弹窗可见**。把 null 写成 false 就会
 *               「用户什么都没决定，但待办被关掉」。
 *
 * 返回对象额外带 `kind` / `sessionId`，对老渲染进程（只读 eventId/allow）向后兼容。
 *
 * @param {{ eventId?: unknown, allow?: unknown, kind?: unknown, sessionId?: unknown }} [action]
 * @returns {{ eventId: string, allow: boolean | null, kind: 'approval'|'question',
 *             sessionId: string | null } | null}
 */
function buildApprovalAction(action) {
  const link = normalizeDeepLink(action);
  if (!link) return null;
  const rawAllow = action && typeof action === 'object' ? action.allow : undefined;
  return {
    eventId: link.eventId,
    allow: rawAllow === true ? true : rawAllow === false ? false : null,
    kind: link.kind,
    sessionId: link.sessionId,
  };
}

// ── §4 单实例唤回 ───────────────────────────────────────────────────────────

/**
 * 规划「把窗口交到用户眼前」要按顺序执行的步骤。
 *
 * 为什么不能只 `createWindow()`：窗口「关掉」其实只是 `hide()`（常驻设计），
 * 它依然存在、依然 `!isDestroyed()`，所以旧逻辑会走「已有窗口」分支只 show+focus。
 * 但第二个实例启动时窗口可能**处于隐藏或最小化**状态，只 show 而不 restore
 * 会把一个最小化的窗口「显示」出来 —— 用户看不到任何变化，只会反复双击图标。
 *
 * 顺序：先 show（隐藏 → 可见）→ 再 restore（最小化 → 还原）→ 最后 focus。
 *
 * @param {unknown} state `{ visible?: boolean, minimized?: boolean, destroyed?: boolean }`
 * @returns {Array<'create'|'show'|'restore'|'focus'>}
 */
function planWindowReveal(state) {
  const source = state && typeof state === 'object' ? state : {};
  if (source.destroyed === true) return ['create'];
  const steps = [];
  // isVisible() 在部分平台上对最小化窗口仍返回 true，所以两个判断是独立的、不能互斥。
  if (source.visible !== true) steps.push('show');
  if (source.minimized === true) steps.push('restore');
  steps.push('focus');
  return steps;
}

module.exports = {
  DEFAULT_WINDOW,
  MIN_VISIBLE_PX,
  TOOLTIP_PREFIX,
  TRAY_MENU_ITEMS,
  WINDOW_STATE_FILE,
  buildApprovalAction,
  buildRelayStatusText,
  buildTrayMenuModel,
  centerBounds,
  isBoundsVisible,
  normalizeArea,
  normalizeBounds,
  normalizeDeepLink,
  normalizeRelayStatus,
  normalizeStoredWindowState,
  normalizeWindowDefaults,
  parseWindowStateFile,
  planWindowReveal,
  resolveWindowState,
  serializeWindowState,
};