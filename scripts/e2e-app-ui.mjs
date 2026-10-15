#!/usr/bin/env node
/**
 * 整 app 端到端验收（CDP 驱动 WebView DOM）—— T5 交付物 ①
 *
 * ## 为什么是 CDP 而不是 uiautomator
 *
 * 这个 App 是「一个 WebView 承载整个 SPA」，而 **WebView 不把 DOM 暴露给 uiautomator**
 * （`uiautomator dump` 出来是空树）。基于坐标的点击在分辨率/字号一变就碎，失败时也
 * 只会说"点空了"。所以驱动只能走 WebView 的 DevTools 协议：
 *
 *   adb shell pidof io.github.dshmobile.app                  → pid
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   GET http://127.0.0.1:9222/json                           → webSocketDebuggerUrl
 *   WS 连上去以后用 Runtime.evaluate 直接读写 DOM
 *
 * ⚠️ 抽象 socket 名里带 **pid**：`am force-stop` 之后 pid 会变，必须重新 forward ——
 *    本脚本每次重启 app 都重新 `attach()`。
 *
 * ## 前置条件
 *
 * - 模拟器/设备已连接（默认 emulator-5554），App 已安装（**debug 构建**，
 *   因为只有 debug 才 `setWebContentsDebuggingEnabled(true)`）；
 * - 真网关在 `http://127.0.0.1:19387`，且 `adb reverse tcp:19387 tcp:19387` 已建立；
 * - 假主机类场景额外需要 `adb reverse tcp:19400 tcp:19400`（脚本自己起假主机）。
 *
 * ## 用法
 *
 *   node scripts/e2e-app-ui.mjs                      # 整 app 链路（默认，交付物 ①）
 *   node scripts/e2e-app-ui.mjs --scenario=all       # 链路 + 全部对抗性场景
 *   node scripts/e2e-app-ui.mjs --scenario=collapse  # T1 折叠持久化（真重启进程）
 *   node scripts/e2e-app-ui.mjs --scenario=archive   # T1 归档隐藏/恢复（真重启进程）
 *   node scripts/e2e-app-ui.mjs --scenario=queue     # T2 运行中输入可用/队列删除/失败保草稿
 *   node scripts/e2e-app-ui.mjs --scenario=bad-token # T3 令牌失效 → 停止重连 + UI 提示
 *   node scripts/e2e-app-ui.mjs --scenario=approval  # 待审批横幅 + 应答 + 重启不再弹
 *
 * 退出码：0 = 全部断言通过；1 = 有失败步骤（打印**具体哪一步**与该步当时的 DOM 证据）。
 *
 * ## 边界（诚实声明）
 *
 * - 只读写设备上的 localStorage 与 DOM，不碰 `src/`、`electron/`、`packages/`；
 * - 结束时会把设备上的主机记录恢复成「指向真网关 127.0.0.1:19387 且令牌有效」，
 *   并把本次临时铸造、且最终没在用的设备令牌**吊销**，不把手机留在坏状态；
 * - `queue` / `approval` 场景用脚本**自带的假主机**（127.0.0.1:19400）：真主机不会
 *   因为你按按钮就下发审批，也不该为了测 UI 去跑一轮 agent。假主机只实现信号面最小
 *   子集，并逐字校验应答形状（词表外的 outcome 会被真主机静默归一化成 unavailable，
 *   那是本项目最贵的 bug）。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID = 'io.github.dshmobile.app';
const ACTIVITY = `${APP_ID}/.MainActivity`;

const GATEWAY = 'http://127.0.0.1:19387';
const FAKE_HOST_PORT = 19400;
const FAKE_HOST_TOKEN = 'e2e-token-1';
const FAKE_SESSION_ID = 'session-fake-e2e-1';

// ── CLI ─────────────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const pref = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (pref) return pref.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) {
    const next = process.argv[i + 1];
    return next && !next.startsWith('--') ? next : 'true';
  }
  return fallback;
}
const flag = (name) => arg(name) === 'true';

const SERIAL = arg('serial', 'emulator-5554');
const CDP_PORT = Number(arg('port', '9222'));
const SCENARIO = arg('scenario', 'chain');
const SKIP_SEND = flag('skip-send');
const KEEP_STATE = flag('keep-state');
/** 关掉网络层观测（不注入 fetch/WebSocket 包装）—— 用于 A/B 判定"观测本身是否改变被测系统"。 */
const NO_NETLOG = flag('no-netlog');
const JSON_OUT = arg('json', null);

// ── 输出 ────────────────────────────────────────────────────────────────────
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = [];
let stepNo = 0;
function note(msg) {
  log(`${C.d}    · ${msg}${C.x}`);
}
function parseJsonSafe(raw, fallback) {
  try {
    const parsed = JSON.parse(raw || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function truncate(s, n = 700) {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str && str.length > n ? `${str.slice(0, n)}…(+${str.length - n})` : str;
}
function evidence(obj) {
  log(`${C.d}      证据: ${truncate(obj)}${C.x}`);
}

class StepFailure extends Error {
  constructor(step, message, ev) {
    super(message);
    this.step = step;
    this.evidence = ev;
  }
}

async function step(name, fn) {
  stepNo += 1;
  const label = `${stepNo}. ${name}`;
  const started = Date.now();
  try {
    const out = await fn();
    steps.push({ step: label, ok: true, ms: Date.now() - started });
    log(`${C.g}  ✓ ${label}${C.x}${C.d} (${Date.now() - started}ms)${C.x}`);
    return out;
  } catch (err) {
    // 失败时自动附上现场：网络层观测 + 当前页面文字。没有现场的证据不算验证。
    let diag = null;
    if (cdp) {
      try {
        diag = await pageFn(`const net = netlog();
return { linkStatePill: flat(txtOf(qs('header'))) .slice(0, 120),
  body: flat(bodyText()).slice(0, 400),
  fetchResponses: (net.responses || []).map(function (r) { return r.status + ' ' + r.url.replace(/^https?:\\/\\/[^/]+/, ''); }).slice(-8),
  fetchFailures: (net.failures || []).map(function (r) { return r.url.replace(/^https?:\\/\\/[^/]+/, '') + ' :: ' + r.error; }).slice(-5) };`);
      } catch {
        /* 页面可能已经不在了 */
      }
    }
    const evidenceMerged = diag ? { step: err.evidence, page: diag } : err.evidence;
    steps.push({ step: label, ok: false, ms: Date.now() - started, error: err.message, evidence: evidenceMerged });
    log(`${C.r}  ✗ ${label}${C.x}`);
    log(`${C.r}    ${err.message}${C.x}`);
    if (evidenceMerged !== undefined) evidence(evidenceMerged);
    throw new StepFailure(label, err.message, evidenceMerged);
  }
}

function expect(cond, message, ev) {
  if (!cond) {
    const err = new Error(message);
    err.evidence = ev;
    throw err;
  }
}

// ── adb ─────────────────────────────────────────────────────────────────────
function resolveAdb() {
  const candidates = [
    process.env.ADB_BIN,
    'adb',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe') : null,
    'C:\\Users\\20247\\Downloads\\android-toolchain\\android-sdk\\platform-tools\\adb.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const res = spawnSync(c, ['version'], { encoding: 'utf8' });
      if (!res.error && res.status === 0) return { bin: c, version: (res.stdout || '').split('\n')[0].trim() };
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(`找不到可用的 adb（试过：${candidates.join(' | ')}）。用 ADB_BIN 指派。`);
}

let ADB = null;
function adb(args, { allowFail = false, timeout = 30000 } = {}) {
  const res = spawnSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', timeout });
  if (res.error) throw new Error(`adb 调用失败：${res.error.message}`);
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status !== 0 && !allowFail) {
    const err = new Error(`adb ${args.join(' ')} 退出码 ${res.status}：${truncate(out, 300)}`);
    err.evidence = { args, status: res.status, out: truncate(out, 400) };
    throw err;
  }
  return { status: res.status, out };
}

// ── CDP 客户端 ──────────────────────────────────────────────────────────────
function httpGetJson(port, urlPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${urlPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    });
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`GET ${urlPath} 超时`));
    }, timeoutMs);
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0) {
        clearTimeout(timer);
        sock.destroy();
        resolve(buf.slice(i + 4));
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const list = this.handlers.get(msg.method);
        if (list) for (const fn of list) fn(msg.params);
      }
    });
  }

  static async connect({ port, timeoutMs = 25000 }) {
    const deadline = Date.now() + timeoutMs;
    let target = null;
    for (;;) {
      try {
        const raw = await httpGetJson(port, '/json');
        const list = JSON.parse(raw);
        target = list.find((t) => t.type === 'page' && String(t.url).includes('android_asset'));
        if (target) break;
      } catch {
        /* 还没起来，继续等 */
      }
      if (Date.now() > deadline) throw new Error(`等待 WebView DevTools 目标超时（${timeoutMs}ms）`);
      await sleep(400);
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${target.id}`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP WebSocket 打开超时')), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        reject(new Error('CDP WebSocket 打开失败'));
      });
    });
    const cdp = new Cdp(ws);
    cdp.target = { id: target.id, url: target.url, title: target.title };
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} 超时`));
        }
      }, 30000);
    });
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关 */
    }
  }

  async evalValue(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`页面异常：${d.exception?.description || d.text}`);
    }
    return res.result?.value;
  }
}

// ── 页面内注入的 DOM 小工具（零依赖，每次求值自带）────────────────────────────
const PAGE_LIB = `
function qs(sel, idx) { const l = document.querySelectorAll(sel); return l[idx || 0] || null; }
function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
function txtOf(el) { return el ? (el.innerText || el.textContent || '') : ''; }
function bodyText() { return document.body ? (document.body.innerText || '') : ''; }
function flat(s) { return (s || '').replace(/[ \\t]+/g, ' ').replace(/\\n{2,}/g, '\\n').trim(); }
function setNativeValue(el, value) {
  if (!el) throw new Error('setNativeValue: 元素不存在');
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (!desc || !desc.set) throw new Error('setNativeValue: 该元素没有 value setter');
  desc.set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
}
function clickEl(el) { if (!el) throw new Error('clickEl: 元素不存在'); el.click(); return true; }
function byText(sel, text) { return qsa(sel).filter(function (e) { return txtOf(e).indexOf(text) >= 0; })[0] || null; }
function collapsedPanels() {
  return qsa('button[aria-expanded]').map(function (b) {
    const pid = b.getAttribute('aria-controls');
    const panel = pid ? document.getElementById(pid) : null;
    const label = panel ? (panel.getAttribute('aria-label') || '') : '';
    return {
      label: label,
      expanded: b.getAttribute('aria-expanded') === 'true',
      hidden: panel ? panel.hasAttribute('hidden') : null,
      childCount: panel ? panel.children.length : -1,
      header: flat(txtOf(b)).slice(0, 60)
    };
  }).filter(function (g) { return /的会话列表$/.test(g.label) || /的子代理会话$/.test(g.label) || /已归档会话/.test(g.label); });
}
function groupPanels() { return collapsedPanels().filter(function (g) { return /的会话列表$/.test(g.label); }); }
function sessionCards() {
  return qsa('button[aria-label^="打开会话 "]').map(function (b) {
    return { label: b.getAttribute('aria-label'), text: flat(txtOf(b)).slice(0, 100) };
  });
}
function timelineEl() {
  return qsa('div').filter(function (d) {
    const cn = typeof d.className === 'string' ? d.className : '';
    return cn.indexOf('overflow-y-auto') >= 0 && cn.indexOf('space-y-4') >= 0 && cn.indexOf('px-4') >= 0;
  })[0] || null;
}
function chatInfo() {
  const ta = document.querySelector('textarea[aria-label="输入遥控指令"]');
  const cards = qsa('.specular-card');
  const assistant = cards.filter(function (c) { return txtOf(c).indexOf('DeepSeek 远程执行响应') >= 0; });
  const tl = timelineEl();
  const sendBtn = document.querySelector('button[aria-label="发送"], button[aria-label="加入待发队列"]');
  const alertEl = document.querySelector('[role="alert"]');
  return {
    onChat: !!ta,
    inputDisabled: ta ? !!ta.disabled : null,
    inputValue: ta ? ta.value : null,
    userBubbles: qsa('[class*="rounded-br-xs"]').length,
    assistantCards: assistant.length,
    specularCards: cards.length,
    timelineChildren: tl ? tl.children.length : -1,
    hasRunningBadge: bodyText().indexOf('执行中') >= 0,
    sendLabel: sendBtn ? sendBtn.getAttribute('aria-label') : null,
    alertText: alertEl ? flat(txtOf(alertEl)).slice(0, 200) : null
  };
}
function hasAssistantText(t) {
  return qsa('.specular-card').some(function (c) { return txtOf(c).indexOf(t) >= 0; });
}
/**
 * 每张助手卡片的**正文**（去掉固定标题）。
 *
 * 为什么要精确到"正文"：hasAssistantText 会被两种情况骗过 ——
 *   ① 会话标题里就含那串字（聊天页 header 也参与 innerText）；
 *   ② 模型的 reasoning 里复述了那串字。
 * 所以判定"正文有没有渲染出来"必须用 assistantBodies() 做**相等**比较。
 */
function assistantBodies() {
  const header = 'DeepSeek 远程执行响应';
  return qsa('.specular-card').filter(function (c) {
    return txtOf(c).indexOf(header) >= 0;
  }).map(function (c) {
    const t = txtOf(c);
    return flat(t.slice(t.indexOf(header) + header.length));
  }).filter(function (t) { return t; });
}
function userBubbleTexts() {
  return qsa('[class*="rounded-br-xs"]').map(function (e) { return flat(txtOf(e)); });
}
function queueInfo() {
  const bar = document.querySelector('section[aria-label="待发消息队列"]');
  if (!bar) return { present: false, text: '', removeLabels: [], retryLabels: [] };
  return {
    present: true,
    text: flat(txtOf(bar)).slice(0, 200),
    removeLabels: qsa('button[aria-label^="删除第"]').map(function (b) { return b.getAttribute('aria-label'); }),
    retryLabels: qsa('button[aria-label^="重试第"]').map(function (b) { return b.getAttribute('aria-label'); })
  };
}
function pairInfo() {
  const inputs = qsa('input');
  const url = inputs.filter(function (i) { return /^https?:/.test(i.value); })[0] || null;
  const code = inputs.filter(function (i) { return i.placeholder && i.placeholder.indexOf('22 位配对码') >= 0; })[0] || null;
  return {
    onPairScreen: bodyText().indexOf('连接工作电脑') >= 0,
    baseUrl: url ? url.value : null,
    code: code ? code.value : null,
    pins: [0, 1, 2, 3, 4, 5].map(function (i) { const el = document.getElementById('pin-' + i); return el ? el.value : null; }),
    submitting: bodyText().indexOf('正在验证并建立双向流') >= 0
  };
}
function netlog() { return window.__dshE2E || { ws: 0, wsUrls: [], fetch: 0, fetchUrls: [] }; }
function localStorageDump() {
  const out = {};
  try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); out[k] = localStorage.getItem(k); } } catch (e) { out.__error = String(e); }
  return out;
}
`;

const NETLOG_SOURCE = `
(function () {
  const log = { ws: 0, wsUrls: [], fetch: 0, fetchUrls: [], responses: [], failures: [] };
  window.__dshE2E = log;
  const OWS = window.WebSocket;
  function Patched(url, protocols) {
    log.ws += 1;
    try { log.wsUrls.push(String(url).replace(/token=[^&]*/g, 'token=***')); } catch (e) { log.wsUrls.push('?'); }
    return protocols === undefined ? new OWS(url) : new OWS(url, protocols);
  }
  Patched.prototype = OWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { try { Patched[k] = OWS[k]; } catch (e) {} });
  window.WebSocket = Patched;
  const OF = window.fetch;
  window.fetch = function (input, init) {
    log.fetch += 1;
    const url = String(input);
    log.fetchUrls.push(url);
    let p;
    try {
      // ⚠️ 必须显式传 window 作为 this。App 里是 await this.fetchImpl(url)（getter 返回 fetch），
      // 这个调用的 thisValue 是 DshConnection 实例；若我们原样透传 this，原生 fetch 会抛
      // "Failed to execute 'fetch' on 'Window': Illegal invocation" —— 那是**测量工具的 bug**，
      // 不是 App 的 bug（真机实测：const o={F:fetch}; o.F(url) 同样抛）。
      p = OF.call(window, input, init);
    } catch (e) {
      log.failures.push({ url: url, error: String((e && e.message) || e) });
      throw e;
    }
    return p.then(
      function (res) {
        log.responses.push({ url: url, status: res.status, ok: res.ok });
        return res;
      },
      function (err) {
        log.failures.push({ url: url, error: String((err && err.message) || err) });
        throw err;
      },
    );
  };
})();
`;

// ── 页面求值封装 ────────────────────────────────────────────────────────────
let cdp = null;
const page = (expr) => cdp.evalValue(`(function(){${PAGE_LIB}\nreturn (${expr});})()`);
const pageFn = (stmts) => cdp.evalValue(`(function(){${PAGE_LIB}\n${stmts}})()`);

async function until(desc, expr, { timeout = 20000, interval = 300 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await page(expr);
    } catch (err) {
      last = { __evalError: err.message };
    }
    if (last && last.ok) return last;
    if (Date.now() > deadline) {
      const err = new Error(`${desc} —— 等待超时（${timeout}ms）`);
      err.evidence = last;
      throw err;
    }
    await sleep(interval);
  }
}

// ── app 启动 / CDP 附着 ─────────────────────────────────────────────────────
let consoleLogs = [];

/**
 * 杀掉 App 并重新拉起（真进程重启，pid 必须变）。
 *
 * 🔴 为什么先按 HOME 再杀（真机 Android 17 实测踩到，模拟器上完全不复现）：
 * 刚写完 localStorage 就 force-stop，**最近一次写入会丢** —— LevelDB 还没落盘。
 * 取证：CDP 立刻读得到新值，重启后却是旧值；同一份数据"先切后台再杀"就能扛住，
 * 因为 Chromium 在页面转入后台时强制 flush。
 * 这不是测试将就 —— 真实用户"改完设置立刻从最近任务里划掉"也是同一条路径。
 */
async function restartApp() {
  const oldPid = adb(['shell', 'pidof', APP_ID], { allowFail: true }).out.trim().split(/\s+/)[0];
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
  await sleep(2000);
  const newPid = await attach({ fresh: true });
  return { oldPid, newPid };
}

async function attach({ fresh = false } = {}) {
  if (cdp) {
    cdp.close();
    cdp = null;
  }
  let oldPid = '';
  if (fresh) {
    oldPid = adb(['shell', 'pidof', APP_ID], { allowFail: true }).out.trim().split(/\s+/)[0] || '';
    adb(['shell', 'am', 'force-stop', APP_ID]);
    await sleep(600);
    adb(['reverse', 'tcp:19387', 'tcp:19387'], { allowFail: true });
    adb(['reverse', 'tcp:19400', 'tcp:19400'], { allowFail: true });
    adb(['shell', 'am', 'start', '-n', ACTIVITY]);
  } else {
    const { out } = adb(['shell', 'pidof', APP_ID], { allowFail: true });
    if (!out.trim()) adb(['shell', 'am', 'start', '-n', ACTIVITY]);
  }
  let pid = '';
  const deadline = Date.now() + 15000;
  for (;;) {
    pid = adb(['shell', 'pidof', APP_ID], { allowFail: true }).out.trim().split(/\s+/)[0] || '';
    if (pid && (!fresh || pid !== oldPid)) break;
    if (Date.now() > deadline) break;
    await sleep(400);
  }
  expect(pid, 'app 没有在运行（pidof 为空）—— 检查 am start 是否成功', { oldPid, pid });
  adb(['forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
  adb(['reverse', 'tcp:19387', 'tcp:19387'], { allowFail: true });
  note(`pid=${oldPid ? `${oldPid} → ` : ''}${pid}，已 forward tcp:${CDP_PORT}`);
  cdp = await Cdp.connect({ port: CDP_PORT });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    consoleLogs.push({
      kind: 'console',
      type: p.type,
      text: (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' '),
    });
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleLogs.push({
      kind: 'exception',
      type: 'exception',
      text: p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '?',
    });
  });
  cdp.on('Log.entryAdded', (p) => {
    consoleLogs.push({ kind: 'log', type: p.entry?.level, source: p.entry?.source, text: p.entry?.text || '' });
  });
  if (!NO_NETLOG) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: NETLOG_SOURCE });
  return pid;
}

async function reload({ timeoutMs = 20000 } = {}) {
  // 标记 → 重载；新文档没有这个标记，因此"标记消失 + body 有内容"= 新页面真的起来了
  await cdp.evalValue('window.__e2eOldDocMarker = 1; setTimeout(function(){ location.reload(); }, 60); true');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const ok = await cdp.evalValue(
        'typeof window.__e2eOldDocMarker === "undefined" && typeof document !== "undefined" && !!document.body && document.body.innerText.length > 0',
      );
      if (ok) return;
    } catch {
      /* 执行上下文切换中 */
    }
    if (Date.now() > deadline) throw new Error('页面重载后没有恢复可求值状态');
    await sleep(250);
  }
}

// ── 网关助手（铸码 / 真配对 / 校验令牌 / 吊销）──────────────────────────────
const mintedDevices = [];
async function gatewayPost(p, body, token) {
  const res = await fetch(`${GATEWAY}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null */
  }
  return { status: res.status, json, text };
}

async function mintPairing() {
  const res = await gatewayPost('/mobile-gateway/manage/api/mint');
  expect(res.status === 200 && res.json?.pairing, `铸配对码失败：HTTP ${res.status} ${truncate(res.text, 200)}`, {
    status: res.status,
    text: truncate(res.text, 300),
  });
  const p = res.json.pairing;
  return { pin: p.pin, pinDisplay: p.pinDisplay, display: p.display, expiresAt: p.expiresAt, instance: res.json.instance };
}

async function pairHttp({ deviceName, platform = 'web' }) {
  const mint = await mintPairing();
  const res = await gatewayPost('/mobile-gateway/pair', { code: mint.display, deviceName, platform });
  expect(res.status === 200 && res.json?.token, `真配对失败：HTTP ${res.status} ${truncate(res.text, 200)}`, {
    status: res.status,
    text: truncate(res.text, 300),
  });
  mintedDevices.push(res.json.device?.id);
  return {
    record: {
      id: 'host-e2e-' + Date.now(),
      label: res.json.instance?.name || 'E2E 真网关',
      baseUrl: GATEWAY,
      token: res.json.token,
      deviceId: res.json.device?.id || 'unknown',
      instanceName: res.json.instance?.name || '',
      pairedAt: Date.now(),
      lastUsedAt: Date.now(),
    },
    device: res.json.device,
    mint,
  };
}

/** 用一枚令牌打一次 session.list，返回 HTTP 状态（401/403 = 令牌失效）。 */
async function tokenStatus(token) {
  const res = await gatewayPost(
    '/mobile-gateway/api/session/list',
    { type: 'client-request', rpcId: 'probe' + Date.now(), method: 'session/list', payload: { args: { _request: {} } } },
    token,
  ).catch(() => ({ status: 0 }));
  return res.status;
}

async function revokeDevice(deviceId) {
  if (!deviceId) return;
  await gatewayPost('/mobile-gateway/manage/api/revoke', { deviceId }).catch(() => {});
}

// ── 宿主侧真值（用 App 自己的令牌直连主机）───────────────────────────────────
//
// 为什么需要它：只靠"页面里有没有那串字"判定"回复有没有渲染出来"会被骗 ——
// 会话标题、以及模型 reasoning 里复述的同一串字都会命中。
// 所以这里从**宿主记录**里取"真正的正文"，再要求 App 把它**原样渲染成卡片正文**。

async function activeHostRecord() {
  const dump = await pageFn('return localStorageDump();');
  let hosts = [];
  try {
    hosts = JSON.parse(dump.dsh_hosts_v1 || '[]');
  } catch {
    hosts = [];
  }
  const active = hosts.find((h) => h.id === dump.dsh_active_host_id) || hosts[0];
  if (!active) throw new Error('设备上没有主机记录，取不到宿主侧真值');
  return active;
}

async function hostRpc(method, args) {
  const host = await activeHostRecord();
  const i = method.indexOf('.');
  const ep = i < 0 ? method : `${method.slice(0, i)}/${method.slice(i + 1)}`;
  const res = await fetch(`${host.baseUrl}/mobile-gateway/api/${ep}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'e2e' + Date.now(), method: ep, payload: { args } }),
  });
  const json = await res.json().catch(() => null);
  if (!json?.result?.ok) throw new Error(`宿主 ${method} 失败：${JSON.stringify(json?.result?.error ?? `HTTP ${res.status}`)}`);
  return json.result.value;
}

/** 取某会话的一页记录（自动处理 `past cursor N` 探针重试，与 App 同一条路径）。 */
async function hostPageRecords(sessionId) {
  const address = { kind: 'session', sessionId };
  try {
    const v = await hostRpc('session.page', { request: { address, throughSeq: 1000000, maxMessages: 50 } });
    return v.records || [];
  } catch (err) {
    const m = /past cursor (\d+)/.exec(String(err.message));
    if (!m) throw err;
    const v = await hostRpc('session.page', { request: { address, throughSeq: Number(m[1]), maxMessages: 50 } });
    return v.records || [];
  }
}

/**
 * 找到"确实包含我们这条 prompt"的那个会话，并取回助手记录的**分块真实内容**。
 * 这是判定的 ground truth：`replyText` 必须原样出现在 App 的助手卡片正文里。
 */
async function findReplyTruth(promptText, { timeout = 90000, expectSessionId = null } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    let items = [];
    try {
      items = (await hostRpc('session.list', { _request: {} })).items || [];
    } catch (err) {
      last = { listError: err.message };
      await sleep(1500);
      continue;
    }
    const candidates = items
      .filter((s) => s.origin !== 'subagent' && (!expectSessionId || s.sessionId === expectSessionId))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 6);
    for (const s of candidates) {
      let recs = [];
      try {
        recs = await hostPageRecords(s.sessionId);
      } catch {
        continue;
      }
      const hasPrompt = recs.some(
        (r) => r.event?.type === 'user/message' && JSON.stringify(r.event.data || {}).includes(promptText),
      );
      if (!hasPrompt) continue;
      const asst = recs.filter((r) => r.event?.type === 'assistant/message');
      last = { sessionId: s.sessionId, title: s.projections?.values?.title, assistantRecords: asst.length };
      if (!asst.length) continue;
      const parts = asst[asst.length - 1].event?.data?.message?.content || [];
      const replyText = parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n').trim();
      const reasoningText = parts.filter((p) => p.type === 'reasoning').map((p) => p.text || '').join('\n').trim();
      if (!replyText) continue;
      return { sessionId: s.sessionId, title: s.projections?.values?.title, partTypes: parts.map((p) => p.type), replyText, reasoningText };
    }
    if (Date.now() > deadline) {
      const e = new Error('从宿主侧等不到"带正文的 assistant 记录"');
      e.evidence = last;
      throw e;
    }
    await sleep(1500);
  }
}

// ── localStorage 注入 ───────────────────────────────────────────────────────
async function seedHosts(hosts, activeId) {
  const payload = JSON.stringify(JSON.stringify(hosts));
  await pageFn(
    `localStorage.setItem('dsh_hosts_v1', ${payload});
${activeId ? `localStorage.setItem('dsh_active_host_id', ${JSON.stringify(activeId)});` : `localStorage.removeItem('dsh_active_host_id');`}
return true;`,
  );
}

const readLs = (key) => page(`localStorage.getItem(${JSON.stringify(key)})`);
const snapshotState = () => pageFn('return localStorageDump();').catch(() => ({}));

function realHostRecord(paired) {
  return {
    id: 'host-e2e-real',
    label: 'E2E 真网关',
    baseUrl: GATEWAY,
    token: paired.record.token,
    deviceId: paired.device?.id || 'unknown',
    instanceName: paired.record.instanceName,
    pairedAt: Date.now(),
    lastUsedAt: Date.now(),
  };
}

/**
 * 保证 app 里有一台**令牌确实有效**的真网关主机；没有就现配一台。
 * 折叠/归档等场景如果单独跑，需要它才不会停在配对页。
 */
async function ensurePairedRealHost() {
  adb(['reverse', 'tcp:19387', 'tcp:19387']);
  const dump = await pageFn('return localStorageDump();').catch(() => ({}));
  let hosts = [];
  try {
    hosts = JSON.parse(dump.dsh_hosts_v1 || '[]');
  } catch {
    hosts = [];
  }
  for (const h of hosts) {
    if (h && String(h.baseUrl).indexOf('127.0.0.1:19387') >= 0) {
      const status = await tokenStatus(h.token);
      if (status >= 200 && status < 300) {
        await pageFn(`localStorage.setItem('dsh_active_host_id', ${JSON.stringify(h.id)}); return true;`);
        note(`复用已有真网关主机 ${h.id}（令牌有效）`);
        return { host: h, minted: false };
      }
      note(`已有主机的令牌无效（HTTP ${status}），重新配对`);
    }
  }
  const paired = await pairHttp({ deviceName: 'Web Remote Client · e2e-setup' });
  const rec = realHostRecord(paired);
  await seedHosts([rec], rec.id);
  note(`已配对真网关主机 ${rec.id}（device ${paired.device?.id}）`);
  return { host: rec, minted: true };
}

// ── 会话列表 / 聊天页的通用动作 ─────────────────────────────────────────────

/**
 * 等"列表真的加载完"。
 *
 * ⚠️ 踩过的坑：「暂无匹配的遥控会话」这个空态在**还没连上**时也会渲染，
 * 只凭它判定会读到假空态，于是脚本会在"连接中 (1)"的页面上去找分组 → 假失败。
 * 所以空态必须叠加「双向流就绪」，并且重启类场景一律走它。
 */
async function waitReadyWithSessions({ expectCards = false, timeout = 45000 } = {}) {
  await until(
    '链路就绪（会话列表页要显示「双向流就绪」）',
    `(function(){ const t = bodyText(); return { ok: t.indexOf('遥控会话') >= 0 && t.indexOf('双向流就绪') >= 0, pill: flat(txtOf(qs('header'))).slice(0, 80) }; })()`,
    { timeout, interval: 400 },
  );
  if (expectCards) {
    return until(
      '会话卡片渲染出来',
      `(function(){ const c = sessionCards(); return { ok: c.length > 0, cards: c.length, body: flat(bodyText()).slice(0, 160) }; })()`,
      { timeout, interval: 500 },
    );
  }
  return until(
    '工作区分组渲染出来',
    `(function(){ const g = groupPanels(); return { ok: g.length > 0, groups: g.length, body: flat(bodyText()).slice(0, 160) }; })()`,
    { timeout, interval: 500 },
  );
}

const expandAllGroups = () =>
  pageFn(`const b = qs('button[aria-label="展开全部工作区"]'); if (b) { b.click(); return true; } return false;`);

async function openSessionWithHistory({ maxTries = 8 } = {}) {
  await expandAllGroups();
  await sleep(300);
  const cards = await page('sessionCards()');
  expect(cards.length > 0, '会话列表里没有任何会话卡片，无法验证历史渲染', cards);
  let lastEvidence = null;
  for (let i = 0; i < Math.min(maxTries, cards.length); i += 1) {
    await pageFn(`const bs = qsa('button[aria-label^="打开会话 "]'); clickEl(bs[${i}]); return true;`);
    let info = null;
    try {
      info = await until(
        `第 ${i + 1} 个会话的历史渲染出来`,
        `(function(){ const c = chatInfo(); return { ok: c.onChat && (c.userBubbles + c.assistantCards + c.specularCards) > 0, info: c }; })()`,
        { timeout: 25000, interval: 400 },
      );
    } catch (err) {
      lastEvidence = err.evidence;
      note(`第 ${i + 1} 个会话没渲染出历史：${truncate(err.evidence, 160)}`);
    }
    if (info && info.info && info.info.userBubbles + info.info.assistantCards + info.info.specularCards > 0) {
      return { index: i, card: cards[i], info: info.info };
    }
    await pageFn(`const b = qs('button[aria-label="返回会话列表"]'); if (!b) throw new Error('没有"返回会话列表"按钮'); b.click(); return true;`);
    await until('回到会话列表', `(function(){ return { ok: bodyText().indexOf('遥控会话') >= 0 }; })()`, { timeout: 15000 });
    await expandAllGroups();
    await sleep(300);
  }
  const err = new Error(`打开前 ${Math.min(maxTries, cards.length)} 个会话，没有一个渲染出历史（最后一个观察值见证据）`);
  err.evidence = lastEvidence;
  throw err;
}

async function backToSessions() {
  await pageFn(`const b = qs('button[aria-label="返回会话列表"]'); if (b) { b.click(); return true; } return false;`);
  await until('回到会话列表', `(function(){ return { ok: bodyText().indexOf('遥控会话') >= 0 }; })()`, { timeout: 15000 });
}

// ── 假主机（审批 / 队列场景用）──────────────────────────────────────────────
async function startFakeHost({ mode = 'ui', eventId = 'ev-e2e-fixed-1', emitDelayMs = 500 } = {}) {
  const wsPath = path.join(ROOT, 'packages', 'dsh-mobile-gateway', 'node_modules', 'ws', 'index.js');
  if (!fs.existsSync(wsPath)) throw new Error(`找不到 ws 包：${wsPath}`);
  const mod = await import(pathToFileURL(wsPath).href);
  const WSS = mod.WebSocketServer || mod.default?.WebSocketServer;
  if (!WSS) throw new Error('ws 包没有导出 WebSocketServer');

  const state = {
    mode,
    eventId,
    emitDelayMs,
    connections: 0,
    openFrames: [],
    waterfalls: 0,
    results: [],
    listCalls: 0,
    pageCalls: 0,
    promptCalls: 0,
    promptSocketDestroy: false,
    destroyedPromptSockets: 0,
    lastToken: null,
  };

  const sessions = [
    {
      sessionId: FAKE_SESSION_ID,
      origin: 'user',
      parentSessionId: null,
      running: false,
      updatedAt: Date.now(),
      cwd: 'C:\\Users\\20247\\Downloads\\aiwork\\dsh-native-mobile',
      projections: {
        values: {
          title: 'E2E 假主机会话',
          preview: '假主机预置的一条记录',
          cwd: 'C:\\Users\\20247\\Downloads\\aiwork\\dsh-native-mobile',
        },
      },
    },
  ];

  const records = [
    { type: 'event', seq: 1, event: { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'fake-host: 用户历史消息' }] } } } },
    { type: 'event', seq: 2, event: { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'fake-host: 助手历史回复' }] } } } },
    { type: 'event', seq: 3, event: { type: 'tool/call', seq: 3, data: { name: 'run_command', callId: 'call-fake-1', arguments: '{"command":"echo fake"}' } } },
  ];
  const CURSOR = 3;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* keep null */
    }
    const send = (obj, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(obj));
    };
    const okResult = (value) => send({ result: { ok: true, value } });
    state.lastToken = (req.headers.authorization || '').replace(/^bearer\s+/i, '').trim() || url.searchParams.get('token');

    if (url.pathname === '/mobile-gateway/api/session/list') {
      state.listCalls += 1;
      return okResult({ items: sessions });
    }
    if (url.pathname === '/mobile-gateway/api/session/page') {
      state.pageCalls += 1;
      const through = Number(body?.payload?.args?.request?.throughSeq);
      if (Number.isFinite(through) && through > CURSOR) {
        return send({ result: { ok: false, error: { code: 'gateway/bad-request', message: `session page through seq ${through} is past cursor ${CURSOR}` } } });
      }
      return okResult({ records });
    }
    if (url.pathname === '/mobile-gateway/api/session/prompt') {
      state.promptCalls += 1;
      if (state.promptSocketDestroy) {
        // 网络层失败：客户端看到的就是 TypeError: Failed to fetch（与端口不可达同类）
        state.destroyedPromptSockets += 1;
        req.socket.destroy();
        return;
      }
      return okResult({ accepted: true });
    }
    if (url.pathname === '/mobile-gateway/api/session/create') {
      return okResult({ sessionId: 'session-fake-created-' + Date.now(), agentPreset: 'standard' });
    }
    if (url.pathname === '/mobile-gateway/api/$events/result') {
      const args = body?.payload?.args || {};
      state.results.push({ method: body?.method, args });
      return okResult(null);
    }
    return send({ result: { ok: false, error: { code: 'not_found', message: `${req.method} ${url.pathname}` } } });
  });

  const wss = new WSS({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const token = (req.headers.authorization || '').replace(/^bearer\s+/i, '').trim() || url.searchParams.get('token');
    if (url.pathname !== '/mobile-gateway/remote.mux' || token !== FAKE_HOST_TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const emitWaterfall = (ws) => {
    if (ws.readyState !== ws.OPEN) return;
    state.waterfalls += 1;
    ws.send(
      JSON.stringify({
        type: 'item',
        streamId: 'fake-stream',
        value: {
          type: 'waterfall',
          event: 'tool/approval',
          eventId: state.eventId,
          request: {
            toolName: 'shell',
            sessionId: FAKE_SESSION_ID,
            // 故意用**多语言对象**：真主机实测就是这个形状；
            // App 里 `String(displayReason)` 会渲染成 "[object Object]"（已修）
            displayReason: { zh: '将要执行 rm -rf build/（假主机 e2e）', en: 'Will run rm -rf build/ (fake host e2e)' },
          },
        },
      }),
    );
  };

  wss.on('connection', (ws) => {
    state.connections += 1;
    ws.send(JSON.stringify({ type: 'item', streamId: 'probe', value: { type: 'ready', clientId: 'fake-client-1' } }));
    ws.on('message', (data) => {
      let msg = null;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'open') {
        state.openFrames.push({ endpoint: msg.endpoint, keys: Object.keys(msg).sort().join(',') });
        if (state.mode === 'approval') setTimeout(() => emitWaterfall(ws), state.emitDelayMs);
      }
    });
    ws.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(FAKE_HOST_PORT, '0.0.0.0', resolve);
  });

  return {
    state,
    /**
     * 关掉假主机。
     *
     * ⚠️ 不能直接 `wss.close(cb)`：那会**等所有客户端断开**，而 app 的 WebView
     * 与原生中继正连着它（它们不会主动断）—— 实测会把整个脚本永久挂住。
     * 所以先 `terminate()` 掉所有客户端，并给一个 3s 兜底。
     */
    stop: () =>
      new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        try {
          for (const client of wss.clients) {
            try {
              client.terminate();
            } catch {
              /* 已经断了 */
            }
          }
        } catch {
          /* ignore */
        }
        try {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        } catch {
          /* ignore */
        }
        wss.close(() => server.close(() => finish()));
        setTimeout(finish, 3000).unref?.();
      }),
  };
}

async function seedFakeHost() {
  await seedHosts(
    [
      {
        id: 'host-e2e-fake',
        label: 'E2E 假主机',
        baseUrl: `http://127.0.0.1:${FAKE_HOST_PORT}`,
        token: FAKE_HOST_TOKEN,
        deviceId: 'dev-e2e-fake',
        instanceName: 'E2E 假主机',
        pairedAt: Date.now(),
        lastUsedAt: Date.now(),
      },
    ],
    'host-e2e-fake',
  );
}

// ── 场景：整 app 链路 ───────────────────────────────────────────────────────
async function scenarioChain({ clean }) {
  const info = {};

  await step('preflight：adb / 模拟器 / 真网关都可用', async () => {
    const devices = adb(['devices']).out;
    const health = await fetch(`${GATEWAY}/mobile-gateway/health`)
      .then((r) => r.json())
      .catch((e) => ({ error: String(e) }));
    expect(devices.includes(SERIAL), `设备 ${SERIAL} 不在 adb devices 列表里`, { devices });
    expect(health && health.ok, `真网关 ${GATEWAY}/mobile-gateway/health 不可用`, health);
    adb(['reverse', 'tcp:19387', 'tcp:19387']);
    evidence({ adb: ADB, devices: devices.split('\n').slice(1, 3), gatewayInstance: health.instance?.name || health.ok });
    return { health };
  });

  await step('启动 app 并清空本地状态 → 停在配对页', async () => {
    await attach({ fresh: true });
    if (clean) await pageFn('localStorage.clear(); return true;');
    await reload();
    const res = await until(
      '配对页出现',
      `(function(){ const p = pairInfo(); return { ok: p.onPairScreen && !!p.baseUrl, info: p }; })()`,
      { timeout: 25000 },
    );
    evidence(res.info);
    return res.info;
  });

  await step('铸真配对码并填进配对页（6 位 PIN 输入框）', async () => {
    // ⚠️ 必须**在这里**才铸码：网关只保留**一枚**有效配对码，
    // 再铸一枚会让上一枚立刻变成「配对码不匹配」（真机实测：mint#1→403 mismatch，mint#2→200）。
    // 所以铸码与点击之间不能有别的铸码动作（包括人工在别的终端铸码）。
    const mint = await mintPairing();
    const pin = mint.pin;
    await pageFn(`const b = byText('button', '一次性配对码'); clickEl(b); return true;`);
    await sleep(200);
    await pageFn(`const inputs = qsa('input'); const urlEl = inputs.filter(function (i) { return /^https?:/.test(i.value); })[0];
setNativeValue(urlEl, ${JSON.stringify(GATEWAY)});
${JSON.stringify(pin)}.split('').forEach(function (d, i) { const el = document.getElementById('pin-' + i); if (!el) throw new Error('缺少 #pin-' + i); setNativeValue(el, d); });
return true;`);
    const p = await page('pairInfo()');
    expect(p.baseUrl === GATEWAY, `网关地址没写进去（实际 ${p.baseUrl}）`, p);
    expect(p.pins.join('') === pin, `6 位 PIN 没填对（实际 ${p.pins.join('')}）`, p);
    evidence({ pinDisplay: mint.pinDisplay, baseUrl: p.baseUrl, pins: p.pins.join(''), hiddenCodeInput: p.code });
    info.pin = pin;
    return p;
  });

  await step('点「完成配对」→ 真网关接受 → 进入会话列表并出现按工作区的分组', async () => {
    await pageFn(`const b = byText('button', '完成配对'); if (!b) throw new Error('找不到「完成配对」按钮'); clickEl(b); return true;`);
    const res = await until(
      '配对成功后出现按工作区分组',
      `(function(){ const groups = groupPanels(); return { ok: groups.length > 0, groups: groups, text: flat(bodyText()).slice(0, 280) }; })()`,
      { timeout: 45000, interval: 500 },
    );
    info.groups = res.groups;
    evidence({
      groupCount: res.groups.length,
      groups: res.groups.slice(0, 6).map((g) => ({ label: g.label, expanded: g.expanded, header: g.header })),
    });
    return res;
  });

  await step('分组概览正确（N 个工作区 · M 个会话）', async () => {
    const summary = await pageFn(`const m = /(\\d+) 个工作区 · (\\d+) 个会话/.exec(flat(bodyText()));
return { ok: !!m, matched: m ? m[0] : null, groups: groupPanels().map(function (g) { return g.header; }) };`);
    expect(summary.ok, '会话列表没有出现「N 个工作区 · M 个会话」的概览', summary);
    evidence(summary);
    return summary;
  });

  await step('折叠 / 展开一个工作区组（aria-expanded + panel hidden + 子树清空）', async () => {
    const before = await page('groupPanels()');
    const target = before.find((g) => g.expanded) || before[0];
    expect(target, '没有任何工作区组可折叠', before);
    const clickHeader = (label) =>
      pageFn(`const bs = qsa('button[aria-expanded]').filter(function (b) { const pid = b.getAttribute('aria-controls'); const p = pid ? document.getElementById(pid) : null; return p && (p.getAttribute('aria-label') || '') === ${JSON.stringify(label)}; });
clickEl(bs[0]); return true;`);
    const readGroup = async (label) =>
      (await page(`collapsedPanels().filter(function (g) { return g.label === ${JSON.stringify(label)}; })`))[0];

    await clickHeader(target.label);
    await sleep(400);
    const collapsed = await readGroup(target.label);
    expect(collapsed.expanded === false, `点击后 aria-expanded 仍为 true（${target.label}）`, collapsed);
    expect(collapsed.hidden === true, `折叠后 panel 没有 hidden（${target.label}）`, collapsed);
    expect(collapsed.childCount === 0, `折叠后子树没有清空（children=${collapsed.childCount}）`, collapsed);

    await clickHeader(target.label);
    await sleep(400);
    const reopened = await readGroup(target.label);
    expect(reopened.expanded === true && reopened.childCount > 0, '再次点击没有展开回来', reopened);
    const raw = await readLs('dsh.sessions.collapsed.v1');
    evidence({ label: target.label, collapsed, reopened, localStorage: truncate(raw, 300) });
    return { collapsed, reopened, raw };
  });

  await step('打开一个会话 → 历史记录真的渲染出来（非空）', async () => {
    const opened = await openSessionWithHistory({ maxTries: 8 });
    expect(
      opened.info.userBubbles + opened.info.assistantCards + opened.info.specularCards > 0,
      '聊天页渲染出的消息节点为 0（历史空列表 —— 就是那两个 bug 没修好的症状）',
      opened.info,
    );
    info.history = opened;
    evidence({ card: opened.card.text, history: opened.info });
    return opened;
  });

  if (SKIP_SEND) {
    note('--skip-send：跳过「发一条指令等回复」');
  } else {
    const SENTINEL = 'E2E-REPLY-7719';
    await step('新建一个一次性会话（不污染用户既有会话）', async () => {
      await backToSessions();
      await pageFn(`const b = byText('button', '新建会话'); if (!b) throw new Error('找不到浮动「新建会话」按钮'); clickEl(b); return true;`);
      await until('新建会话对话框', `(function(){ return { ok: bodyText().indexOf('新建遥控会话') >= 0 }; })()`, { timeout: 10000 });
      const cwd = ROOT;
      const set = await pageFn(`const inputs = qsa('input'); const el = inputs.filter(function (i) { return i.value && i.value.indexOf('~/Developer') === 0; })[0] || inputs[inputs.length - 1];
return setNativeValue(el, ${JSON.stringify(cwd)});`);
      expect(set === cwd, `新建会话的 cwd 没写进去（实际 ${set}）`, { set });
      await pageFn(`const b = byText('button', '创建会话'); if (!b) throw new Error('找不到「创建会话」按钮'); clickEl(b); return true;`);
      const res = await until('进入新会话聊天页', `(function(){ const c = chatInfo(); return { ok: c.onChat, info: c }; })()`, { timeout: 25000 });
      const immediate = res.info;
      // ⚠️ 刚进聊天页时时间线里可能**还是上一个会话的消息**：
      // App 切会话只 setCurrentSession+loadChatPage，直到 fetch 回来才 setChatLines，
      // 期间旧 lines 照旧渲染（实测 immediate.assistantCards=224 → settled=3）。
      // 这里等本会话自己的历史落定，否则后面"回复是否新增"的基线是错的。
      const settled = await until(
        '新会话自己的历史落定（时间线不再是上一个会话的内容）',
        `(function(){ const c = chatInfo(); return { ok: c.assistantCards <= 6 && c.userBubbles <= 1, info: c }; })()`,
        { timeout: 20000, interval: 300 },
      );
      evidence({ cwd, immediateOnOpen: immediate, settled: settled.info, staleCardsOnOpen: immediate.specularCards });
      return settled.info;
    });

    await step('发送 ASCII 指令 → 我的指令可见 + 助手正文原样渲染（判定基准取宿主记录）', async () => {
      const prompt = `Reply with exactly: ${SENTINEL}`;
      const before = await page('chatInfo()');
      await pageFn(`const ta = document.querySelector('textarea[aria-label="输入遥控指令"]'); setNativeValue(ta, ${JSON.stringify(prompt)}); return ta.value;`);
      await pageFn(`const b = document.querySelector('button[aria-label="发送"]') || document.querySelector('button[aria-label="加入待发队列"]'); if (!b) throw new Error('找不到发送按钮'); clickEl(b); return true;`);

      // ⚠️ 判定基准必须是**宿主记录里的正文**：
      // 只查"页面里有没有那串字"会被两种情况骗过 —— ① 会话标题里含同一串字；
      // ② 模型 reasoning 里复述了同一串字。两者都实测命中过。
      const truth = await findReplyTruth(prompt);
      note(`宿主真值：content 分块=[${truth.partTypes.join(',')}] 正文=${JSON.stringify(truncate(truth.replyText, 60))}`);
      if (truth.reasoningText) note(`同一记录的 reasoning=${JSON.stringify(truncate(truth.reasoningText, 80))}`);
      // 🔴 别用固定 sleep 当判据：宿主记录已写入 ≠ 界面已渲染完（实测偶发假红）。
      // ⚠️ 预算也不能太小：真机（Android 17）上首轮要吃一大坨注入上下文（实测 7000+ 字），
      // 模型首 token 与界面渲染都更慢 —— 25s 在真机上约 40% 假红。给 75s。
      try {
        await until(
          '界面对齐宿主真值（用户气泡 + 助手正文都出现）',
          `(function(){ const b = userBubbleTexts(); const bodies = assistantBodies();
            return { ok: b.indexOf(${JSON.stringify(prompt)}) >= 0 && bodies.indexOf(${JSON.stringify(truth.replyText)}) >= 0 }; })()`,
          { timeout: 75000, interval: 700 },
        );
      } catch (err) {
        note(`等待界面对齐超时（${(err && err.message) || err}），按当前状态继续判定`);
      }
      const obsRaw = await pageFn(`return { bubbles: userBubbleTexts(), bodies: assistantBodies(), info: chatInfo() };`);
      // 只留前 160 字做证据：助手卡片正文里可能整段系统提示词（那本身也是一个发现）
      const obs = {
        bubbles: obsRaw.bubbles.slice(-6),
        bodies: obsRaw.bodies.slice(-6).map((b) => truncate(b, 160)),
        info: obsRaw.info,
      };

      const bubbleOk = obs.bubbles.indexOf(prompt) >= 0;
      const replyOk = obs.bodies.indexOf(truth.replyText) >= 0;
      const problems = [];
      if (!bubbleOk) {
        problems.push(
          `我发出的指令没有渲染成用户气泡：实测 ${obs.bubbles.length} 个用户气泡，文本是 ${JSON.stringify(obs.bubbles)}` +
            `（user/message 记录的文本在 data.content[0].text，而 App 读的是 data.message.content[0].text → 永远取不到）`,
        );
      }
      if (!replyOk) {
        problems.push(
          `助手正文没有原样渲染：宿主正文=${JSON.stringify(truncate(truth.replyText, 60))}，content 分块=[${truth.partTypes.join(',')}]，` +
            `App 渲染出的助手卡正文=${JSON.stringify(obs.bodies)}（content[0] 若是 reasoning，App 就会把推理当回答）`,
        );
      }
      evidence({
        prompt,
        hostTruth: { sessionId: truth.sessionId, partTypes: truth.partTypes, replyText: truncate(truth.replyText, 80), reasoningText: truncate(truth.reasoningText, 80) },
        renderedUserBubbles: obs.bubbles,
        renderedAssistantBodies: obs.bodies,
        before: { assistantCards: before.assistantCards, userBubbles: before.userBubbles },
      });
      expect(problems.length === 0, problems.join('  ／  '), { truth, obs });

      // 注入上下文不能伪装成用户气泡（真机 Android 17 抓到过：7000+ 字记忆快照铺在最前）
      const injected = await page(`(function(){
        const notes = Array.from(document.querySelectorAll('[data-testid="injected-note"]'));
        const bubbles = Array.from(document.querySelectorAll('[class*="justify-end"]'));
        return { notes: notes.map(function (n) { return n.getAttribute('data-label'); }),
          bubbleHeads: bubbles.slice(0, 4).map(function (b) { return (b.innerText || '').replace(/\\s+/g, ' ').slice(0, 40); }) };
      })()`);
      const leak = (injected.bubbleHeads || []).filter((t) => /MNEMON RUNTIME MEMORY SNAPSHOT|Current runtime context\.|<system-reminder>|\[MNEMON\]/.test(t));
      expect(
        leak.length === 0,
        `注入上下文被当成了用户气泡：${JSON.stringify(leak)}`,
        injected,
      );
      evidence({ injectedNotes: injected.notes, leakedBubbles: leak.length });
      info.reply = { truth, obs };
      return { truth, obs };
    });
  }

  await step('整轮运行没有 JS console error / 未捕获异常', async () => {
    const report = classifyConsole(consoleLogs);
    expect(report.jsErrors.length === 0, `出现 ${report.jsErrors.length} 条 JS 错误`, report.jsErrors.slice(0, 5));
    evidence({
      consoleErrorCount: report.jsErrors.length,
      resourceErrors: report.resourceErrors.map((l) => truncate(l.text, 120)).slice(0, 6),
      knownNoiseIgnored: report.knownNoise.length,
      totalLogs: consoleLogs.length,
    });
    return report;
  });
}

function classifyConsole(logs) {
  const jsErrors = [];
  const resourceErrors = [];
  const knownNoise = [];
  const warnings = [];
  for (const l of logs) {
    if (l.kind === 'console' && (l.type === 'error' || l.type === 'assert')) jsErrors.push(l);
    else if (l.kind === 'exception') jsErrors.push(l);
    else if (l.kind === 'log' && l.type === 'error') {
      if (/127\.0\.0\.1:4142|ERR_CONNECTION_REFUSED/.test(l.text)) knownNoise.push(l);
      else resourceErrors.push(l);
    } else if (l.type === 'warning') warnings.push(l);
  }
  return { jsErrors, resourceErrors, knownNoise, warnings };
}

// ── 场景：T1 折叠持久化（真重启进程）────────────────────────────────────────
async function scenarioCollapse() {
  const result = {};
  await step('准备：保证有一台令牌有效的真网关主机，然后重启 app', async () => {
    await attach({ fresh: true });
    const prep = await ensurePairedRealHost();
    await reload();
    await waitReadyWithSessions({ timeout: 60000 });
    evidence({ host: prep.host.id, deviceId: prep.host.deviceId, minted: prep.minted });
    return prep;
  });

  const groupsBefore = await step('读到分组与默认折叠状态', async () => {
    const g = await page('groupPanels()');
    expect(g.length > 0, '没有读到任何工作区组', g);
    const storedBefore = (await readLs('dsh.sessions.collapsed.v1')) || '{}';
    evidence({ groups: g.map((x) => ({ label: x.label, expanded: x.expanded, childCount: x.childCount })) });
    return { groups: g, storedBefore };
  });
  const groups0 = groupsBefore.groups;
  const target = groups0.find((g) => g.expanded) || groups0[0];
  const defaultExpanded = target.expanded;
  const clickHeader = (label) =>
    pageFn(`const bs = qsa('button[aria-expanded]').filter(function (b) { const pid = b.getAttribute('aria-controls'); const p = pid ? document.getElementById(pid) : null; return p && (p.getAttribute('aria-label') || '') === ${JSON.stringify(label)}; });
if (!bs.length) throw new Error('找不到组标题 ' + ${JSON.stringify(label)}); clickEl(bs[0]); return true;`);
  const readGroup = async (label) =>
    (await page(`collapsedPanels().filter(function (g) { return g.label === ${JSON.stringify(label)}; })`))[0];

  await step(`主动折叠「${target.label}」并把状态写进 localStorage`, async () => {
    const before = parseJsonSafe(groupsBefore.storedBefore, {});
    await clickHeader(target.label);
    await sleep(500);
    const after = await readGroup(target.label);
    const raw = await readLs('dsh.sessions.collapsed.v1');
    const now = parseJsonSafe(raw, {});
    expect(after.expanded === false, '折叠没生效', after);

    // 🔴 判据：**有且仅有被点的那个组**从"不是 true"变成了 true。
    //   - 只查"整段 JSON 里有 true"会被别的组蒙混过关（旧实现就栽在这，真机 step 5 才暴露）；
    //   - 只查 label 对应的键也不可靠：界面标签是「X 的会话列表」，存储键却是工作区路径本身。
    // 前后对比是与实现无关的写法，改分组命名也不会假红。
    const flipped = Object.keys(now).filter((k) => now[k] === true && before[k] !== true);
    expect(
      flipped.length === 1,
      `折叠后应有且只有一个组从"展开"变成"折叠"，实际变了 ${flipped.length} 个：${JSON.stringify(flipped)}`,
      { before, now, targetLabel: target.label },
    );
    result.afterToggle = after;
    result.raw = raw;
    result.flippedKey = flipped[0];
    evidence({ after, flippedKey: flipped[0], localStorage: truncate(raw, 400) });
    return after;
  });

  await step('force-stop 真重启 app 进程（pid 必须变 → 重新 forward + 重新附着 CDP）', async () => {
    const { oldPid, newPid } = await restartApp();
    expect(newPid && newPid !== oldPid, `重启后 pid 没有变化（旧 ${oldPid} / 新 ${newPid}）`, { oldPid, newPid });
    evidence({ oldPid, newPid, cdpTarget: cdp.target.url, backgroundedBeforeKill: true });
    return { oldPid, newPid };
  });

  await step(`重开 app 后「${target.label}」仍然是折叠的（不是回落到默认展开）`, async () => {
    await waitReadyWithSessions({ timeout: 60000 });
    const g = await readGroup(target.label);
    expect(g, `重开后找不到组：${target.label}`, g);
    // 🔴 取证必须在**断言之前**：先记下"重启后存储里到底是什么"，才能区分
    // 「写没落盘」与「落盘了但读不出来」—— 只报"变成展开了"等于没查。
    const raw = await readLs('dsh.sessions.collapsed.v1');
    const reloaded = parseJsonSafe(raw, {});
    const storedAfter = result.flippedKey ? reloaded[result.flippedKey] : '(unknown key)';
    evidence({
      afterRestart: g,
      defaultExpanded,
      flippedKey: result.flippedKey,
      storedValueAfterRestart: storedAfter,
      storedKeysAfterRestart: Object.keys(reloaded).slice(0, 6),
      beforeRestart: result.afterToggle,
      localStorage: truncate(raw, 300),
    });
    expect(
      storedAfter === true,
      `重启后存储里这个组不是折叠（stored=${JSON.stringify(storedAfter)}）—— 折叠状态根本没落盘`,
      { flippedKey: result.flippedKey, storedAfter, localStorage: truncate(raw, 300) },
    );
    expect(
      g.expanded === false,
      `存储里明明记着折叠（${result.flippedKey}=true），界面却是展开 —— **读路径**没生效`,
      {
        beforeRestart: result.afterToggle,
        afterRestart: g,
        defaultExpanded,
        flippedKey: result.flippedKey,
        storedAfter,
      },
    );
    result.afterRestart = g;
    return g;
  });

  await step('展开回来（恢复原状）', async () => {
    await clickHeader(target.label);
    await sleep(400);
    const back = await readGroup(target.label);
    expect(back && back.expanded === true, '展开回来失败', back);
    return back;
  });

  return result;
}

// ── 场景：T1 归档 ───────────────────────────────────────────────────────────
async function scenarioArchive() {
  const out = {};

  await step('准备：真网关主机 + 重启 + 展开全部工作区', async () => {
    await attach({ fresh: true });
    await ensurePairedRealHost();
    // 🔴 归档是**本机持久状态**，本场景会真的写它，跑之前必须清干净：
    // 否则第二次运行会"再归档一张卡" → 断言 length===1 永远失败（真机实测踩到）。
    await pageFn(`localStorage.removeItem('dsh.sessions.archived.v1'); return true;`);
    await reload();
    await waitReadyWithSessions({ expectCards: true, timeout: 60000 });
    await expandAllGroups();
    await sleep(400);
    const cards = await page('sessionCards()');
    expect(cards.length > 0, '没有可归档的会话卡片', cards);
    evidence({ cardCount: cards.length, first: cards[0] });
    return cards;
  });

  await step('点「归档」→ 卡片从分组消失、出现在「已归档」区', async () => {
    // 先单独确认"入口存在"：SessionCard 的归档按钮只在 onArchive/onUnarchive 有传时才渲染，
    // 所以"找不到按钮"要报成**集成缺口**，而不是报成语义异常。
    const entry = await pageFn(`return { archiveButtons: qsa('button[aria-label^="归档会话 "]').length,
  restoreButtons: qsa('button[aria-label^="恢复会话 "]').length,
  cards: sessionCards().length };`);
    expect(
      entry.archiveButtons > 0,
      `会话卡片上没有任何「归档」按钮（卡片 ${entry.cards} 个）—— SessionCard 的归档按钮仅在 ` +
        `onArchive/onUnarchive 被传入时渲染，而 App.tsx 渲染 <SessionsScreen ... /> 时**没有传**这两个回调（也没传 archivedIds），` +
        `所以本机归档功能在真 app 里**不可达**（T1 的逻辑与组件都写好了，接线漏了）。`,
      entry,
    );
    const info = await pageFn(`const b = qs('button[aria-label^="归档会话 "]');
if (!b) throw new Error('找不到归档按钮');
const archiveLabel = b.getAttribute('aria-label');
const card = b.closest('.specular-card-interactive');
const openBtn = card ? card.querySelector('button[aria-label^="打开会话 "]') : null;
const openLabel = openBtn ? openBtn.getAttribute('aria-label') : null;
clickEl(b);
return { archiveLabel: archiveLabel, openLabel: openLabel };`);
    await sleep(700);
    const state = await pageFn(`const openLabels = sessionCards().map(function (c) { return c.label; });
return { archived: localStorage.getItem('dsh.sessions.archived.v1'),
  stillVisible: openLabels.indexOf(${JSON.stringify(info.openLabel)}) >= 0,
  section: collapsedPanels().filter(function (g) { return /已归档会话/.test(g.label); }),
  body: flat(bodyText()).slice(0, 220) };`);
    expect(state.archived && JSON.parse(state.archived).length === 1, `归档后 localStorage 归档 id 不对：${state.archived}`, state);

    // ⚠️ 不能用 `sessionCards()` 判断"是否还留在工作区分组"：归档区**也**渲染会话卡片
    // （同样带「打开会话」按钮），所以那样判会永远为真（真机实测踩到）。
    // 正确的判据是：这张卡片是否已经落进「已归档」面板里。
    const moved = await pageFn(`const b = qsa('button[aria-label^="打开会话 "]').filter(function (x) {
  return x.getAttribute('aria-label') === ${JSON.stringify(info.openLabel)}; })[0];
if (!b) return { found: false, inArchived: false };
let n = b, depth = 0, inArchived = false;
while (n && depth < 12) { const t = flat(txtOf(n)); if (/^已归档/.test(t)) { inArchived = true; break; } n = n.parentElement; depth++; }
return { found: true, inArchived: inArchived };`);
    expect(
      moved.found && moved.inArchived,
      '归档后卡片没有移动到「已归档」区（可能仍留在工作区分组里）',
      { moved, state },
    );
    expect(state.section.length > 0, '归档后没有出现「已归档」区', state);
    evidence({ archive: info, localStorage: state.archived, section: state.section, stillVisible: state.stillVisible });
    out.archivedLabel = info.archiveLabel;
    out.archivedIds = state.archived;
    out.openLabel = info.openLabel;
    return info.archiveLabel;
  });

  await step('真重启 app 后归档仍然隐藏（本机归档已落盘）', async () => {
    await restartApp();
    await waitReadyWithSessions({ expectCards: true, timeout: 60000 });
    const state = await pageFn(`const label = ${JSON.stringify(out.openLabel)};
const buttons = qsa('button[aria-label^="打开会话 "]').filter(function (x) { return x.getAttribute('aria-label') === label; });
function inArchived(el) { let n = el, d = 0; while (n && d < 12) { const t = flat(txtOf(n)); if (/^已归档/.test(t)) return true; n = n.parentElement; d++; } return false; }
return { archived: localStorage.getItem('dsh.sessions.archived.v1'),
  section: collapsedPanels().filter(function (g) { return /已归档会话/.test(g.label); }),
  visible: qsa('button[aria-label^="打开会话 "]').length,
  matchCount: buttons.length,
  allInArchived: buttons.length > 0 && buttons.every(inArchived) };`);
    expect(state.archived && JSON.parse(state.archived).length === 1, `重启后 localStorage 归档 id 丢失：${state.archived}`, state);
    expect(state.section.length > 0, '重启后「已归档」区不见了', state);
    // ⚠️ 同 step 2：归档区**也**渲染会话卡片，所以不能用"标签还在不在总列表里"判断，
    // 否则永远为真（真机实测踩到）。要判断这张卡是否**只**落在「已归档」面板里。
    expect(
      state.matchCount >= 1 && state.allInArchived,
      '重启后归档的会话又出现在工作区组里',
      state,
    );
    evidence(state);
    out.afterRestart = state;
    return state;
  });

  await step('展开「已归档」→ 点恢复 → 会话回到工作区分组', async () => {
    await pageFn(`const b = qsa('button[aria-expanded]').filter(function (x) { const pid = x.getAttribute('aria-controls'); const p = pid ? document.getElementById(pid) : null; return p && (p.getAttribute('aria-label') || '') === '已归档会话（仅本机）'; })[0];
if (!b) throw new Error('找不到已归档区标题');
if (b.getAttribute('aria-expanded') !== 'true') clickEl(b);
return true;`);
    await sleep(500);
    const restoreLabels = await page(`qsa('button[aria-label^="恢复会话 "]').map(function (b) { return b.getAttribute('aria-label'); })`);
    expect(restoreLabels.length > 0, '展开归档区后没有「恢复」按钮', restoreLabels);
    await pageFn(`clickEl(qs('button[aria-label^="恢复会话 "]')); return true;`);
    await sleep(700);
    const state = await pageFn(`const openLabels = sessionCards().map(function (c) { return c.label; });
return { archived: localStorage.getItem('dsh.sessions.archived.v1'),
  section: collapsedPanels().filter(function (g) { return /已归档会话/.test(g.label); }).length,
  restoredVisible: openLabels.indexOf(${JSON.stringify(out.openLabel)}) >= 0,
  cardCount: openLabels.length };`);
    expect(state.archived === '[]' || state.archived === null, `恢复后 localStorage 里还有归档 id：${state.archived}`, state);
    expect(state.section === 0, '恢复后「已归档」区应该消失（空区不渲染）', state);
    expect(state.restoredVisible === true, '恢复后卡片没有回到工作区分组', state);
    evidence({ restoreLabels, after: state });
    out.afterRestore = state;
    return state;
  });

  return out;
}

// ── 场景：T2 队列 / 草稿 ────────────────────────────────────────────────────
async function scenarioQueue() {
  const out = {};
  const fake = await startFakeHost({ mode: 'ui' });
  try {
    await step(`启动自带假主机（127.0.0.1:${FAKE_HOST_PORT}）并把 app 指向它`, async () => {
      adb(['reverse', `tcp:${FAKE_HOST_PORT}`, `tcp:${FAKE_HOST_PORT}`]);
      await attach({ fresh: true });
      await seedFakeHost();
      await reload();
      await waitReadyWithSessions({ expectCards: true, timeout: 45000 });
      evidence({ fakeHost: { port: FAKE_HOST_PORT, listCalls: fake.state.listCalls, connections: fake.state.connections } });
      return true;
    });

    await step('打开假主机预置会话 → 历史渲染出来', async () => {
      const opened = await openSessionWithHistory({ maxTries: 1 });
      expect(opened.info.assistantCards >= 1, '假主机预置的助手历史没渲染', opened.info);
      evidence(opened.info);
      return opened.info;
    });

    await step('运行中（running）输入框仍可用，发送按钮变成「加入待发队列」', async () => {
      await pageFn(`setNativeValue(document.querySelector('textarea[aria-label="输入遥控指令"]'), 'E2E-RUN-001'); return true;`);
      await pageFn(`clickEl(qs('button[aria-label="发送"]')); return true;`);
      const running = await until(
        '出现「执行中」状态（running=true）',
        `(function(){ const c = chatInfo(); return { ok: c.hasRunningBadge, info: c }; })()`,
        { timeout: 8000, interval: 120 },
      );
      expect(running.info.inputDisabled === false, 'running 时输入框被禁用了（历史缺陷 Composer(enabled=!running)）', running.info);
      const typed = await pageFn(`const ta = document.querySelector('textarea[aria-label="输入遥控指令"]');
setNativeValue(ta, 'E2E-QUEUED-002');
const sendBtn = document.querySelector('button[aria-label="发送"], button[aria-label="加入待发队列"]');
return { value: ta.value, disabled: ta.disabled, sendLabel: sendBtn ? sendBtn.getAttribute('aria-label') : null };`);
      expect(typed.value === 'E2E-QUEUED-002', 'running 时无法往输入框打字', typed);
      expect(typed.sendLabel === '加入待发队列', `running 时发送按钮语义不对：${typed.sendLabel}`, typed);
      evidence({ running: running.info, afterType: typed });
      out.running = { running: running.info, typed };
      return { running, typed };
    });

    await step('运行中发送 → 进入待发队列 → 删除该条 → 队列消失且没有误发', async () => {
      await pageFn(`const b = document.querySelector('button[aria-label="加入待发队列"]'); if (!b) throw new Error('running 已结束，按钮不是「加入待发队列」'); clickEl(b); return true;`);
      const queued = await until(
        '待发队列出现 1 条',
        `(function(){ const q = queueInfo(); return { ok: q.present && q.removeLabels.length > 0, q: q }; })()`,
        { timeout: 4000, interval: 120 },
      );
      expect(queued.q.text.indexOf('E2E-QUEUED-002') >= 0, '队列里的内容不是刚输入的那条', queued.q);
      const deleteLabel = queued.q.removeLabels[0];
      await pageFn(`clickEl(qs('button[aria-label^="删除第"]')); return true;`);
      const gone = await until('队列条消失', `(function(){ const q = queueInfo(); return { ok: !q.present, q: q }; })()`, { timeout: 5000, interval: 120 });
      await sleep(3500); // 越过队列自动补发的 1.5s 窗口
      const after = await pageFn(`return { queue: queueInfo(),
  misSent: qsa('[class*="rounded-br-xs"]').some(function (el) { return txtOf(el).indexOf('E2E-QUEUED-002') >= 0; }) };`);
      expect(after.misSent === false, '删掉的队列项还是被发出去了（删除没生效）', after);
      evidence({ queued: queued.q, deleteLabel, gone: gone.q, after: after });
      out.queue = { queued: queued.q, gone: gone.q, after };
      return { queued, gone, after };
    });

    await step('发送失败（session/prompt 这一跳被断连）→ 草稿真的保留 + 明确告警 + 落盘', async () => {
      // ⚠️ 必须先等 app 退出 running：running 时按钮语义是「加入待发队列」，
      // 点它只会入队、不会走 session/prompt，也就测不到失败路径。
      // （脚本原来直接找 `aria-label="发送"`，在 running 态必然拿不到 → 报 "元素不存在"。）
      const idle = await until(
        'app 退出执行中，发送按钮回到「发送」',
        `(function(){ const b = qs('button[aria-label="发送"]'); return { ok: !!b, label: b ? b.getAttribute('aria-label') : null, info: chatInfo() }; })()`,
        { timeout: 30000, interval: 300 },
      );
      evidence({ idleBeforeFailure: { label: idle.label, running: idle.info.hasRunningBadge } });

      fake.state.promptSocketDestroy = true;
      const text = 'E2E-DRAFT-003';
      await pageFn(`setNativeValue(document.querySelector('textarea[aria-label="输入遥控指令"]'), ${JSON.stringify(text)}); return true;`);
      await pageFn(`clickEl(document.querySelector('button[aria-label="发送"]')); return true;`);

      // ⚠️ 契约在 T8 之后**变了**（这是变好）：网络层失败不再"报错+留草稿"，
      // 而是把消息**落盘进离线待发队列**，连上后自动补发（草稿因此可以清空）。
      // 所以这里断言的是真正的不变量 —— **字不能丢，且用户必须被告知**：
      //   丢字判定 = 草稿里还在  OR  落进了 outbox
      //   告知判定 = 出现 alert 或 role=status 的轻提示
      const res = await until(
        '出现发送失败告警或离线入队提示',
        `(function(){ const c = chatInfo(); const st = document.querySelector('[role="status"]');
          return { ok: !!c.alertText || !!st, info: c, notice: st ? flat(txtOf(st)) : null,
            outbox: localStorage.getItem('dsh_outbox_v1') }; })()`,
        { timeout: 15000, interval: 250 },
      );
      const inOutbox = (res.outbox || '').indexOf(text) >= 0;
      const draftKept = res.info.inputValue === text;
      expect(
        inOutbox || draftKept,
        `发送失败后字**丢了**：草稿里没有、离线待发队列里也没有（inputValue=${JSON.stringify(res.info.inputValue)}）`,
        res,
      );
      expect(
        !!res.info.alertText || !!res.notice,
        `发送失败后没有任何提示（既没 alert 也没 role=status）—— 用户不知道发生了什么`,
        res,
      );
      evidence({
        path: inOutbox ? '离线入队（落盘，连上自动补发）' : '保留草稿',
        alert: res.info.alertText,
        notice: res.notice,
        inputValue: res.info.inputValue,
        outboxHasText: inOutbox,
        destroyedPromptSockets: fake.state.destroyedPromptSockets,
      });
      out.draft = { path: inOutbox ? 'queued' : 'draft-kept', inputValue: res.info.inputValue, notice: res.notice };

      // 轻提示 5s 自消 —— 之后必须还有一条**持久**的「待发 N 条」指示，
      // 否则用户会以为刚才那条消息凭空消失了（比丢字更让人不安）。
      await sleep(6000);
      const strip = await pageFn(`const b = qsa('button').filter(function (x) { return /(等待补发|待发\\s*\\d+\\s*条|发送失败)/.test(flat(txtOf(x))); })[0];
return { found: !!b, text: b ? flat(txtOf(b)) : null,
  statusNow: (function(){ const s = document.querySelector('[role="status"]'); return s ? flat(txtOf(s)) : null; })(),
  outbox: localStorage.getItem('dsh_outbox_v1') };`);
      expect(
        strip.found,
        `轻提示消失后没有「待发 N 条」的持久指示（role=status 现在=${JSON.stringify(strip.statusNow)}）—— 用户会以为消息没了`,
        strip,
      );
      evidence({ persistentStrip: strip });
      return res.info;
    });

    await step('把 baseUrl 指到真正不可达的端口：连接层如实报错、不伪造会话列表', async () => {
      await seedHosts(
        [
          {
            id: 'host-e2e-dead',
            label: 'E2E 不可达主机',
            baseUrl: 'http://127.0.0.1:9',
            token: 'dead-token',
            deviceId: 'dev-e2e-dead',
            instanceName: '',
            pairedAt: Date.now(),
            lastUsedAt: Date.now(),
          },
        ],
        'host-e2e-dead',
      );
      await reload();
      await sleep(7000);
      const state = await pageFn(`return { body: flat(bodyText()).slice(0, 300), cards: sessionCards().length, netlog: netlog() };`);
      expect(state.cards === 0, `baseUrl 不可达却仍然列出了 ${state.cards} 个会话（伪造成功路径）`, state);
      evidence(state);
      out.deadHost = state;
      return state;
    });
  } finally {
    await fake.stop().catch(() => {});
  }
  return out;
}

// ── 场景：T3 令牌失效 ───────────────────────────────────────────────────────
async function scenarioBadToken() {
  const out = {};
  const RUN_MS = 24000;

  await step('写一枚坏令牌 + 真网关地址，重启 app（干净地重新计时）', async () => {
    adb(['reverse', 'tcp:19387', 'tcp:19387']);
    await attach({ fresh: true });
    await seedHosts(
      [
        {
          id: 'host-e2e-badtoken',
          label: 'E2E 坏令牌主机',
          baseUrl: GATEWAY,
          token: 'e2e-definitely-not-a-valid-token',
          deviceId: 'dev-e2e-badtoken',
          instanceName: '',
          pairedAt: Date.now(),
          lastUsedAt: Date.now(),
        },
      ],
      'host-e2e-badtoken',
    );
    await reload();
    evidence({ token: 'e2e-definitely-not-a-valid-token', baseUrl: GATEWAY });
    return true;
  });

  await step(`观察 ${RUN_MS / 1000}s：只允许 1 次 WS 握手，之后必须停止重连`, async () => {
    await sleep(RUN_MS);
    const net = await page('netlog()');
    expect(net.ws === 1, `WS 握手尝试了 ${net.ws} 次（>1 说明还在无限重连）`, { wsUrls: net.wsUrls, fetchAttempts: net.fetch });
    expect(net.wsUrls.every((u) => u.indexOf('token=***') >= 0), 'WS URL 没有带（被脱敏的）令牌参数', { wsUrls: net.wsUrls });
    evidence({ wsAttempts: net.ws, fetchAttempts: net.fetch, wsUrls: net.wsUrls, fetchUrls: net.fetchUrls.slice(0, 6) });
    out.netlog = net;
    return net;
  });

  await step('UI 明确提示"登录状态已失效 → 重新配对"，而不是静默转圈', async () => {
    const state = await pageFn(`return { body: flat(bodyText()).slice(0, 400),
  hasAuthBanner: /登录状态已失效/.test(bodyText()),
  mentionsRepair: /重新配对/.test(bodyText()) };`);
    expect(state.hasAuthBanner, '界面上没有出现"登录状态已失效"的提示', state);
    expect(state.mentionsRepair, '提示里没有告诉用户去"重新配对"', state);
    evidence(state);
    out.banner = state;
    return state;
  });

  await step('静置再观察 10s：确认真停了（不是刚好在退避窗口里）', async () => {
    const before = await page('netlog()');
    await sleep(10000);
    const after = await page('netlog()');
    expect(after.ws === before.ws, `又新建了 ${after.ws - before.ws} 次 WS —— 重连没有真的停止`, { before, after });
    evidence({ wsBefore: before.ws, wsAfter: after.ws, fetchBefore: before.fetch, fetchAfter: after.fetch });
    out.stopped = { before, after };
    return { before, after };
  });

  return out;
}

// ── 场景：待审批横幅 + 应答 + 重启不再弹 ────────────────────────────────────
async function scenarioApproval() {
  const out = {};
  const EVENT_ID = 'ev-e2e-fixed-1';
  const fake = await startFakeHost({ mode: 'approval', eventId: EVENT_ID, emitDelayMs: 500 });
  try {
    await step('启动假主机（审批模式）并把 app 指向它', async () => {
      adb(['reverse', `tcp:${FAKE_HOST_PORT}`, `tcp:${FAKE_HOST_PORT}`]);
      await attach({ fresh: true });
      await seedFakeHost();
      await reload();
      await waitReadyWithSessions({ timeout: 45000 });
      evidence({ connections: fake.state.connections, openFrames: fake.state.openFrames });
      return true;
    });

    await step('非聊天页（会话列表）也出现「待审批」横幅', async () => {
      const banner = await until(
        '待审批横幅出现',
        `(function(){ const b = qsa('button').filter(function (x) { return /有 1 项待你处理/.test(txtOf(x)); })[0];
      return { ok: !!b, text: b ? flat(txtOf(b)).slice(0, 160) : null }; })()`,
        { timeout: 20000, interval: 300 },
      );
      expect(banner.text && banner.text.indexOf('工具调用需要批准') >= 0, `横幅文案不对：${banner.text}`, banner);
      evidence({ banner: banner.text, waterfalls: fake.state.waterfalls });
      out.banner = banner;
      return banner;
    });

    await step('点横幅「去处理」→ 聊天页出现审批卡片，displayReason 不是 [object Object]', async () => {
      await pageFn(`const b = qsa('button').filter(function (x) { return /有 1 项待你处理/.test(txtOf(x)); })[0]; clickEl(b); return true;`);
      const card = await until(
        '审批卡片渲染',
        `(function(){ const t = flat(bodyText());
      return { ok: /允许一次/.test(t) && /工具调用需要批准/.test(t), text: t.slice(0, 400), hasObjectObject: t.indexOf('[object Object]') >= 0 }; })()`,
        { timeout: 15000, interval: 300 },
      );
      expect(card.hasObjectObject === false, '审批卡片上出现了 [object Object]（displayReason 多语言对象没被正确处理）', card);
      expect(card.text.indexOf('将要执行 rm -rf build/') >= 0, '卡片上没有显示中文 displayReason', card);
      evidence(card);
      out.card = card;
      return card;
    });

    await step('点「允许一次」→ 假主机收到词表内的 allowed-once，且已应答账本落盘', async () => {
      await pageFn(`const b = qs('button[aria-label="允许一次"]'); if (!b) throw new Error('找不到「允许一次」'); clickEl(b); return true;`);
      const deadline = Date.now() + 10000;
      while (fake.state.results.length === 0 && Date.now() < deadline) await sleep(200);
      expect(fake.state.results.length > 0, '假主机没有收到任何应答', fake.state);
      const r = fake.state.results[0];
      expect(r.method === '$events/result', `应答 method 不对：${r.method}`, r);
      expect(r.args.eventId === EVENT_ID, `eventId 不对：${r.args.eventId}`, r);
      expect(r.args.outcome?.value === 'allowed-once', `outcome.value 不在主机词表里：${JSON.stringify(r.args.outcome)}`, r);
      const ledger = await readLs('dsh_answered_events_v1');
      expect(ledger && ledger.indexOf(EVENT_ID) >= 0, `应答成功后落盘账本里没有这个 eventId：${ledger}`, { ledger });
      evidence({ result: r, ledger, waterfalls: fake.state.waterfalls });
      out.result = r;
      out.ledger = ledger;
      return r;
    });

    await step('force-stop 真重启 → 假主机重放同一个 eventId → 不再弹', async () => {
      const before = fake.state.waterfalls;
      // 应答账本刚写完，必须让 WebView flush（见 restartApp 的注释）
      await restartApp();
      const deadline = Date.now() + 20000;
      while (fake.state.waterfalls <= before && Date.now() < deadline) await sleep(300);
      const replayed = fake.state.waterfalls - before;
      await sleep(3000); // 给 UI 反应时间
      const state = await pageFn(`return { banner: qsa('button').filter(function (x) { return /有 1 项待你处理/.test(txtOf(x)); }).length,
  card: /允许一次/.test(bodyText()), onSessions: /遥控会话/.test(bodyText()),
  ledger: localStorage.getItem('dsh_answered_events_v1') };`);
      expect(replayed > 0, `假主机重启后没有重放（waterfalls ${before} → ${fake.state.waterfalls}）`, fake.state);
      expect(state.onSessions, '重启后没有回到会话列表页，断言前提不成立', state);
      expect(state.banner === 0, '重启后又弹了已经应答过的审批（横幅）', state);
      expect(state.card === false, '重启后又弹了已经应答过的审批（卡片）', state);
      evidence({ replayed, state, waterfalls: fake.state.waterfalls, ledger: state.ledger });
      out.afterRestart = { replayed, state };
      return state;
    });
  } finally {
    await fake.stop().catch(() => {});
  }
  return out;
}

// ── 场景：实时过程（用户抱怨的"卡一会儿忽然出结果"）────────────────────────
async function scenarioLive() {
  const out = {};

  await step('准备：真网关主机 + 新建一个空会话（保证过程中出现的内容只可能来自实时流）', async () => {
    await attach({ fresh: true });
    await ensurePairedRealHost();
    await reload();
    await waitReadyWithSessions({ expectCards: true, timeout: 60000 });
    await pageFn(`const b = byText('button', '新建会话'); if (!b) throw new Error('找不到「新建会话」'); clickEl(b); return true;`);
    await until('新建会话对话框', `(function(){ return { ok: bodyText().indexOf('新建遥控会话') >= 0 }; })()`, { timeout: 10000 });
    await pageFn(`const b = byText('button', '创建会话'); if (!b) throw new Error('找不到「创建会话」'); clickEl(b); return true;`);
    const info = await until('进入空会话聊天页', `(function(){ const c = chatInfo(); return { ok: c.onChat && c.timelineChildren <= 3, info: c }; })()`, { timeout: 25000 });
    evidence(info.info);
    return info.info;
  });

  await step('发多步指令 → **运行中**界面必须持续出现中间内容（不是等结束才出结果）', async () => {
    const prompt = '请分两步执行：1) 用工具运行 node -v；2) 再用工具运行 npm -v。每步执行完先说一句"第N步完成"。';
    await pageFn(`const ta = document.querySelector('textarea[aria-label="输入遥控指令"]');
if (!ta) throw new Error('没有输入框'); setNativeValue(ta, ${JSON.stringify(prompt)}); return true;`);
    await pageFn(`const b = document.querySelector('button[aria-label="发送"]') || document.querySelector('button[aria-label="加入待发队列"]');
if (!b) throw new Error('没有发送按钮'); clickEl(b); return true;`);

    const samples = [];
    const seen = { markers: 0, phases: new Set(), labels: new Set(), elapsedSeen: false };
    const deadline = Date.now() + 75000;
    while (Date.now() < deadline) {
      // ⚠️ 过程细节必须**在运行中**采样：轮次结束后过程条本来就不该显示，
      // 放到后面单独采样会永远扑空（第一版就栽在这）。
      const s = await page(`(function(){
        const badge = document.querySelector('[data-testid="activity-badge"]');
        const c = chatInfo();
        return { running: c.hasRunningBadge, children: c.timelineChildren, assistant: c.assistantCards, user: c.userBubbles,
          markers: document.querySelectorAll('[data-testid="step-marker"]').length,
          phase: badge ? badge.getAttribute('data-phase') : null,
          label: badge ? (badge.innerText || '').replace(/\\s+/g, ' ').trim() : null };
      })()`);
      samples.push(s);
      seen.markers = Math.max(seen.markers, s.markers);
      if (s.phase) seen.phases.add(s.phase);
      if (s.label) seen.labels.add(s.label);
      if (/\d+秒|\d+分\d+秒/.test(s.label || '')) seen.elapsedSeen = true;
      if (!s.running && samples.length > 3) break;
      if (samples.length > 90) break;
      await sleep(800);
    }

    const runningSamples = samples.filter((s) => s.running);
    const grewWhileRunning = samples.filter((s, i) => i > 0 && s.running && s.children > samples[i - 1].children).length;
    const maxWhileRunning = runningSamples.length ? Math.max(...runningSamples.map((s) => s.children)) : 0;
    const minWhileRunning = runningSamples.length ? Math.min(...runningSamples.map((s) => s.children)) : 0;
    const last = samples[samples.length - 1];

    evidence({
      sampleCount: samples.length,
      grewWhileRunning,
      minWhileRunning,
      maxWhileRunning,
      last,
      markers: seen.markers,
      phases: [...seen.phases],
      labels: [...seen.labels].slice(0, 6),
      elapsedSeen: seen.elapsedSeen,
      first5: samples.slice(0, 5),
      last3: samples.slice(-3),
    });

    // 🔴 这就是用户抱怨的那条：整个过程界面一动不动，最后忽然出结果。
    expect(
      grewWhileRunning >= 1,
      `运行期间界面一次都没变过（running 时 timelineChildren 恒为 ${minWhileRunning}）—— 用户只会看到"卡住"`,
      { grewWhileRunning, minWhileRunning, maxWhileRunning, samples: samples.slice(0, 12) },
    );
    expect(
      maxWhileRunning > minWhileRunning,
      `running 期间时间线没有增长（min=${minWhileRunning} max=${maxWhileRunning}）`,
      { minWhileRunning, maxWhileRunning },
    );
    out.live = { grewWhileRunning, minWhileRunning, maxWhileRunning };
    out.process = {
      markers: seen.markers,
      phases: [...seen.phases],
      labels: [...seen.labels],
      elapsedSeen: seen.elapsedSeen,
    };
    return out.live;
  });

  await step('过程细节：步骤分隔线 + 「在干什么 + 干了多久」的过程条（运行中采到的）', async () => {
    const seen = out.process || { markers: 0, phases: [], labels: [], elapsedSeen: false };
    evidence({
      markers: seen.markers,
      phases: seen.phases,
      labels: (seen.labels || []).slice(0, 6),
      elapsedSeen: seen.elapsedSeen,
    });

    expect(seen.markers >= 2, `只出现了 ${seen.markers} 条步骤分隔线（step/start 没渲染成"第 N 步"）`, { markers: seen.markers });
    expect(
      (seen.phases || []).some((p) => p && p !== 'unknown'),
      '过程条一直处于 unknown —— 没有把 follow 流归约成过程状态',
      { phases: seen.phases },
    );
    expect(
      (seen.labels || []).some((l) => /分析中|正在调用|第 \d+ 步|准备中/.test(l)),
      `过程条文案里没有"在干什么"：${JSON.stringify((seen.labels || []).slice(0, 4))}`,
      { labels: (seen.labels || []).slice(0, 6) },
    );
    expect(
      (seen.labels || []).some((l) => l !== '执行中'),
      '过程条只显示"执行中"，没有阶段信息 —— 退回旧行为了',
      { labels: (seen.labels || []).slice(0, 4) },
    );
    expect(
      seen.elapsedSeen,
      `过程条从没出现过耗时：${JSON.stringify((seen.labels || []).slice(0, 6))}`,
      { labels: (seen.labels || []).slice(0, 6) },
    );
    // 🔴 过程条/工具卡必须说人话，不能直接甩英文工具名（"正在调用 pwsh"）。
    // 旧实现的 getFriendlyName 只认 run_command/read_file 这类**已不存在的**旧工具名，
    // 于是 DSH 现在的 pwsh/read/web_search 全部原样显示 —— 读起来像日志。
    const all = seen.labels || [];
    expect(
      !all.some((l) => /正在调用\s+[A-Za-z_]+/.test(l)),
      `过程条仍在甩原始工具名：${JSON.stringify(all.filter((l) => /正在调用\s+[A-Za-z_]+/.test(l)).slice(0, 3))}`,
      { labels: all.slice(0, 6) },
    );
    expect(
      all.some((l) => /执行命令|深度搜索|抓取网页|读取文件|搜索代码|浏览目录|查看图片|更新任务板|检查运行时/.test(l)),
      `过程条全程没有出现人话动作：${JSON.stringify(all.slice(0, 6))}`,
      { labels: all.slice(0, 6) },
    );
    return { markers: seen.markers, phases: seen.phases };
  });

  await step('实时流不会把历史吃掉：用户与助手内容都还在', async () => {
    // ⚠️ 不要断言「节点数 ≥ 运行期间的峰值」：流式过程中会先出现"执行中…"占位卡，
    // 结果回来后占位卡被真正的结果卡替换，节点数**可能变少**——那是正常的，不是丢历史。
    // 这里断言真正的不变量：过程结束后，已经出现过的用户与助手内容都还在。
    const final = await until(
      '历史仍在（至少一条用户内容 + 一条助手内容）',
      `(function(){ const c = chatInfo(); return { ok: c.userBubbles >= 1 && c.assistantCards >= 1, info: c }; })()`,
      { timeout: 60000, interval: 800 },
    );
    const peak = (out.live && out.live.maxWhileRunning) || 0;
    evidence({ peakWhileRunning: peak, final: final.info });
    return final.info;
  });

  return out;
}

// ── 场景：底部状态栏（轮/步/tok-s、token 与缓存命中、上下文占用）────────────
async function scenarioStats() {
  const out = {};

  await step('准备：真网关主机 + 打开一个真的跑过很多轮的真实会话', async () => {
    await attach({ fresh: true });
    await ensurePairedRealHost();
    const list = await hostRpc('session/list', { _request: {} });
    // hostRpc 返回的是**已解包**的 value（本脚本其他场景都这么用）；
    // 兼容没解包的形状，免得又一次 count=0。
    const rows = (list && Array.isArray(list.items) ? list.items : (list && list.value && list.value.items) || []);
    const items = rows.filter((s) => s.origin !== 'subagent' && !s.blank).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    expect(items.length > 0, '这台主机没有可用的真实会话', { count: items.length });
    const target = items[0];
    out.session = { sessionId: target.sessionId, title: target.projections?.values?.title };

    await reload();
    await waitReadyWithSessions({ expectCards: true, timeout: 60000 });
    await expandAllGroups();
    await sleep(500);
    // 卡片可能在「显示更多」之外，先点开全部再找
    const clicked = await pageFn(`const want = ${JSON.stringify(`打开会话 ${out.session.title}`)};
const card = qs('[data-session-id="' + ${JSON.stringify(out.session.sessionId)} + '"]');
if (!card) return 'no-card';
const b = card.querySelector('button[aria-label^="打开会话 "]');
if (!b) return 'no-open-btn';
clickEl(b); return 'clicked';`);
    expect(clicked === 'clicked', `没能打开目标会话的卡片：${clicked}`, out.session);
    evidence({ target: out.session });
    return out.session;
  });

  await step('状态栏读数必须与宿主 session/projections 的真值一致', async () => {
    // 判定基准取**宿主**（真主机实测：session/projections 的 args 是扁平的 {request:{sessionId}}，
    // 注意 {request:{address:{...}}} 会被边界校验拒；session/list 里没有这些字段）
    const proj = await hostRpc('session/projections', { request: { sessionId: out.session.sessionId } });
    const v = (proj && proj.values ? proj.values : (proj && proj.value && proj.value.values)) || {};
    const s = v.sessionStats || {};
    const u = v.tokenUsage || {};
    const c = v.contextPressure || {};
    const billed = (u.uncachedInputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
    const truth = {
      turns: s.turns,
      steps: s.steps,
      tps: s.decodeMs ? Math.round(s.decodeTokens / (s.decodeMs / 1000)) : null,
      hit: billed ? Math.round(((u.cacheReadTokens || 0) / billed) * 1000) / 10 : null,
      ctx: c.contextWindow ? Math.round(((c.pressureTokens || 0) / c.contextWindow) * 1000) / 10 : null,
      raw: { sessionStats: s, tokenUsage: u, contextPressure: c },
    };

    const bar = await until(
      '状态栏出现',
      `(function(){ const el = document.querySelector('[data-testid="session-stats"]'); return { ok: !!el, text: el ? (el.innerText||'').replace(/\\s+/g,' ').trim() : null }; })()`,
      { timeout: 20000, interval: 600 },
    );
    evidence({ truth, bar: bar.text });

    expect(bar.text && bar.text.length > 0, '状态栏没渲染出任何读数', bar);
    if (truth.turns) {
      expect(
        bar.text.includes(`${truth.turns} 轮 ${truth.steps} 步`),
        `轮/步对不上：宿主 ${truth.turns} 轮 ${truth.steps} 步，界面「${bar.text}」`,
        { truth, bar: bar.text },
      );
    }
    if (truth.tps) {
      expect(
        bar.text.includes(`${truth.tps} tok/s`),
        `tok/s 对不上：宿主 ${truth.tps} tok/s，界面「${bar.text}」`,
        { truth, bar: bar.text },
      );
    }
    if (truth.hit) {
      expect(
        bar.text.includes(`缓存命中 ${truth.hit}%`),
        `缓存命中率对不上：宿主 ${truth.hit}%，界面「${bar.text}」`,
        { truth, bar: bar.text },
      );
    }
    if (truth.ctx) {
      expect(
        bar.text.includes(`${truth.ctx}%`),
        `上下文占用对不上：宿主 ${truth.ctx}%，界面「${bar.text}」`,
        { truth, bar: bar.text },
      );
    }
    out.bar = bar.text;
    return bar.text;
  });

  await step('点开明细：模型耗时 / 工具耗时 / 首字延迟 / 缓存桶 / 上下文构成', async () => {
    await pageFn(`const b = qs('[data-testid="session-stats"] button'); if (!b) throw new Error('状态栏没有可点的按钮'); clickEl(b); return true;`);
    const detail = await until(
      '明细展开',
      `(function(){ const el = document.querySelector('[data-testid="session-stats-detail"]'); return { ok: !!el, text: el ? (el.innerText||'').replace(/\\s+/g,' ').trim() : null }; })()`,
      { timeout: 8000, interval: 400 },
    );
    evidence(detail);
    for (const row of ['模型耗时', '工具耗时', '首字延迟', '缓存命中', '上下文']) {
      expect((detail.text || '').includes(row), `明细里没有「${row}」：${truncate(detail.text || '', 300)}`, detail);
    }
    return detail;
  });

  return out;
}

// ── 场景：建会话必须落在真工作区（用户报"手机建的会话电脑不显示"）──────────
async function scenarioCreateCwd() {
  const PROFILE_DIR = /[\\/]\.dsh[\\/](profiles|sessions)[\\/]/i;

  await step('准备：配对真主机 → 进入会话列表', async () => {
    await attach({ fresh: true });
    await ensurePairedRealHost();
    await reload();
    await waitReadyWithSessions({ expectCards: true, timeout: 60000 });
    return 'ok';
  });

  const created = await step('**不选工作区**直接建会话 → 宿主里的新会话必须落在真工作区', async () => {
    const before = await hostRpc('session/list', { _request: {} });
    const beforeIds = new Set(((before && before.items) || []).map((s) => s.sessionId));

    await pageFn(`const b = byText('button', '新建会话'); if (!b) throw new Error('找不到「新建会话」'); clickEl(b); return true;`);
    await until('新建会话对话框', `(function(){ return { ok: bodyText().indexOf('新建遥控会话') >= 0 }; })()`, { timeout: 10000 });
    // 故意清空 cwd：这正是用户遇到的路径（不选工作区就点创建）
    await pageFn(`const el = document.querySelector('#dsh-create-cwd');
if (!el) throw new Error('找不到工作区输入框 #dsh-create-cwd');
setNativeValue(el, '');
return el.value;`);
    await pageFn(`const b = byText('button', '创建会话'); if (!b) throw new Error('找不到「创建会话」'); clickEl(b); return true;`);
    await until('进入新会话聊天页', `(function(){ const c = chatInfo(); return { ok: c.onChat, info: c }; })()`, { timeout: 25000 });

    // 以**宿主**为准找出这个新会话
    const after = await hostRpc('session/list', { _request: {} });
    const fresh = ((after && after.items) || [])
      .filter((s) => !beforeIds.has(s.sessionId))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    expect(!!fresh, '宿主里找不到新建的会话 —— 说明 session/create 根本没成功（界面却在假装成功）', {
      beforeCount: beforeIds.size,
      afterCount: ((after && after.items) || []).length,
    });
    evidence({ sessionId: fresh.sessionId, cwd: fresh.cwd, blank: fresh.blank });

    // 🔴 核心断言：绝不能落在 .dsh\profiles\desktop（那样桌面按 Workspace 分组时找不到）
    expect(
      !PROFILE_DIR.test(String(fresh.cwd || '')),
      `新会话落在了 profile 目录「${fresh.cwd}」—— 桌面版按 Workspace 实体分组，这个会话在电脑上不会出现。` +
        `（根因：session/create 没带 cwd，主机就丢进 .dsh\\profiles；实测 2026-10-15）`,
      { cwd: fresh.cwd },
    );
    expect(
      typeof fresh.cwd === 'string' && fresh.cwd.trim().length > 0,
      `新会话没有 cwd（${JSON.stringify(fresh.cwd)}）`,
      { cwd: fresh.cwd },
    );
    // 还要能对上"已知工作区"里的某一个，否则依然进不了桌面的分组
    const known = new Set(
      ((after && after.items) || [])
        .map((s) => s.cwd)
        .filter((c) => typeof c === 'string' && c.trim() && !PROFILE_DIR.test(c)),
    );
    expect(
      known.has(fresh.cwd),
      `新会话的 cwd「${fresh.cwd}」不属于任何一个已知工作区，桌面侧依然看不见`,
      { known: [...known].slice(0, 6) },
    );
    return { sessionId: fresh.sessionId, cwd: fresh.cwd, blank: fresh.blank };
  });

  await step('界面如实提示：发出第一条消息后电脑端才看得见（桌面隐藏空白会话）', async () => {
    // 建完会话 App 会直接进聊天页，而提示条渲染在**会话列表页** —— 先返回列表
    await backToSessions();
    const res = await until(
      '会话列表出现建会话提示条',
      `(function(){ const el = document.querySelector('[data-testid="create-notice"]'); return { ok: !!el, text: el ? (el.innerText || '').replace(/\\s+/g,' ').trim() : '' }; })()`,
      { timeout: 10000, interval: 500 },
    );
    evidence(res.text);
    expect(
      (res.text || '').includes('发出第一条消息后电脑端才会看到它'),
      `没有给用户解释"空白会话在电脑端不显示"—— 用户会以为会话丢了。实际提示条内容：${truncate(res.text || '(空)', 240)}`,
      { text: res.text },
    );
    expect(
      (res.text || '').includes('已在「') && (res.text || '').includes(created.cwd),
      `提示里没有写明会话建在哪个工作区（期望包含「${created.cwd}」）`,
      { text: res.text },
    );
    return 'ok';
  });

  return { created };
}

// ── 场景：T7 聊天可读性（超长消息折叠）──────────────────────────────────────
async function scenarioReadability() {
  const out = {};

  const target = await step('找一个含**长助手消息**的真实会话（判定基准取宿主记录）', async () => {
    await attach({ fresh: true });
    await ensurePairedRealHost();
    const list = await hostRpc('session/list', { _request: {} });
    const items = (list && list.items ? list.items : (list && list.value && list.value.items) || [])
      .filter((s) => s.origin !== 'subagent')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 16);
    // 🔴 样本必须是**助手**的长消息，不能是用户消息：
    // 用户那条超长文本多半是宿主注入的上下文（运行时上下文 / 记忆快照），
    // 现在渲染成"注记"而不是折叠消息 —— 拿它当样本，这个场景就永远测不到折叠本身。
    let found = null;
    for (const s of items) {
      let recs = [];
      try {
        recs = await hostPageRecords(s.sessionId);
      } catch {
        continue;
      }
      let longest = '';
      for (const r of recs) {
        if (r.event?.type !== 'assistant/message') continue;
        const c = r.event?.data?.message?.content;
        if (!Array.isArray(c)) continue;
        const text = c
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n');
        if (text.length > longest.length) longest = text;
      }
      if (longest.length > 600) {
        found = { sessionId: s.sessionId, title: s.projections?.values?.title || s.title, chars: longest.length };
        break;
      }
    }
    expect(
      !!found,
      `最近 ${items.length} 个会话里找不到超过 600 字的**助手**消息，无法验证折叠（需要一条长消息做样本）`,
      { scanned: items.length, titles: items.map((s) => s.projections?.values?.title || s.title).slice(0, 6) },
    );
    evidence(found);
    out.target = found;
    return found;
  });

  await step('打开该会话 → 超长消息**默认折叠**（data-collapsed=true，全文不进 DOM）', async () => {
    await reload();
    await waitReadyWithSessions({ expectCards: true, timeout: 60000 });
    await expandAllGroups();
    await sleep(400);

    let present = await pageFn(`return !!qs('[data-session-id="${target.sessionId}"]');`);
    if (!present) {
      // 目标会话可能落在每组 12 条上限之外：把所有「显示更多」都点开
      for (let i = 0; i < 12; i += 1) {
        const clicked = await pageFn(`const b = qsa('button').filter(function (x) { return /显示更多/.test(txtOf(x)); })[0];
if (!b) return false; clickEl(b); return true;`);
        if (!clicked) break;
        await sleep(300);
      }
      present = await pageFn(`return !!qs('[data-session-id="${target.sessionId}"]');`);
    }
    expect(present, `该会话的卡片没有渲染出来（sid=${target.sessionId}）`, { target });

    await pageFn(`const c = qs('[data-session-id="${target.sessionId}"]');
const b = c && c.querySelector('button[aria-label^="打开会话 "]');
if (!b) throw new Error('找不到「打开会话」按钮'); clickEl(b); return true;`);

    const collapsed = await until(
      '聊天页出现折叠消息',
      `(function(){ const els = qsa('[data-collapsed="true"]');
        return { ok: els.length >= 1, info: chatInfo(), collapsedCount: els.length,
          fullChars: els[0] ? Number(els[0].getAttribute('data-full-chars')) : null }; })()`,
      { timeout: 25000 },
    );
    expect(
      Number(collapsed.fullChars) > 600,
      `折叠标记的中文长度不对（data-full-chars=${collapsed.fullChars}）`,
      collapsed,
    );
    // 🔴 折叠的意义是**正文只占 6 行左右**，不是"全文没进 DOM"：
    // markdown 走 maxHeight 裁剪（要保住代码块/表格布局），文本仍在 DOM 里只是视觉裁掉；
    // 而且被测元素是**整张卡**（含标题行、复制条、页脚），高度里混了固定 chrome。
    // 真机实测踩过两个坑：① 用 innerText 量长度 → 裁剪后仍报 2300+ 字，假红；
    // ② 量整卡高度 → 279px 超阈值，又一次假红。正确做法：量**正文容器**的高度。
    const box = await pageFn(`const el = qs('[data-collapsed="true"]');
if (!el) return { h: -1, bodyH: -1 };
var body = el.querySelector('[data-collapsed-body]') || el;
var r = body.getBoundingClientRect();
return { cardH: Math.round(el.getBoundingClientRect().height), bodyH: Math.round(r.height),
  lines: Math.round(r.height / 22) };`);
    expect(
      box.bodyH > 0 && box.bodyH <= 200,
      `折叠后正文仍占 ${box.bodyH}px（≈${box.lines} 行）—— 一屏会被它淹没`,
      { ...box, fullChars: collapsed.fullChars },
    );
    evidence({ collapsed, box });
    out.collapsed = { ...collapsed, box };
    return collapsed;
  });

  await step('点「展开全部」→ 全文进 DOM（data-expanded=true）', async () => {
    const before = await pageFn(`return { collapsed: qsa('[data-collapsed="true"]').length,
  expanded: qsa('[data-expanded="true"]').length };`);
    await pageFn(`const b = qs('button[aria-label^="展开全部"]');
if (!b) throw new Error('没有「展开全部」按钮'); clickEl(b); return true;`);
    await sleep(600);
    const after = await pageFn(`return { collapsed: qsa('[data-collapsed="true"]').length,
  expanded: qsa('[data-expanded="true"]').length };`);
    expect(
      after.expanded > before.expanded,
      `点「展开全部」后 data-expanded 没有增加（${JSON.stringify(before)} → ${JSON.stringify(after)}）`,
      { before, after },
    );
    evidence({ before, after });
    out.expanded = after;
    return after;
  });

  return out;
}

// ── 场景：T6 会话管理（每组渲染上限 / 操作菜单 / 重命名）────────────────────
async function scenarioSessionOps() {
  const out = {};
  const NEW_TITLE = 'E2E 重命名验证 ' + Math.floor(Date.now() / 1000);

  await step('准备：真网关主机 + 重启 + 展开全部工作区', async () => {
    await attach({ fresh: true });
    await ensurePairedRealHost();
    await reload();
    await waitReadyWithSessions({ expectCards: true, timeout: 60000 });
    await expandAllGroups();
    await sleep(500);
    const summary = await pageFn(`return { cards: sessionCards().length,
  more: qsa('button').filter(function (b) { return /显示更多/.test(txtOf(b)); }).length };`);
    evidence(summary);
    return summary;
  });

  await step('每组默认只渲染 12 条，且有「显示更多（还剩 N 条）」', async () => {
    const cap = await pageFn(`const more = qsa('button').filter(function (b) { return /显示更多/.test(txtOf(b)); });
return { cards: sessionCards().length, more: more.length, moreTexts: more.map(function (b) { return flat(txtOf(b)); }).slice(0, 4) };`);
    expect(
      cap.more > 0,
      `没有任何「显示更多」按钮（渲染 ${cap.cards} 张卡）—— 说明这台主机每个组都不超过 12 条，无法验证上限`,
      cap,
    );
    expect(
      /还剩\s*\d+\s*条/.test(cap.moreTexts.join(' ')),
      `「显示更多」文案里没有剩余条数：${JSON.stringify(cap.moreTexts)}`,
      cap,
    );
    evidence(cap);
    return cap;
  });

  await step('点「显示更多」→ 该组渲染出更多卡片', async () => {
    const before = await pageFn(`return { cards: sessionCards().length };`);
    await pageFn(`const b = qsa('button').filter(function (x) { return /显示更多/.test(txtOf(x)); })[0];
if (!b) throw new Error('没有「显示更多」按钮'); clickEl(b); return true;`);
    await sleep(600);
    const after = await pageFn(`return { cards: sessionCards().length,
  more: qsa('button').filter(function (b) { return /显示更多/.test(txtOf(b)); }).length };`);
    expect(
      after.cards > before.cards,
      `点了「显示更多」但卡片数没有增加（${before.cards} → ${after.cards}）`,
      { before, after },
    );
    evidence({ before, after });
    return after;
  });

  await step('卡片「更多操作」→ 菜单出现且条目齐全（重命名/复制 id/归档…）', async () => {
    await pageFn(`const b = qs('button[aria-label^="更多操作 "]');
if (!b) throw new Error('没有「更多操作」按钮'); clickEl(b); return true;`);
    await sleep(350);
    const menu = await pageFn(`const d = qs('[data-testid="session-action-menu"]');
return { open: !!d, text: d ? flat(txtOf(d)) : null,
  actions: qsa('[data-action]').map(function (x) { return x.getAttribute('data-action'); }) };`);
    expect(menu.open, '操作菜单没有打开', menu);
    for (const label of ['重命名', '复制会话 id', '本地归档']) {
      expect((menu.text || '').indexOf(label) >= 0, `菜单里没有「${label}」：${menu.text}`, menu);
    }
    expect(menu.actions.indexOf('rename') >= 0, `菜单缺少 rename 条目：${JSON.stringify(menu.actions)}`, menu);
    evidence(menu);
    out.menu = menu;
    return menu;
  });

  await step('重命名一次性会话 → 卡片就地更新，且**宿主真值**同步', async () => {
    // 在宿主上新建一个一次性会话（不改用户既有会话），随后用真机 UI 给它改名
    const created = await hostRpc('session/create', { request: { cwd: ROOT } });
    const sid = created && created.sessionId;
    expect(!!sid, `宿主没有返回新会话 id：${JSON.stringify(created)}`, created);

    await reload();
    await waitReadyWithSessions({ expectCards: true, timeout: 60000 });
    await expandAllGroups();
    await sleep(600);

    // 卡片自带 `data-session-id`，用它精确定位。
    // ⚠️ 不要用标题定位：新建的会话标题是"未命名会话"，多跑几次就不唯一（实测踩到）。
    const probe = await pageFn(`const sid = ${JSON.stringify(sid)};
const card = qs('[data-session-id="' + sid + '"]');
const ids = qsa('[data-session-id]').map(function (x) { return x.getAttribute('data-session-id'); });
return { sid, found: !!card, renderedIds: ids.slice(0, 10), renderedCount: ids.length,
  inBody: flat(bodyText()).indexOf(sid) >= 0 };`);
    expect(
      probe.found,
      `新建的会话卡片没有渲染出来（sid=${sid}）。当前渲染的 id 前 10 个=${JSON.stringify(probe.renderedIds)}` +
        `（可能落在每组 12 条的上限之外）`,
      probe,
    );
    evidence({ probe });

    await pageFn(`const card = qs('[data-session-id="${sid}"]');
if (!card) throw new Error('找不到会话卡片'); 
const b = card.querySelector('button[aria-label^="更多操作 "]');
if (!b) throw new Error('卡片上没有「更多操作」按钮'); clickEl(b); return true;`);
    await sleep(350);
    await pageFn(`const item = qs('[data-action="rename"]'); if (!item) throw new Error('菜单里没有 rename'); clickEl(item); return true;`);
    await sleep(350);
    await pageFn(`const input = qs('#dsh-rename-input'); if (!input) throw new Error('没有重命名输入框');
setNativeValue(input, ${JSON.stringify(NEW_TITLE)}); return true;`);
    await pageFn(`const btn = qsa('button').filter(function (b) { return flat(txtOf(b)) === '保存'; })[0];
if (!btn) throw new Error('没有「保存」按钮'); clickEl(btn); return true;`);

    // 判定基准取**宿主记录**：UI 乐观更新不算数
    let hostTitle = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const list = await hostRpc('session/list', { _request: {} });
        const row = (list && list.items ? list.items : []).find((s) => s.sessionId === sid);
        hostTitle = (row && row.projections && row.projections.values && row.projections.values.title) || null;
        if (hostTitle === NEW_TITLE) break;
      } catch {
        /* 继续等 */
      }
      await sleep(800);
    }
    await sleep(500);
    const ui = await pageFn(`return { hasNewTitle: qsa('button[aria-label^="打开会话 "]').some(function (b) { return b.getAttribute('aria-label').indexOf(${JSON.stringify(NEW_TITLE)}) >= 0; }),
  cards: sessionCards().length };`);

    expect(hostTitle === NEW_TITLE, `宿主的会话标题没有改成「${NEW_TITLE}」（实际 ${JSON.stringify(hostTitle)}）`, { sid, hostTitle });
    expect(ui.hasNewTitle, '卡片没有就地显示新标题', { sid, ui });
    evidence({ sid, hostTitle, ui, newTitle: NEW_TITLE });
    out.rename = { sid, hostTitle, ui };
    return { sid, hostTitle };
  });

  return out;
}

// ── 收尾：把设备指回真网关（并验证令牌真的有效）─────────────────────────────
async function ensureRealHost() {
  const prep = await ensurePairedRealHost();
  return { hostId: prep.host.id, deviceId: prep.host.deviceId, minted: prep.minted };
}

// ── main ────────────────────────────────────────────────────────────────────
async function runScenario(name, ctx) {
  switch (name) {
    case 'chain':
      return scenarioChain(ctx);
    case 'collapse':
      return scenarioCollapse();
    case 'archive':
      return scenarioArchive();
    case 'queue':
      return scenarioQueue();
    case 'session-ops':
      return scenarioSessionOps();
    case 'readability':
      return scenarioReadability();
    case 'live':
      return scenarioLive();
    case 'stats':
      return scenarioStats();
    case 'create-cwd':
      return scenarioCreateCwd();
    case 'bad-token':
      return scenarioBadToken();
    case 'approval':
      return scenarioApproval();
    default:
      throw new Error(`未知场景：${name}（可选 chain|collapse|archive|queue|session-ops|readability|bad-token|approval|all）`);
  }
}

async function main() {
  const started = Date.now();
  log(`${C.b}DSH Native Mobile · 整 app 端到端（CDP 驱动 WebView）${C.x}`);
  log(`${C.d}  场景=${SCENARIO}  设备=${SERIAL}  CDP=${CDP_PORT}  repo=${ROOT}${C.x}\n`);

  const adbInfo = resolveAdb();
  ADB = adbInfo.bin;
  note(`adb = ${ADB} (${adbInfo.version})`);

  const list = SCENARIO === 'all' ? ['chain', 'collapse', 'archive', 'queue', 'session-ops', 'readability', 'live', 'stats', 'create-cwd', 'bad-token', 'approval'] : [SCENARIO];
  const results = [];
  let failed = null;

  try {
    await attach({ fresh: false });
    const pre = await snapshotState();
    note(`运行前 localStorage 键：${Object.keys(pre).join(', ') || '(空)'}`);
  } catch (err) {
    log(`${C.y}  ⚠ 预读 localStorage 失败（继续）：${err.message}${C.x}`);
  }

  for (const name of list) {
    stepNo = 0;
    steps.length = 0;
    consoleLogs = [];
    log(`\n${C.b}── 场景 ${name} ──${C.x}`);
    try {
      const out = await runScenario(name, { clean: !KEEP_STATE && name === 'chain' });
      results.push({ scenario: name, ok: true, steps: steps.map((s) => ({ ...s })), output: out });
    } catch (err) {
      results.push({
        scenario: name,
        ok: false,
        steps: steps.map((s) => ({ ...s })),
        error: err.message,
        failedStep: err.step || null,
        evidence: err.evidence,
      });
      failed = { scenario: name, step: err.step || null, error: err, results };
      break;
    }
  }

  // 收尾：把设备指回真网关（除非显式 --keep-state）
  if (!KEEP_STATE) {
    try {
      if (!cdp) await attach({ fresh: false });
      const restored = await ensureRealHost();
      await reload();
      results.push({ scenario: 'cleanup', ok: true, output: restored });
      note(`收尾：设备已指回真网关（host ${restored.hostId}）`);
    } catch (err) {
      log(`${C.y}  ⚠ 收尾恢复主机失败（不影响判定）：${err.message}${C.x}`);
      results.push({ scenario: 'cleanup', ok: false, error: err.message });
    }
  }

  // 撤销本次临时铸造、且最终没在用的设备令牌
  const keepDeviceIds = new Set(['dev-e2e-fake']);
  try {
    const dump = await pageFn('return localStorageDump();');
    for (const h of JSON.parse(dump.dsh_hosts_v1 || '[]')) if (h?.deviceId) keepDeviceIds.add(h.deviceId);
  } catch {
    /* ignore */
  }
  const revoked = [];
  for (const id of mintedDevices) {
    if (id && !keepDeviceIds.has(id)) {
      await revokeDevice(id);
      revoked.push(id);
    }
  }

  const summary = {
    scenario: SCENARIO,
    ok: !failed,
    durationMs: Date.now() - started,
    failedStep: failed?.step || null,
    error: failed?.error?.message || null,
    results,
    revokedDevices: revoked,
  };

  log('');
  if (failed) {
    log(`${C.r}${C.b}✗ 失败：场景 ${failed.scenario}，具体失败步骤「${failed.step}」${C.x}`);
    log(`${C.r}  ${failed.error.message}${C.x}`);
  } else {
    log(`${C.g}${C.b}✓ 全部通过：${list.join(' / ')}${C.x}`);
  }
  log(`${C.d}  用时 ${Math.round((Date.now() - started) / 1000)}s；吊销临时设备 ${revoked.length} 台${C.x}`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2), 'utf8');
    note(`证据已写入 ${JSON_OUT}`);
  }
  log(`\nEVIDENCE_JSON ${JSON.stringify({ ok: summary.ok, scenario: summary.scenario, failedStep: summary.failedStep, error: summary.error, revoked: revoked.length })}`);

  if (cdp) cdp.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  log(`${C.r}${C.b}✗ 脚本自身异常：${err?.stack || err}${C.x}`);
  if (cdp) cdp.close();
  process.exit(1);
});