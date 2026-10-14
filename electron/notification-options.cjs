/**
 * 桌面通知选项的**纯函数**模块 —— 故意不 `require('electron')`。
 *
 * ## 为什么单独拆出来
 *
 * 这里的每一条平台差异都属于同一个失败模式：**静默失败**。
 * 给 Electron 传了当前平台不支持的字段，它不报错、不崩、日志干净 ——
 * 只是那条审批通知**永远不会出现**。而本产品存在的唯一理由就是
 * 「电脑端等你授权 → 你立刻被告知」，静默 = 核心能力归零。
 *
 * 拆成纯模块后，这些差异可以用 `node scripts/test-desktop-notify.mjs`
 * 在**没有显示器、没有 Electron、没有系统通知服务**的环境里逐条钉死。
 *
 * ## 各平台真实约束（研究结论，不要凭感觉改）
 *
 * | 平台    | actions 按钮 | 依据 |
 * |---------|--------------|------|
 * | macOS   | 支持（最多 2 个可用） | `Notification.actions`；但只有 `alert` 风格 / **已签名**应用才渲染出按钮，未签名的开发构建会退化成普通横幅（点了只聚焦窗口）。所以 `hasActions: true` 只代表「我们把按钮交上去了」，不代表一定会显示。 |
 * | Windows | **不支持**（Electron 未实现） | 传了也没有按钮，只有正文；必须靠 `focusOnClick` 把用户带回应用内点。 |
 * | Linux   | **不支持** | 同上。 |
 *
 * Windows 还有两个前提（见 electron/main.cjs 顶部）：
 *   1. 必须设 AppUserModelID，否则 `new Notification()` 不报错、**静默丢弃**；
 *   2. 部分系统策略下只有**已安装 / 注册到开始菜单**的应用才显示 toast。
 *      降级路径是托盘 / 窗口提醒 —— 本模块**不**去偷偷装快捷方式。
 *
 * 因此本模块不承诺「通知一定出现」，它承诺的是：**把每个平台能用的手段都打开，
 * 并且如实告诉调用方哪些手段其实不存在（`hasActions` / `focusOnClick`）。**
 */

'use strict';

/**
 * Windows toast 正文会被系统截断，而工具参数（tool args）经常是几百字。
 * 180 是「还能读出重点」的上限；超出部分截断并加省略号，
 * 让用户至少明白「后面还有内容，去应用里看」。
 */
const MAX_BODY_CHARS = 180;

/** 用真正的省略号（U+2026），不是三个点 —— 与仓库其它 UI 文案一致。 */
const ELLIPSIS = '\u2026';

/**
 * 空标题 / 空正文的兜底文案。
 *
 * 🔴 必须提到 `kind`：正文为空的通知在部分平台会被直接丢弃，
 * 用户连「有过一条通知」都不知道。兜底文案要能自解释是谁在等。
 */
const DEFAULT_TEXTS = {
  approval: {
    title: 'DSH 需要你授权（approval）',
    body: '收到一条 approval 事件，但没有可显示的正文 —— 请在应用内查看待处理的授权请求。',
  },
  question: {
    title: 'DSH 需要你回答（question）',
    body: '收到一条 question 事件，但没有可显示的正文 —— 请在应用内查看待回答的问题。',
  },
};

/**
 * macOS 的审批按钮。
 *
 * 文案与 `src/` 里的审批按钮保持一致（「允许一次」而不是「允许」——
 * 本产品的授权还有「允许并记住」之类的语义，含糊的「允许」会被误读）。
 * 顺序是协议的一部分：index 0 = 允许，index 1 = 拒绝（main.cjs 按索引判定）。
 */
const APPROVAL_ACTIONS = [
  { type: 'button', text: '允许一次' },
  { type: 'button', text: '拒绝' },
];

/** 只有这两个 kind 参与文案与降级决策；未知值一律按 approval 处理（见下）。 */
const KINDS = ['approval', 'question'];

/**
 * kind 白名单化。
 *
 * 未知 / 缺失一律当成 `approval`：审批是**必须出声、必须带上决定**的那一类，
 * 猜错方向的代价（漏掉一次授权）远大于多响一声。
 * 渲染进程若传了 `'notify'` 之类没定义的值，也不会得到一条「既不响、也没按钮、
 * 点了还只聚焦」的空壳通知。
 *
 * @param {unknown} kind
 * @returns {'approval'|'question'}
 */
function normalizeKind(kind) {
  return kind === 'question' ? 'question' : 'approval';
}

/**
 * 平台白名单化：未知平台（'freebsd'、undefined…）退化成「没有 actions」，
 * 也就是最保守的那一档，绝不假装自己有按钮。
 *
 * @param {unknown} platform
 * @returns {'win32'|'darwin'|'linux'|'unknown'}
 */
function normalizePlatform(platform) {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : 'unknown';
}

/** 只接受**非空字符串**；数字 / null / {} 一律视为缺失（调用方传错类型时不猜）。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

/**
 * 按**码点**截断，不劈开代理对（否则会出现半个 emoji 的乱码）。
 * 返回值长度（含省略号）不超过 MAX_BODY_CHARS。
 */
function truncateBody(text) {
  const chars = Array.from(text);
  if (chars.length <= MAX_BODY_CHARS) return text;
  return chars.slice(0, MAX_BODY_CHARS - 1).join('') + ELLIPSIS;
}

/**
 * 把一条待办事件编译成「当前平台该用的通知参数」。
 *
 * @param {{ title?: unknown, body?: unknown, kind?: unknown, platform?: unknown }} [input]
 * @returns {{
 *   title: string,
 *   body: string,
 *   actions: Array<{type: 'button', text: string}>,
 *   hasActions: boolean,
 *   silent: boolean,
 *   focusOnClick: boolean,
 *   sound: string | null,
 * }}
 *
 * 返回对象的字段**永远全部有定义**（不允许 `undefined`）：
 * Electron 对缺字段的容忍度各平台不同，而这里每一条都对得上一种静默丢弃。
 */
function buildNotificationOptions(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const kind = normalizeKind(raw.kind);
  const platform = normalizePlatform(raw.platform);
  const fallback = DEFAULT_TEXTS[kind];

  const title = nonEmptyString(raw.title) || fallback.title;
  const body = truncateBody(nonEmptyString(raw.body) || fallback.body);

  // actions 只在「macOS + 审批」这一种组合下有意义：
  //  - Windows/Linux 的 Electron 没有按钮实现，传了也不会显示；
  //  - 提问的答案不是二元的（可能 N 个选项/多选），两个通用按钮会
  //    把「选了哪个选项」这个信息**编造**出来，所以提问一律不带按钮，
  //    只靠 focusOnClick 把用户带回应用内回答。
  const supportsActions = platform === 'darwin' && kind === 'approval';

  return {
    title,
    body,
    // 深拷贝：调用方改到按钮文案不会污染模块内的常量。
    actions: supportsActions ? APPROVAL_ACTIONS.map((action) => ({ ...action })) : [],
    hasActions: supportsActions,
    // 🔴 审批是唯一**必须出声**的通知类：静音的审批 = 错过的授权。
    //    提问同样在等人，但它不像审批那样会阻塞主机，静音可接受。
    silent: kind !== 'approval',
    // 窗口关掉只是 hide（常驻设计），所以点通知必须先 show+focus；
    // Windows/Linux 上没有按钮，这条路径就是用户唯一的「一步回到待办」。
    focusOnClick: true,
    // sound 仅在 macOS 有意义（Electron 的 sound 是 macOS 专属字段）；
    // 其它平台靠 silent=false 触发系统默认提示音。
    sound: kind === 'approval' && platform === 'darwin' ? 'default' : null,
  };
}

module.exports = buildNotificationOptions;
// 两种取用方式都支持：`const build = require(...)` 与
// `const { buildNotificationOptions } = require(...)`。
module.exports.buildNotificationOptions = buildNotificationOptions;
module.exports.normalizeKind = normalizeKind;
module.exports.normalizePlatform = normalizePlatform;
module.exports.MAX_BODY_CHARS = MAX_BODY_CHARS;
module.exports.DEFAULT_TEXTS = DEFAULT_TEXTS;
module.exports.KINDS = KINDS;