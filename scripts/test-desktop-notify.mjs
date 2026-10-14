/**
 * 桌面审批通知 · **平台降级契约测试**（零依赖，手写断言）。
 *
 * 运行：`node scripts/test-desktop-notify.mjs`
 *
 * ## 为什么这组测试值得存在
 *
 * 桌面通知的失败模式**没有异常、没有日志、界面也不报错**：
 *
 *   · 给 Windows 传 `actions` → 没有按钮，用户以为「点了通知就等于同意」；
 *   · 正文太长 → 系统从中间截断，关键的路径/命令被吃掉；
 *   · 正文为空 → 部分平台直接**丢弃整条通知**，用户连「有人等他」都不知道；
 *   · `silent: true` 用在审批上 → 通知安静地出现又安静地过期 = 错过的授权。
 *
 * 这些都属于本项目一直在打的同一类敌人：**静默失败**。
 * 所以这里逐条把「哪个平台能用什么手段、不能用时代价是什么」钉死，
 * 并且**不需要显示器、不需要 Electron** —— 被测模块是纯的（见 §I 自检）。
 *
 * 覆盖：
 *   §A macOS 审批 → 真按钮 + hasActions + 必须出声
 *   §B/§C Windows / Linux 审批 → 没有按钮，靠 focusOnClick 回窗口
 *   §D 正文 180 字符截断（按码点，不劈开 emoji）
 *   §E 空标题/空正文的兜底文案必须自解释（并提到 kind）
 *   §F 提问不假冒按钮（答案不是二元的）
 *   §G 未知平台退化成最保守一档，且不抛异常
 *   §H 返回对象永远没有 undefined 字段
 *   §I 模块是纯的 + preload/main 的接线真的在（否则测试全绿也可能一条通知都发不出）
 *   §J 托盘 tooltip 文案（连接状态 + 待审批数）与托盘菜单三项
 *   §K 窗口状态记忆：屏幕拔掉 → 坐标越界 → 回落居中（绝不恢复到屏幕外）
 *   §L 通知深链：eventId / allow / kind / sessionId 透传，且 allow=null 不被压成 false
 *   §M 单实例唤回：隐藏 → show、最小化 → restore，最后 focus
 *   §N 新逻辑的接线（托盘状态通道、窗口状态落盘、深链两侧一致）
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 被测模块是 **CommonJS 纯模块**（不 require('electron')），
// 所以这里用 createRequire 直接 require —— 这正是它必须无依赖的原因。
const require = createRequire(import.meta.url);
const { buildNotificationOptions, MAX_BODY_CHARS } = require('../electron/notification-options.cjs');
// 桌面壳状态模块：同样必须无依赖，否则本文件就得有显示器才能跑。
const {
  DEFAULT_WINDOW,
  MIN_VISIBLE_PX,
  WINDOW_STATE_FILE,
  buildApprovalAction,
  buildRelayStatusText,
  buildTrayMenuModel,
  isBoundsVisible,
  normalizeDeepLink,
  normalizeRelayStatus,
  parseWindowStateFile,
  planWindowReveal,
  resolveWindowState,
  serializeWindowState,
} = require('../electron/desktop-state.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.join(HERE, '..', 'electron');

/**
 * 一块 1920×1080 主屏（workArea 已排除任务栏）。
 * 用**固定几何**而不是去问系统，是因为本文件必须在无显示器环境下跑出确定结果。
 */
const PRIMARY_1080P = { isPrimary: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
const DISPLAYS_1080P = [PRIMARY_1080P];
/** 主屏 + 右侧副屏（副屏上的窗口不许被当成「越界」）。 */
const DISPLAYS_DUAL = [
  PRIMARY_1080P,
  { isPrimary: false, workArea: { x: 1920, y: 0, width: 1920, height: 1080 } },
];

// ── 极简断言（与 test-markdown.mjs / test-approval-contract.mjs 同风格）──────

let passed = 0;
const failures = [];

function check(group, name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ group, name, message: err.message });
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? 'not equal'}\n    expected: ${e}\n    actual:   ${a}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg ?? 'expected truthy');
}

/** 期望的完整字段集：多一个少一个都算契约漂移。 */
const OPTION_KEYS = [
  'actions',
  'body',
  'focusOnClick',
  'hasActions',
  'silent',
  'sound',
  'title',
];

// ── §A macOS 审批：有按钮，且必须出声 ───────────────────────────────────────

const macApproval = buildNotificationOptions({
  title: '需要授权：Bash',
  body: 'rm -rf ./tmp/build',
  kind: 'approval',
  platform: 'darwin',
});

check('A', 'macOS 审批交上 2 个按钮（允许一次 / 拒绝）', () => {
  eq(macApproval.actions.length, 2, 'macOS 是最多 2 个可用按钮，交 2 个');
  eq(
    macApproval.actions.map((a) => a.type),
    ['button', 'button'],
    'Electron 的 actions 项必须是 {type:"button"}',
  );
  eq(
    macApproval.actions.map((a) => a.text),
    ['允许一次', '拒绝'],
    '顺序是协议的一部分：index 0 = 允许，index 1 = 拒绝（main.cjs 按索引判定）',
  );
});

check('A', 'macOS 审批 hasActions=true 且不静音', () => {
  eq(macApproval.hasActions, true);
  eq(
    macApproval.silent,
    false,
    '静音的审批 = 错过的授权：这是唯一必须出声的通知类',
  );
  eq(macApproval.focusOnClick, true, '点通知正文仍要回到窗口');
  ok(macApproval.sound === 'default', 'macOS 上明确指定提示音');
});

check('A', 'actions 是深拷贝：调用方改文案不会污染模块常量', () => {
  const first = buildNotificationOptions({ kind: 'approval', platform: 'darwin' });
  first.actions[0].text = '被改坏了';
  const second = buildNotificationOptions({ kind: 'approval', platform: 'darwin' });
  eq(second.actions[0].text, '允许一次', '第二次构造拿到了被改污染的按钮文案');
});

// ── §B Windows 审批：Electron 没有按钮实现，必须靠点击回窗口 ─────────────────

const winApproval = buildNotificationOptions({
  title: '需要授权',
  body: 'git push --force',
  kind: 'approval',
  platform: 'win32',
});

check('B', 'win32 审批不交按钮（Electron 未实现 actions），靠 focusOnClick', () => {
  eq(winApproval.actions, [], 'Windows 上交 actions 也不会显示按钮，只会误导调用方');
  eq(winApproval.hasActions, false, 'hasActions 必须如实为 false —— 否则 UI 会写「在通知上点允许」');
  eq(winApproval.focusOnClick, true, '没有按钮时，点击回窗口是用户唯一的决定入口');
});

check('B', 'win32 审批同样必须出声', () => {
  eq(winApproval.silent, false, 'Windows 上静音同样等于错过授权');
  eq(winApproval.sound, null, 'sound 是 macOS 专属字段，Windows 上不传');
});

// ── §C Linux 审批：同 Windows ──────────────────────────────────────────────

const linuxApproval = buildNotificationOptions({
  title: '需要授权',
  body: 'systemctl restart nginx',
  kind: 'approval',
  platform: 'linux',
});

check('C', 'linux 审批不交按钮，靠 focusOnClick', () => {
  eq(linuxApproval.actions, []);
  eq(linuxApproval.hasActions, false);
  eq(linuxApproval.focusOnClick, true);
  eq(linuxApproval.silent, false);
});

// ── §D 正文 180 字符截断 ───────────────────────────────────────────────────

check('D', '超长正文被截断到 180 字符并以 … 结尾', () => {
  const long = 'x'.repeat(500);
  const o = buildNotificationOptions({ body: long, kind: 'approval', platform: 'win32' });
  eq(o.body.length, MAX_BODY_CHARS, `正文必须正好截到 ${MAX_BODY_CHARS} 字符（Windows toast 会截断）`);
  ok(o.body.endsWith('\u2026'), '截断必须加省略号，让用户知道「后面还有」');
  eq(o.body, 'x'.repeat(MAX_BODY_CHARS - 1) + '\u2026', '保留的是**开头**：工具名/路径在最前面');
});

check('D', '正好 180 字符不加省略号（边界不许误伤）', () => {
  const exact = 'y'.repeat(MAX_BODY_CHARS);
  const o = buildNotificationOptions({ body: exact, kind: 'approval', platform: 'linux' });
  eq(o.body, exact, '刚好等于上限时不该截断');
});

check('D', '181 字符必须截断（差一个字符也要截）', () => {
  const o = buildNotificationOptions({
    body: 'z'.repeat(MAX_BODY_CHARS + 1),
    kind: 'approval',
    platform: 'linux',
  });
  eq(o.body.length, MAX_BODY_CHARS);
  ok(o.body.endsWith('\u2026'));
});

check('D', '截断按码点进行，不劈开 emoji（不产生半个代理对）', () => {
  const o = buildNotificationOptions({
    body: '\u{1F600}'.repeat(300),
    kind: 'approval',
    platform: 'darwin',
  });
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  ok(!loneSurrogate.test(o.body), '正文里出现了孤立代理对 —— 界面上会是乱码方块');
  ok(Array.from(o.body).length <= MAX_BODY_CHARS, '按码点算也不得超过上限');
  ok(o.body.endsWith('\u2026'));
});

// ── §E 空标题 / 空正文的兜底文案 ────────────────────────────────────────────

for (const kind of ['approval', 'question']) {
  check('E', `${kind}：空标题 + 空正文 → 非空兜底且提到 kind`, () => {
    const o = buildNotificationOptions({ title: '', body: '', kind, platform: 'linux' });
    ok(o.title.trim() !== '', '标题为空的通知在部分平台不显示');
    ok(o.body.trim() !== '', '正文为空的通知在部分平台会被**整条丢弃**');
    ok(o.title.includes(kind), `兜底标题必须提到 kind（实际：${o.title}）`);
    ok(o.body.includes(kind), `兜底正文必须提到 kind（实际：${o.body}）`);
  });
}

check('E', '缺失字段（undefined/null/数字/对象）同样走兜底，不抛异常', () => {
  for (const bad of [undefined, null, 0, false, {}, [], '   ']) {
    const o = buildNotificationOptions({ title: bad, body: bad, kind: 'approval', platform: 'win32' });
    ok(typeof o.title === 'string' && o.title.trim() !== '', `title=${JSON.stringify(bad)} 时兜底失败`);
    ok(typeof o.body === 'string' && o.body.trim() !== '', `body=${JSON.stringify(bad)} 时兜底失败`);
  }
  // 连 input 本身都不是对象时也不能崩（渲染进程传什么都可能）
  for (const noInput of [undefined, null, 42, 'approval', []]) {
    const o = buildNotificationOptions(noInput);
    ok(typeof o.title === 'string' && o.title.trim() !== '');
    ok(typeof o.body === 'string' && o.body.trim() !== '');
  }
});

check('E', '只缺一个字段时只兜底那一个（不覆盖用户给的好数据）', () => {
  const o = buildNotificationOptions({ title: '需要授权：Write', body: '   ', kind: 'approval', platform: 'linux' });
  eq(o.title, '需要授权：Write', '标题给了就不能被兜底覆盖');
  ok(o.body.trim() !== '', '空正文必须兜底');
});

// ── §F 提问：不假冒按钮 ────────────────────────────────────────────────────

check('F', 'question 在三个平台上都不声称有按钮', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const o = buildNotificationOptions({ title: '选择部署目标', body: 'A / B / C', kind: 'question', platform });
    eq(o.hasActions, false, `${platform}: 提问的答案不是二元的，两个通用按钮会**编造**用户的选择`);
    eq(o.actions, [], `${platform}: 不得交按钮`);
  }
});

check('F', 'question 不静音但要靠点击回窗口作答', () => {
  const o = buildNotificationOptions({ kind: 'question', platform: 'win32' });
  eq(o.focusOnClick, true, '提问必须把用户带回应用内');
  ok(typeof o.silent === 'boolean', 'silent 必须有明确取值');
  eq(o.sound, null, '非审批不额外指定声音');
});

// ── §G 未知平台：退化成最保守一档 ──────────────────────────────────────────

check('G', '未知平台（freebsd）退化为无按钮且不抛异常', () => {
  const o = buildNotificationOptions({ title: 'T', body: 'B', kind: 'approval', platform: 'freebsd' });
  eq(o.actions, [], '未知平台不得假装有按钮');
  eq(o.hasActions, false);
  eq(o.focusOnClick, true, '未知平台也必须留一条回窗口的路');
  ok(o.body.trim() !== '' && o.title.trim() !== '');
});

check('G', 'platform 缺失/非法类型退化为无按钮且不抛异常', () => {
  for (const platform of [undefined, null, '', 0, {}, [], 'WIN32', 'Darwin']) {
    const o = buildNotificationOptions({ title: 'T', body: 'B', kind: 'approval', platform });
    eq(o.hasActions, false, `platform=${JSON.stringify(platform)} 时不得声称有按钮`);
    eq(o.actions, []);
  }
});

check('G', '未知 kind 退化为 approval（宁可多响，不可漏批）', () => {
  const o = buildNotificationOptions({ title: 'T', body: 'B', kind: 'notify', platform: 'darwin' });
  eq(o.hasActions, true, '未知 kind 应按 approval 处理：审批是绝不能漏的那一类');
  eq(o.silent, false);
});

// ── §H 字段完备性：永远没有 undefined ──────────────────────────────────────

check('H', '所有输入的返回对象字段集固定、无 undefined、类型正确', () => {
  const matrix = [
    undefined,
    {},
    { kind: 'approval', platform: 'darwin' },
    { kind: 'approval', platform: 'win32' },
    { kind: 'approval', platform: 'linux' },
    { kind: 'question', platform: 'darwin' },
    { kind: 'question', platform: 'freebsd' },
    { title: 1, body: null, kind: 2, platform: 3 },
    { title: 'x'.repeat(400), body: 'y'.repeat(400), kind: 'approval', platform: 'darwin' },
  ];

  for (const input of matrix) {
    const o = buildNotificationOptions(input);
    const label = JSON.stringify(input) ?? 'undefined';

    eq(Object.keys(o).sort(), OPTION_KEYS, `输入 ${label} 的字段集漂移了`);

    for (const key of OPTION_KEYS) {
      ok(o[key] !== undefined, `字段 ${key} 是 undefined（输入 ${label}）—— Electron 会静默丢弃该通知`);
      ok(o[key] !== null || key === 'sound', `字段 ${key} 意外为 null（输入 ${label}）`);
    }

    eq(typeof o.title, 'string');
    eq(typeof o.body, 'string');
    ok(Array.isArray(o.actions));
    eq(typeof o.hasActions, 'boolean');
    eq(typeof o.silent, 'boolean');
    eq(typeof o.focusOnClick, 'boolean');
    ok(o.sound === null || typeof o.sound === 'string', 'sound 必须是字符串或 null（绝不允许 undefined）');

    // 反过来的护栏：有按钮就必须 hasActions，没按钮就必须没有 —— 两者不许打架
    eq(o.hasActions, o.actions.length > 0, `hasActions 与 actions 不一致（输入 ${label}）`);
  }
});

// ── §I 接线检查：模块是纯的，且 preload/main 真的接上了 ────────────────────
//
// 上面全是纯逻辑断言 —— 全绿也可能「一条通知都发不出去」：
// 只要 main.cjs 没挂 preload、或通道名两边不一致。
// 这几种失败**没有运行时报错**，所以只能在这里静态钉住。

const optionsSource = readFileSync(path.join(ELECTRON_DIR, 'notification-options.cjs'), 'utf8');
const stateSource = readFileSync(path.join(ELECTRON_DIR, 'desktop-state.cjs'), 'utf8');
const preloadSource = readFileSync(path.join(ELECTRON_DIR, 'preload.cjs'), 'utf8');
const mainSource = readFileSync(path.join(ELECTRON_DIR, 'main.cjs'), 'utf8');

/**
 * 扫描**代码**、排除注释：这些文件的注释本来就在解释「不要 require electron」，
 * 拿注释当违规来报会把护栏变成噪音（同 test-approval-contract.mjs 的做法）。
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

check('I', 'notification-options.cjs 是纯模块（不依赖 electron）', () => {
  const code = stripComments(optionsSource);
  ok(
    !/require\(\s*['"]electron['"]\s*\)/.test(code),
    'notification-options.cjs 一旦 require electron，这组测试就必须有显示器才能跑',
  );
  ok(!/from\s+['"]electron['"]/.test(code), 'notification-options.cjs 不得 import electron');
  ok(
    /module\.exports\s*=\s*buildNotificationOptions/.test(code),
    '必须导出 buildNotificationOptions',
  );
});

check('I', 'preload 用 contextBridge 暴露 dshDesktop，且隔离设置未被削弱', () => {
  // 扫**去掉注释的代码**：把 preload 那行注释掉正是最像「已经接好了」的假修复，
  // 拿原文扫描会被注释里一模一样的一行骗过去（本测试自己就踩过这个坑）。
  const code = stripComments(mainSource);
  ok(/contextBridge\.exposeInMainWorld\(\s*['"]dshDesktop['"]/.test(preloadSource), '未暴露 window.dshDesktop');
  ok(/nodeIntegration:\s*false/.test(code), 'nodeIntegration 必须保持 false');
  ok(/contextIsolation:\s*true/.test(code), 'contextIsolation 必须保持 true');
  ok(
    /preload:\s*path\.join\(__dirname,\s*['"]preload\.cjs['"]\)/.test(code),
    'main.cjs 没挂 preload —— 此时 window.dshDesktop 只是 undefined，调用方「不报错也不弹通知」',
  );
});

check('I', '上行/下行通道名在两侧逐字一致', () => {
  const channels = [
    'dsh:notify-approval',
    'dsh:approval-action',
    'dsh:relay-status',
    'dsh:relay-reconnect',
  ];
  for (const channel of channels) {
    ok(preloadSource.includes(`'${channel}'`), `preload.cjs 缺少通道 ${channel}`);
    ok(mainSource.includes(`'${channel}'`), `main.cjs 缺少通道 ${channel}（通道名写错 = 静默丢弃）`);
  }
  ok(/ipcRenderer\.send\(\s*NOTIFY_CHANNEL\s*,/.test(preloadSource), 'preload 未通过 ipcRenderer.send 上行');
  ok(/ipcRenderer\.on\(\s*APPROVAL_ACTION_CHANNEL\s*,/.test(preloadSource), 'preload 未订阅下行');
  ok(
    /ipcRenderer\.removeListener\(\s*APPROVAL_ACTION_CHANNEL\s*,/.test(preloadSource),
    'onApprovalAction 必须返回可用的 unsubscribe（否则 effect 重跑会累积监听器）',
  );
});

check('I', 'main.cjs 有 ipc 监听、isSupported 保护、派发日志与 click/action 处理', () => {
  const code = stripComments(mainSource);
  ok(/ipcMain\.on\(\s*NOTIFY_CHANNEL\s*,/.test(code), 'main.cjs 没有监听通知请求');
  ok(/Notification\.isSupported\(\)/.test(code), '必须先探测 Notification.isSupported()');
  ok(/\[notify\] kind=/.test(code), '缺少派发日志 —— 静默失败时用户无从判断通知路径是否跑过');
  ok(/notification\.on\(\s*['"]click['"]/.test(code), '没有处理通知点击');
  ok(/notification\.on\(\s*['"]action['"]/.test(code), '没有处理 macOS 按钮动作');
  ok(/win\.show\(\)/.test(code) && /win\.focus\(\)/.test(code), '点击通知必须先 show+focus（窗口通常藏在托盘里）');
});

check('I', '决定语义正确：click=null（只聚焦）、action#0=允许、action#1=拒绝', () => {
  const code = stripComments(mainSource);
  ok(
    /notification\.on\(\s*['"]click['"][\s\S]{0,60}?finish\(\s*null/.test(code),
    'click 无 action index 时必须送 allow=null —— 否则「点了一下通知」会被当成「同意授权」',
  );
  ok(/index === 0\s*\)\s*finish\(\s*true/.test(code), 'macOS action index 0 必须是 allow=true');
  ok(/index === 1\s*\)\s*finish\(\s*false/.test(code), 'macOS action index 1 必须是 allow=false');
  // 负载现在由纯函数 buildApprovalAction 构造（多带 kind/sessionId），
  // 所以这里钉的是「决定确实带着 eventId+allow 回送」这件事，而不是某个字面量。
  ok(
    /sendToRenderer\(\s*win,\s*APPROVAL_ACTION_CHANNEL\s*,\s*actionPayload\s*\)/.test(code),
    '决定必须带着 eventId 与 allow（且 allow 允许为 null）回送渲染进程',
  );
  ok(
    /buildApprovalAction\(\s*\{\s*eventId,\s*allow,\s*kind,\s*sessionId\s*\}\s*\)/.test(code),
    '决定负载必须由 buildApprovalAction 构造并带上深链字段（kind/sessionId）',
  );
});

check('I', 'main.cjs 保留了常驻行为（未回退成关窗即退出）', () => {
  const code = stripComments(mainSource);
  ok(/window-all-closed/.test(code), 'window-all-closed 处理器必须存在');
  ok(
    !/app\.on\(\s*['"]window-all-closed['"]\s*,\s*\(\s*\)\s*=>\s*\{?\s*app\.quit\(\)/.test(code),
    'window-all-closed 里不得再 app.quit()（关窗即退出会让核心能力失效）',
  );
  ok(/before-quit/.test(code), 'before-quit 标记必须保留，否则退出时会被 close 拦截');
  ok(/requestSingleInstanceLock/.test(code), '单实例锁必须保留');
});

// ── §J 托盘状态：tooltip 文案 + 菜单三项 ────────────────────────────────────
//
// 常驻应用的用户大部分时间不看窗口，tooltip 是唯一常年在屏幕上的状态面。
// 它写错了不会报错 —— 只是「永远显示错的连接状态」，所以这里逐字钉死。

check('J', 'tooltip 已连接：带主机与待审批数', () => {
  eq(
    buildRelayStatusText({ connected: true, host: '192.168.1.8:8787', pending: 3 }),
    'DSH 远程控制 · 已连接 · 192.168.1.8:8787 · 待审批 3',
  );
});

check('J', 'tooltip 断线/缺字段：只报「未连接」，不编造主机与数字', () => {
  eq(buildRelayStatusText(null), 'DSH 远程控制 · 未连接');
  eq(buildRelayStatusText(undefined), 'DSH 远程控制 · 未连接');
  eq(buildRelayStatusText({}), 'DSH 远程控制 · 未连接');
  eq(buildRelayStatusText({ connected: true, host: '   ', pending: 0 }), 'DSH 远程控制 · 已连接');
});

check('J', 'tooltip 未连接时照实显示待审批数（这类事件已经收到了，不该替用户吞掉）', () => {
  eq(
    buildRelayStatusText({ connected: false, pending: 2 }),
    'DSH 远程控制 · 未连接 · 待审批 2',
  );
});

check('J', '非法 pending / host 不产生 NaN 文案', () => {
  for (const bad of [NaN, Infinity, -Infinity, -5, '3', null, {}, [], true]) {
    eq(normalizeRelayStatus({ connected: true, pending: bad }).pending, 0, `pending=${String(bad)} 必须归一化成 0`);
    ok(!buildRelayStatusText({ connected: true, pending: bad }).includes('NaN'));
  }
  eq(normalizeRelayStatus({ connected: true, pending: 4.9 }).pending, 4, '待审批数必须是整数');
  eq(normalizeRelayStatus({ connected: true, host: 42 }).host, '', '非字符串 host 不得进 tooltip');
  eq(normalizeRelayStatus(null), { connected: false, host: '', pending: 0 });
});

check('J', '托盘菜单固定三项（显示主窗口 / 重新连接 / 退出），且每次返回新对象', () => {
  const model = buildTrayMenuModel();
  eq(model.map((item) => item.id), ['show', 'reconnect', 'quit']);
  eq(model.map((item) => item.label), ['显示主窗口', '重新连接', '退出']);
  model[0].label = '被改坏了';
  eq(buildTrayMenuModel()[0].label, '显示主窗口', '菜单模型被改坏后第二次构造拿到了污染值');
});

// ── §K 窗口状态记忆：屏幕拔掉后坐标越界必须回落 ─────────────────────────────
//
// 这条链路的失败模式最隐蔽：窗口**存在**、托盘**有**图标、进程**活着**，
// 但它被恢复到一块已经不存在的屏幕上 —— 用户看到的只有「这个程序坏了」。

check('K', '屏内几何原样恢复（位置不变）', () => {
  const resolved = resolveWindowState(
    { bounds: { x: 100, y: 60, width: 500, height: 800 }, maximized: false },
    DISPLAYS_1080P,
    DEFAULT_WINDOW,
  );
  eq(resolved.restored, true);
  eq(resolved.reason, 'restored');
  eq(resolved.maximized, false);
  eq(resolved.bounds, { x: 100, y: 60, width: 500, height: 800 });
});

check('K', '屏幕被拔掉（坐标 99999）→ 回落主屏居中，绝不恢复到屏幕外', () => {
  const resolved = resolveWindowState(
    { bounds: { x: 99999, y: 99999, width: 440, height: 920 } },
    DISPLAYS_1080P,
    DEFAULT_WINDOW,
  );
  eq(resolved.restored, false, '越界坐标不许被当成「可恢复」');
  eq(resolved.reason, 'out-of-bounds');
  eq(resolved.maximized, false, '回落后不得再假装最大化');
  eq(resolved.bounds, { x: 740, y: 80, width: 440, height: 920 });
  ok(isBoundsVisible(resolved.bounds, DISPLAYS_1080P), '回落结果必须落在屏幕内');
  ok(Math.abs(resolved.bounds.x + resolved.bounds.width / 2 - 960) <= 1, '必须水平居中');
  ok(Math.abs(resolved.bounds.y + resolved.bounds.height / 2 - 540) <= 1, '必须垂直居中');
});

check('K', '左侧屏幕消失（负坐标越界）→ 同样回落', () => {
  const resolved = resolveWindowState(
    { bounds: { x: -3000, y: 40, width: 440, height: 920 } },
    DISPLAYS_1080P,
    DEFAULT_WINDOW,
  );
  eq(resolved.reason, 'out-of-bounds');
  ok(isBoundsVisible(resolved.bounds, DISPLAYS_1080P));
});

check('K', '副屏还在时不许误判越界（双屏用户的位置必须记得住）', () => {
  const resolved = resolveWindowState(
    { bounds: { x: 2000, y: 100, width: 440, height: 920 } },
    DISPLAYS_DUAL,
    DEFAULT_WINDOW,
  );
  eq(resolved.restored, true, '副屏上的窗口是正常使用状态，不是越界');
  eq(resolved.bounds.x, 2000);
});

check('K', '可见性边界：刚好露 80px 算可见，露 79px 算丢了', () => {
  ok(isBoundsVisible({ x: 1920 - MIN_VISIBLE_PX, y: 0, width: 440, height: 920 }, DISPLAYS_1080P));
  ok(!isBoundsVisible({ x: 1920 - MIN_VISIBLE_PX + 1, y: 0, width: 440, height: 920 }, DISPLAYS_1080P));
  ok(
    !isBoundsVisible({ x: 0, y: 1080, width: 440, height: 920 }, DISPLAYS_1080P),
    '整窗在屏幕下方 → 不可见',
  );
});

check('K', '没有任何显示器信息 → 交给系统居中（绝不猜 0,0）', () => {
  for (const displays of [[], null, undefined, 'junk']) {
    const resolved = resolveWindowState(
      { bounds: { x: 10, y: 10, width: 440, height: 920 } },
      displays,
      DEFAULT_WINDOW,
    );
    eq(resolved.bounds, null, '不知道屏幕在哪就不许编坐标');
    eq(resolved.reason, 'no-display');
    eq(resolved.restored, false);
  }
});

check('K', '尺寸被夹取：小于最小尺寸抬高，大于工作区压低', () => {
  const tiny = resolveWindowState(
    { bounds: { x: 10, y: 10, width: 100, height: 100 } },
    DISPLAYS_1080P,
    DEFAULT_WINDOW,
  );
  eq(tiny.restored, true);
  eq(tiny.bounds.width, DEFAULT_WINDOW.minWidth, '太小的窗口用户抓不住，必须抬到最小宽度');
  eq(tiny.bounds.height, DEFAULT_WINDOW.minHeight);

  const huge = resolveWindowState(
    { bounds: { x: 0, y: 0, width: 5000, height: 3000 } },
    DISPLAYS_1080P,
    DEFAULT_WINDOW,
  );
  eq(huge.bounds.width, 1920, '比屏幕还大的窗口同样会让用户抓不住');
  eq(huge.bounds.height, 1080);
});

check('K', '损坏 / 非法状态文件 → 当「没有记忆」处理，绝不抛异常', () => {
  const corrupt = [
    '',
    '   ',
    '{oops',
    'null',
    '[]',
    '42',
    '{"bounds":{"x":"10","y":1,"width":440,"height":920}}',
    '{"bounds":{"x":1,"y":1,"width":0,"height":920}}',
  ];
  for (const text of corrupt) {
    eq(parseWindowStateFile(text), null, `损坏内容必须被当成「没有记忆」：${text}`);
  }
  eq(parseWindowStateFile(null), null);
  eq(parseWindowStateFile(123), null);

  const invalid = resolveWindowState({ bounds: 'nope' }, DISPLAYS_1080P, DEFAULT_WINDOW);
  eq(invalid.reason, 'invalid-saved-state');
  ok(isBoundsVisible(invalid.bounds, DISPLAYS_1080P));
  eq(resolveWindowState(null, DISPLAYS_1080P, DEFAULT_WINDOW).reason, 'no-saved-state');
});

check('K', '序列化 round-trip：坐标取整、maximized 保留、非法输入返回空串', () => {
  const text = serializeWindowState({ x: 12.4, y: -8.6, width: 440, height: 920 }, true);
  const back = parseWindowStateFile(text);
  eq(back.bounds, { x: 12, y: -9, width: 440, height: 920 });
  eq(back.maximized, true);
  eq(
    parseWindowStateFile(serializeWindowState({ x: 1, y: 1, width: 440, height: 920 }, false)).maximized,
    false,
  );
  eq(serializeWindowState(null, false), '', '非法几何不许写盘');
  eq(serializeWindowState({ x: 0, y: 0, width: 0, height: 0 }, false), '');
  eq(WINDOW_STATE_FILE, 'window-state.json', '文件名是 main.cjs 与测试共同依赖的契约');
});

// ── §L 通知深链：四字段透传，且三态 allow 不被压成布尔 ──────────────────────

check('L', '深链四字段透传（eventId / allow / kind / sessionId）', () => {
  eq(
    buildApprovalAction({ eventId: 'ev-1', allow: true, kind: 'approval', sessionId: 'sess-9' }),
    { eventId: 'ev-1', allow: true, kind: 'approval', sessionId: 'sess-9' },
  );
  eq(
    buildApprovalAction({ eventId: 'ev-2', allow: false, kind: 'question', sessionId: 'sess-2' }),
    { eventId: 'ev-2', allow: false, kind: 'question', sessionId: 'sess-2' },
  );
});

check('L', 'allow=null（只点了一下通知）不许被压成 false', () => {
  const clicked = buildApprovalAction({
    eventId: 'ev-3',
    allow: null,
    kind: 'approval',
    sessionId: 's',
  });
  eq(clicked.allow, null, 'null 表示「只聚焦窗口、待办保持可见」；压成 false 等于用户没决定却被拒了');
  ok(clicked.allow !== false);
  eq(buildApprovalAction({ eventId: 'ev-3' }).allow, null, '缺 allow 同样按 null（只聚焦）处理');
});

check('L', 'eventId 非法 → 整条负载作废（说不清批哪一条就不批）', () => {
  for (const bad of [null, undefined, {}, '', '   ', 42, [], { eventId: {} }, { eventId: '  ' }]) {
    eq(buildApprovalAction(bad), null, `eventId=${JSON.stringify(bad)} 必须作废`);
  }
});

check('L', 'kind / sessionId 归一化：未知 kind 按 approval，空 sessionId 变 null', () => {
  eq(normalizeDeepLink({ eventId: '  ev-4  ', kind: 'nope', sessionId: '  s-4  ' }), {
    eventId: 'ev-4',
    kind: 'approval',
    sessionId: 's-4',
  });
  eq(normalizeDeepLink({ eventId: 'ev-4', sessionId: '   ' }).sessionId, null, '空串会骗过 if(sessionId)');
  eq(normalizeDeepLink({ eventId: 'ev-4' }).sessionId, null);
  eq(buildApprovalAction({ eventId: 'ev-4', kind: 'question' }).kind, 'question');
});

check('L', '向后兼容：只给 eventId/allow 的老调用仍拿到完整四字段负载', () => {
  const legacy = buildApprovalAction({ eventId: 'ev-5', allow: false });
  eq(Object.keys(legacy).sort(), ['allow', 'eventId', 'kind', 'sessionId']);
  eq(legacy.eventId, 'ev-5');
  eq(legacy.allow, false);
  eq(legacy.kind, 'approval');
  eq(legacy.sessionId, null);
});

// ── §M 单实例唤回：隐藏 → show、最小化 → restore ────────────────────────────
//
// 窗口「关掉」只是 hide（常驻设计），所以第二个实例启动时窗口**依然存在**。
// 旧逻辑只 createWindow()（内部 show+focus），最小化的窗口 show 完用户依然看不见，
// 观感就是「双击图标没反应」。

check('M', '窗口被隐藏 → 先 show 再 focus', () => {
  eq(planWindowReveal({ visible: false, minimized: false, destroyed: false }), ['show', 'focus']);
});

check('M', '窗口最小化 → restore 必须发生，且在 focus 之前', () => {
  const plan = planWindowReveal({ visible: false, minimized: true, destroyed: false });
  eq(plan, ['show', 'restore', 'focus']);
  ok(plan.indexOf('restore') < plan.indexOf('focus'), '先 focus 再 restore 等于把用户丢回最小化窗口');
  eq(
    planWindowReveal({ visible: true, minimized: true }),
    ['restore', 'focus'],
    '部分平台对最小化窗口 isVisible() 仍为 true，所以两个判断必须独立',
  );
});

check('M', '窗口已可见且未最小化 → 只 focus（不重复 show，避免窗口闪烁）', () => {
  eq(planWindowReveal({ visible: true, minimized: false }), ['focus']);
});

check('M', '窗口已销毁 → 重建（此时对旧窗口 show 是空操作）', () => {
  eq(planWindowReveal({ destroyed: true }), ['create']);
  eq(planWindowReveal({ destroyed: true, visible: false, minimized: true }), ['create']);
});

check('M', '非法状态输入不抛异常，且永远给出一条聚焦路径', () => {
  for (const bad of [undefined, null, 0, 'x', [], true]) {
    const plan = planWindowReveal(bad);
    ok(Array.isArray(plan), '必须返回数组');
    ok(plan.includes('focus'), `输入 ${JSON.stringify(bad)} 时至少要 focus`);
  }
});

// ── §N 新逻辑的接线：纯函数再好，没接上等于没有 ─────────────────────────────

check('N', 'desktop-state.cjs 是纯模块（不 require electron）', () => {
  const code = stripComments(stateSource);
  ok(
    !/require\(\s*['"]electron['"]\s*\)/.test(code),
    'desktop-state.cjs 一旦 require electron，这组测试就必须有显示器才能跑',
  );
  ok(!/from\s+['"]electron['"]/.test(code), 'desktop-state.cjs 不得 import electron');
  ok(/module\.exports\s*=/.test(code), '必须导出可测函数');
});

check('N', '托盘：tooltip 跟着上报更新，菜单来自纯模型且三项都有处理函数', () => {
  const code = stripComments(mainSource);
  ok(
    /ipcMain\.on\(\s*RELAY_STATUS_CHANNEL\s*,/.test(code),
    'main.cjs 没监听连接状态上报 → tooltip 永远停在初始文案',
  );
  ok(
    /relayStatus\s*=\s*normalizeRelayStatus\(\s*payload\s*\)/.test(code),
    '状态必须经纯函数归一化（负载不可信）',
  );
  ok(/tray\.setToolTip\(\s*buildRelayStatusText\(/.test(code), 'tooltip 必须由 buildRelayStatusText 生成');
  ok(/Menu\.buildFromTemplate\(\s*template\s*\)/.test(code), '托盘菜单必须真的建出来');
  ok(/buildTrayMenuModel\(\)/.test(code), '菜单项必须来自纯模型（可测）');
  for (const id of ['show', 'reconnect', 'quit']) {
    ok(new RegExp(`^\\s*${id}:\\s*\\(`, 'm').test(code), `菜单项 ${id} 没有处理函数`);
  }
  ok(
    /sendToRenderer\(\s*win,\s*RELAY_RECONNECT_CHANNEL\s*,/.test(code),
    '「重新连接」必须经 IPC 通知渲染进程（主进程不自己重连）',
  );
});

check('N', '单实例与 macOS activate 都必须唤回（不是只 createWindow）', () => {
  const code = stripComments(mainSource);
  ok(
    /app\.on\(\s*['"]second-instance['"][\s\S]{0,400}?revealWindow\(\)/.test(code),
    'second-instance 必须走 revealWindow（隐藏/最小化的窗口才回得来）',
  );
  ok(
    /app\.on\(\s*['"]activate['"][\s\S]{0,400}?revealWindow\(\)/.test(code),
    'macOS 点 Dock 图标同样要唤回隐藏/最小化的窗口',
  );
  ok(
    /function\s+applyRevealPlan\(/.test(code) && /planWindowReveal\(/.test(code),
    'show/restore/focus 的顺序必须由纯函数 planWindowReveal 决定',
  );
});

check('N', '窗口状态持久化接线：读 userData、校验越界、防抖落盘、退出前强制保存', () => {
  const code = stripComments(mainSource);
  ok(/app\.getPath\(\s*['"]userData['"]\s*\)/.test(code), '状态必须写在 userData 下');
  ok(/WINDOW_STATE_FILE/.test(code), '文件名必须用共享常量（写错就是永远读不到旧状态）');
  ok(/screen\.getAllDisplays\(\)/.test(code), '必须按当前真实显示器校验保存的坐标');
  ok(/resolveWindowState\(/.test(code), '建窗前必须过纯函数做越界判定');
  ok(/parseWindowStateFile\(/.test(code), '损坏的状态文件必须被安全解析');
  ok(/serializeWindowState\(/.test(code), '写盘内容必须由纯函数生成');
  ok(/win\.on\(\s*['"]resize['"]\s*,\s*scheduleWindowStateSave\)/.test(code), 'resize 要落盘');
  ok(/win\.on\(\s*['"]move['"]\s*,\s*scheduleWindowStateSave\)/.test(code), 'move 要落盘');
  ok(/getNormalBounds\(\)/.test(code), '最大化时必须存 getNormalBounds，否则还原尺寸丢失');
  ok(/if\s*\(\s*resolved\.maximized\s*\)\s*win\.maximize\(\)/.test(code), '记住的最大化状态要还原');
  ok(
    /before-quit[\s\S]{0,300}?persistWindowState\(\)/.test(code),
    '退出前必须强制落盘（防抖定时器可能还没触发）',
  );
});

check('N', '深链两侧一致：上行带 sessionId，下行透传 kind/sessionId', () => {
  const code = stripComments(mainSource);
  ok(/normalizeDeepLink\(\s*rawPayload\s*\)/.test(code), '主进程必须归一化深链字段');
  ok(
    /const\s*\{\s*eventId,\s*kind,\s*sessionId\s*\}\s*=\s*link/.test(code),
    'eventId / kind / sessionId 必须一起取出来用',
  );
  ok(/buildNotificationOptions\(\{[\s\S]{0,200}?kind\s*,/.test(code), 'kind 仍要进通知选项（提问与审批行为不同）');

  const preloadCode = stripComments(preloadSource);
  ok(/sessionId/.test(preloadCode), 'preload 上行必须带上 sessionId');
  ok(/sessionId\s*:/.test(preloadCode), 'preload 下行必须回传 sessionId');
  ok(
    /ipcRenderer\.send\(\s*RELAY_STATUS_CHANNEL\s*,/.test(preloadCode),
    'preload 必须真的把状态发出去',
  );
  ok(/ipcRenderer\.on\(\s*RELAY_RECONNECT_CHANNEL\s*,/.test(preloadCode), 'preload 必须订阅重连请求');
  ok(
    /ipcRenderer\.removeListener\(\s*RELAY_RECONNECT_CHANNEL\s*,/.test(preloadCode),
    'onReconnectRequest 必须返回可用的 unsubscribe',
  );
  ok(
    /reportRelayStatus\(/.test(preloadCode) && /onReconnectRequest\(/.test(preloadCode),
    '两个新成员必须暴露在 window.dshDesktop 上',
  );
});

check('N', '常驻行为未回退：托盘常驻、关窗隐藏、window-all-closed 不退出', () => {
  const code = stripComments(mainSource);
  ok(/new Tray\(/.test(code), '托盘必须还在');
  ok(/tray\.setContextMenu\(/.test(code), '托盘必须有菜单（否则用户退不掉，只能杀进程）');
  ok(/event\.preventDefault\(\)[\s\S]{0,200}?win\.hide\(\)/.test(code), '关窗必须只隐藏');
  const closedHandler = code.match(
    /app\.on\(\s*['"]window-all-closed['"]\s*,\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\}\s*\)/,
  );
  ok(closedHandler, 'window-all-closed 处理器必须存在');
  ok(!closedHandler[1].includes('app.quit'), 'window-all-closed 里不得退出（关窗即退出会让核心能力失效）');
  ok(/setAppUserModelId\(/.test(code), 'AppUserModelID 必须保留（否则 Windows toast 静默丢弃）');
  ok(/displayBalloon/.test(code), '通知失败降级到托盘气泡必须保留');
});

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log('');
console.log('  桌面审批通知 · 平台降级契约测试');
console.log('  ' + '─'.repeat(50));
if (failures.length === 0) {
  console.log(`  ✓ ${passed} passed, 0 failed`);
  console.log('');
  process.exit(0);
} else {
  console.log(`  ✗ ${passed} passed, ${failures.length} failed`);
  for (const f of failures) {
    console.log('');
    console.log(`  [§${f.group}] ${f.name}`);
    console.log(`    ${f.message}`);
  }
  console.log('');
  process.exit(1);
}