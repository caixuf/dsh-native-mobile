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
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 被测模块是 **CommonJS 纯模块**（不 require('electron')），
// 所以这里用 createRequire 直接 require —— 这正是它必须无依赖的原因。
const require = createRequire(import.meta.url);
const { buildNotificationOptions, MAX_BODY_CHARS } = require('../electron/notification-options.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.join(HERE, '..', 'electron');

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
  const channels = ['dsh:notify-approval', 'dsh:approval-action'];
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
  ok(
    /sendToRenderer\(\s*win,\s*APPROVAL_ACTION_CHANNEL\s*,\s*\{\s*eventId,\s*allow\s*\}/.test(code),
    '决定必须带着 eventId 与 allow（且 allow 允许为 null）回送渲染进程',
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