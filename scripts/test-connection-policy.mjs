/**
 * 连接层策略回归测试（T3）。
 *
 * 覆盖三处**已在代码里核实的真实缺陷**，全部离线、零依赖、不碰真实网络：
 *
 *   ① 401/403 无分流 + onclose 无条件 3s 重连 = 无限重试死循环
 *      → `classifyClose` / `isAuthStatus` / 连接级：401 之后**不得**再排任何重连定时器
 *   ② eventId 去重只在内存（`answeredEventIds: Set`）→ App 重启后重复弹已处理的审批
 *      → `createAnsweredLedger` 落盘/读回/容量 + 连接级：重启（新建实例）后不再弹
 *   ③ 所有手机都叫 "Web Remote Client" → 网关按 `platform + name` 合并设备记录、互相顶下线
 *      → `uniqueDeviceName` / `getOrCreateDeviceId`
 *
 * 运行：
 *
 *     node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs \
 *          scripts/test-connection-policy.mjs
 *
 * （`--import` 的解析 hook 见 scripts/ts-resolve-hook.mjs：源码内部是无扩展名的
 *   打包器风格导入，Node 原生解析不了。）
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DEVICE_BASE_NAME,
  DEVICE_ID_KEY,
  DEVICE_NAME_MAX_LENGTH,
  generateDeviceId,
  getOrCreateDeviceId,
  sanitizeDeviceId,
  stripDeviceSuffix,
  uniqueDeviceName,
} from '../src/services/device.ts';
import {
  ANSWERED_LEDGER_CAPACITY,
  ANSWERED_LEDGER_KEY,
  ANSWERED_LEDGER_VERSION,
  HostStore,
  createAnsweredLedger,
} from '../src/services/store.ts';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DshConnection,
  classifyClose,
  isAuthStatus,
  nextBackoff,
} from '../src/services/connection.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

// ── 极简断言（与 test-approval-contract.mjs / test-markdown.mjs 同风格，零依赖）──

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

async function checkAsync(group, name, fn) {
  try {
    await fn();
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

// ── 测试替身（假存储 / 假时钟 / 假 socket / 假 fetch）────────────────────────

function createFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map),
  };
}

function createFakeClock() {
  let seq = 0;
  const handles = [];
  return {
    handles,
    setTimeout(fn, ms) {
      const h = { id: (seq += 1), fn, ms, cleared: false, fired: false };
      handles.push(h);
      return h;
    },
    clearTimeout(h) {
      if (h) h.cleared = true;
    },
    pending() {
      return handles.filter((h) => !h.cleared && !h.fired);
    },
    last() {
      const p = this.pending();
      return p[p.length - 1] ?? null;
    },
    lastMs() {
      const t = this.last();
      if (!t) throw new Error('没有待触发的定时器');
      return t.ms;
    },
    fire(t) {
      if (!t) throw new Error('没有待触发的定时器');
      if (t.cleared) throw new Error('定时器已被清除，不应触发');
      t.fired = true;
      t.fn();
      return t;
    },
    fireLast() {
      return this.fire(this.last());
    },
  };
}

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.closeCalls = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.closeCalls += 1;
    // 真实 WebSocket 的 close 之后会触发 onclose（我们安装了回调才触发）
    if (typeof this.onclose === 'function') this.onclose({ code: 1000, reason: 'client-close' });
  }

  open() {
    if (typeof this.onopen === 'function') this.onopen();
  }

  emitFrame(frame) {
    if (typeof this.onmessage === 'function') this.onmessage({ data: JSON.stringify(frame) });
  }

  emitStreamItem(value) {
    this.emitFrame({ type: 'item', value });
  }

  /** 模拟"连接被关闭"：浏览器对握手 401/403 也只给 1006。 */
  drop(code = 1006, reason = '') {
    if (typeof this.onclose === 'function') this.onclose({ code, reason });
  }
}

const RPC_OK = { result: { ok: true, value: { items: [] } } };
const RPC_EVENT_OK = { result: { ok: true, value: { ok: true } } };

/** 假 fetch：按 URL 路由，返回与 Response 结构兼容的最小对象。 */
function createFakeFetch(routes = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    const route =
      (url.includes('/$events/result') && routes.respond) ||
      (url.includes('/session/list') && routes.sessionList) ||
      routes.default ||
      { status: 200, json: RPC_OK };
    if (route.throw) throw new TypeError(route.throw);
    if (route.hang) {
      // 网络黑洞：一直不返回，直到被 AbortController 打断
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) reject(new Error('aborted'));
        else signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (typeof route.json === 'function' ? route.json() : route.json ?? RPC_OK),
    };
  };
  impl.calls = calls;
  return impl;
}

/** 让微任务（fetch 的 await 链）跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function createHarness({ fetchRoutes = {}, fakeStorage = createFakeStorage(), backoffRandom = 0.5, watchdogMs = 0 } = {}) {
  const clock = createFakeClock();
  const sockets = [];
  const fetchImpl = createFakeFetch(fetchRoutes);
  const conn = new DshConnection('http://127.0.0.1:4142', 'token-abc', 'MacBook', {
    WebSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    fetch: fetchImpl,
    storage: fakeStorage,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    backoff: { random: () => backoffRandom },
    watchdogMs,
  });
  const state = { states: [], requests: [], auth: [], respondFailures: [] };
  conn.onStateChange((s) => state.states.push(s));
  conn.onRequest((r) => state.requests.push(r));
  conn.onAuthFailure((i) => state.auth.push(i));
  conn.onRespondFailure((i) => state.respondFailures.push(i));
  return { conn, clock, sockets, fetchImpl, storage: fakeStorage, state };
}

// ── §A 设备唯一标识（缺陷 ③）────────────────────────────────────────────────

check('A', '同一 device id → 同一设备名（重启后不会变成"新设备"）', () => {
  eq(uniqueDeviceName('Web Remote Client', 'a1b2c3'), uniqueDeviceName('Web Remote Client', 'a1b2c3'));
  eq(uniqueDeviceName('Web Remote Client', 'a1b2c3'), 'Web Remote Client · a1b2c3');
});

check('A', '不同 device id → 不同设备名（网关 platform+name 判据下互相独立）', () => {
  const a = uniqueDeviceName('Web Remote Client', 'a1b2c3');
  const b = uniqueDeviceName('Web Remote Client', 'd4e5f6');
  ok(a !== b, `两台手机拿到了同一个设备名：${a}`);
});

check('A', 'uniqueDeviceName 幂等（重复调用不会叠加后缀）', () => {
  const once = uniqueDeviceName('Web Remote Client', 'a1b2c3');
  const twice = uniqueDeviceName(once, 'a1b2c3');
  eq(twice, once);
  eq(stripDeviceSuffix(twice), 'Web Remote Client');
});

check('A', '空/空白 base 回落到默认名，且仍带后缀', () => {
  eq(uniqueDeviceName('', 'a1b2c3'), `${DEFAULT_DEVICE_BASE_NAME} · a1b2c3`);
  eq(uniqueDeviceName('   ', 'a1b2c3'), `${DEFAULT_DEVICE_BASE_NAME} · a1b2c3`);
});

check('A', '超长 base 被裁剪，总长不超过网关的 64 字符上限（后缀不被截掉）', () => {
  const name = uniqueDeviceName('X'.repeat(200), 'a1b2c3');
  ok(name.length <= DEVICE_NAME_MAX_LENGTH, `名字过长: ${name.length}`);
  ok(name.endsWith('a1b2c3'), `后缀被截掉了: ${name}`);
});

check('A', 'device id 规范化：大写/带符号/超长都能得到稳定后缀；太短视为无效', () => {
  eq(sanitizeDeviceId('AB-12_34'), 'ab1234');
  eq(sanitizeDeviceId('zzzzzzzzzz'), 'zzzzzz');
  eq(sanitizeDeviceId('ab'), null);
  eq(sanitizeDeviceId(42), null);
  // 无效 id 时退化为基础名（绝不返回空串）
  eq(uniqueDeviceName('Web Remote Client', 'x'), 'Web Remote Client');
});

check('A', 'generateDeviceId 长度固定且避免全零退化', () => {
  eq(generateDeviceId(() => 0).length, 6);
  ok(!/^0+$/.test(generateDeviceId(() => 0)), 'random 恒为 0 时不应产出全零 id');
  eq(generateDeviceId(() => 0.999), generateDeviceId(() => 0.999));
});

check('A', 'getOrCreateDeviceId 首次生成后落盘，第二次读回同一个 id', () => {
  const storage = createFakeStorage();
  const first = getOrCreateDeviceId({ storage });
  const second = getOrCreateDeviceId({ storage });
  eq(second, first);
  eq(storage.getItem(DEVICE_ID_KEY), first);
  // 存储里已有（哪怕脏）也能规范化读回
  const dirty = createFakeStorage({ [DEVICE_ID_KEY]: 'ZZ-99' });
  eq(getOrCreateDeviceId({ storage: dirty }), 'zz99');
});

check('A', 'getOrCreateDeviceId 在无存储时（Node/隐私模式）仍有稳定返回值', () => {
  eq(getOrCreateDeviceId({ storage: null }), getOrCreateDeviceId({ storage: null }));
});

// ── §B 指数退避（缺陷 ① 的网络故障分支）─────────────────────────────────────

check('B', '无抖动阶梯：1s→2s→4s→8s→16s→30s（封顶）', () => {
  const ladder = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => nextBackoff(n, { random: () => 0.5 }));
  eq(ladder, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
});

check('B', '任何尝试次数下都 ≤ 30s 上限（含抖动后）', () => {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const v = nextBackoff(attempt, { random: () => r });
      ok(v >= 0 && v <= BACKOFF_MAX_MS, `attempt=${attempt} random=${r} → ${v} 超出 [0, ${BACKOFF_MAX_MS}]`);
    }
  }
});

check('B', '抖动落在 ±25% 区间内（未封顶阶段）', () => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const raw = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
    const lo = Math.round(raw * 0.75);
    const hi = Math.round(raw * 1.25);
    const low = nextBackoff(attempt, { random: () => 0 });
    const high = nextBackoff(attempt, { random: () => 1 });
    ok(low >= lo && low <= hi, `attempt=${attempt} 下界抖动越界: ${low} ∉ [${lo}, ${hi}]`);
    ok(high >= lo && high <= hi, `attempt=${attempt} 上界抖动越界: ${high} ∉ [${lo}, ${hi}]`);
    ok(low < high, `有抖动时上下界不应相等: ${low}/${high}`);
  }
});

check('B', 'attempt ≤ 0 / 非数字按首次重试处理（不产生 NaN/负数）', () => {
  eq(nextBackoff(0, { random: () => 0.5 }), 1000);
  eq(nextBackoff(-5, { random: () => 0.5 }), 1000);
  eq(nextBackoff(Number.NaN, { random: () => 0.5 }), 1000);
});

check('B', '退避序列单调不减（无抖动）', () => {
  const seq = [];
  for (let attempt = 1; attempt <= 8; attempt += 1) seq.push(nextBackoff(attempt, { random: () => 0.5 }));
  for (let i = 1; i < seq.length; i += 1) ok(seq[i] >= seq[i - 1], `序列非单调: ${seq.join(',')}`);
});

// ── §C 401/403 分流判定（缺陷 ①）───────────────────────────────────────────

check('C', 'isAuthStatus 只认 401/403', () => {
  ok(isAuthStatus(401), '401 必须是鉴权失败');
  ok(isAuthStatus(403), '403 必须是鉴权失败');
  ok(!isAuthStatus(400), '400 不是鉴权失败');
  ok(!isAuthStatus(500), '500 不是鉴权失败（应重试）');
  ok(!isAuthStatus(1006), '1006 不是 HTTP 状态');
});

check('C', 'classifyClose：普通断开 → retry', () => {
  eq(classifyClose(1006, ''), 'retry');
  eq(classifyClose(1000, 'going away'), 'retry');
  eq(classifyClose(1001), 'retry');
  eq(classifyClose(1008, 'stream id duplicated'), 'retry');
});

check('C', 'classifyClose：鉴权语义的自定义码 → auth（停止重连）', () => {
  eq(classifyClose(4001, 'invalid token'), 'auth');
  eq(classifyClose(4401), 'auth');
  eq(classifyClose(4403), 'auth');
  eq(classifyClose(401), 'auth');
  eq(classifyClose(403), 'auth');
});

check('C', 'classifyClose：1008 只有带鉴权语义时才是 auth', () => {
  ok(classifyClose(1008, 'invalid_token') === 'auth');
  ok(classifyClose(1008, 'Unauthorized') === 'auth');
  ok(classifyClose(1008, 'token expired') === 'auth');
  ok(classifyClose(1008, 'device revoked') === 'retry', '不含鉴权关键字的 1008 不该误判为 auth');
});

// ── §D 已应答事件账本落盘（缺陷 ②）─────────────────────────────────────────

check('D', 'remember 幂等：首次 true，重复 false；size 不重复计数', () => {
  const ledger = createAnsweredLedger(null, 10);
  eq(ledger.remember('ev1'), true);
  eq(ledger.remember('ev1'), false);
  eq(ledger.size(), 1);
  eq(ledger.has('ev1'), true);
  eq(ledger.has('ev2'), false);
});

check('D', '落盘键带版本号，格式为 {v, ids}（可安全演进）', () => {
  ok(ANSWERED_LEDGER_KEY.includes(`v${ANSWERED_LEDGER_VERSION}`), ANSWERED_LEDGER_KEY);
  const storage = createFakeStorage();
  const ledger = createAnsweredLedger(storage, 10);
  ledger.remember('ev1');
  const raw = JSON.parse(storage.getItem(ANSWERED_LEDGER_KEY));
  eq(raw, { v: ANSWERED_LEDGER_VERSION, ids: ['ev1'] });
});

check('D', '读回：新实例（模拟 App 重启）能拿到已应答记录 → 不再重复弹', () => {
  const storage = createFakeStorage();
  createAnsweredLedger(storage, 10).remember('ev-restart');
  const afterRestart = createAnsweredLedger(storage, 10);
  eq(afterRestart.has('ev-restart'), true);
  eq(afterRestart.size(), 1);
});

check('D', '容量：超出按 FIFO 淘汰最旧，size 恒定 ≤ capacity', () => {
  const storage = createFakeStorage();
  const ledger = createAnsweredLedger(storage, 3);
  ['e1', 'e2', 'e3', 'e4', 'e5'].forEach((id) => ledger.remember(id));
  eq(ledger.size(), 3);
  eq(ledger.ids(), ['e3', 'e4', 'e5']);
  eq(createAnsweredLedger(storage, 3).ids(), ['e3', 'e4', 'e5'], '淘汰结果必须落盘');
  eq(ANSWERED_LEDGER_CAPACITY, 500);
});

check('D', '读回时也按容量裁剪（防止旧文件超限）', () => {
  const storage = createFakeStorage({
    [ANSWERED_LEDGER_KEY]: JSON.stringify({ v: 1, ids: ['a', 'b', 'c', 'd', 'e'] }),
  });
  eq(createAnsweredLedger(storage, 2).ids(), ['d', 'e']);
});

check('D', 'forget / clear 会同步落盘', () => {
  const storage = createFakeStorage();
  const ledger = createAnsweredLedger(storage, 10);
  ledger.remember('ev1');
  ledger.remember('ev2');
  ledger.forget('ev1');
  eq(createAnsweredLedger(storage, 10).ids(), ['ev2']);
  ledger.clear();
  eq(createAnsweredLedger(storage, 10).size(), 0);
  eq(storage.getItem(ANSWERED_LEDGER_KEY), null, 'clear 应删除键');
});

check('D', '损坏 JSON / 旧格式（裸数组）都不崩', () => {
  const broken = createFakeStorage({ [ANSWERED_LEDGER_KEY]: '{不是 JSON' });
  eq(createAnsweredLedger(broken, 10).size(), 0);
  const legacy = createFakeStorage({ [ANSWERED_LEDGER_KEY]: JSON.stringify(['old-1', 'old-2']) });
  eq(createAnsweredLedger(legacy, 10).ids(), ['old-1', 'old-2']);
});

check('D', '空 id 不写账本（不会把"没有 eventId"当成一条记录）', () => {
  const ledger = createAnsweredLedger(null, 10);
  eq(ledger.remember(''), false);
  eq(ledger.remember('   '), false);
  eq(ledger.size(), 0);
  eq(ledger.has(''), false);
});

// ── §E 连接级行为（假 socket / 假 fetch / 假时钟）───────────────────────────

await checkAsync('E', '401 握手失败 → 通知 onAuthFailure、**不再安排任何重连**（死循环已断）', async () => {
  const h = createHarness({ fetchRoutes: { sessionList: { status: 401, json: { error: { message: 'unauthorized' } } } } });
  h.conn.start();
  eq(h.sockets.length, 1, '第一次 start 应建一条 socket');
  eq(h.state.states[0].type, 'connecting');

  // 浏览器对握手 401 只给 1006 —— 必须靠 HTTP 探测兜底
  h.sockets[0].drop(1006, '');
  await flush();
  await flush();

  eq(h.state.auth.length, 1, '必须触发一次 onAuthFailure');
  eq(h.state.auth[0].status, 401);
  eq(h.conn.isAuthFailed(), true);
  eq(h.clock.pending().length, 0, '401 之后不允许再排任何定时器（旧实现是 3s 无限重连）');
});

await checkAsync('E', 'auth 失败态下 start() 不得自动重连（要等用户重新配对）', async () => {
  const h = createHarness({ fetchRoutes: { sessionList: { status: 403, json: {} } } });
  h.conn.start();
  h.sockets[0].drop(1006, '');
  await flush();
  await flush();
  eq(h.conn.isAuthFailed(), true);
  eq(h.state.auth[0].status, 403);

  h.state.auth.length = 0;
  h.conn.start();
  eq(h.sockets.length, 1, 'start() 在 auth 失败态下不得新建 socket');
  eq(h.clock.pending().length, 0);
  eq(h.state.auth.length, 1, 'start() 应再次提醒上层"需重新配对"');

  // 重新配对成功后 clearAuthFailure() → 才能真的重连
  h.conn.clearAuthFailure();
  eq(h.conn.isAuthFailed(), false);
  h.conn.start();
  eq(h.sockets.length, 2, 'clearAuthFailure 之后 start() 应该真的连接');
});

await checkAsync('E', '自定义关闭码 4403 → 直接判 auth，不需要 HTTP 探测', async () => {
  const h = createHarness({ fetchRoutes: { sessionList: { status: 200, json: RPC_OK } } });
  h.conn.start();
  h.sockets[0].drop(4403, 'device token revoked');
  await flush();
  eq(h.state.auth.length, 1);
  eq(h.state.auth[0].status, 4403);
  eq(h.clock.pending().length, 0);
  eq(h.fetchImpl.calls.length, 0, '自定义码已足够判定，不该再发探测请求');
});

await checkAsync('E', '网络故障 → 指数退避 1s/2s/4s…（不是固定 3s）', async () => {
  const h = createHarness({ fetchRoutes: { sessionList: { status: 503, json: {} } } });
  h.conn.start();

  h.sockets[0].drop(1006, '');
  await flush();
  eq(h.clock.pending().length, 1, '网络故障应安排一次重连');
  eq(h.clock.lastMs(), 1000, '第 1 次退避应为 1s');
  eq(h.conn.getLastBackoffMs(), 1000);

  h.clock.fireLast();
  eq(h.sockets.length, 2);
  h.sockets[1].drop(1006, '');
  await flush();
  eq(h.clock.lastMs(), 2000, '第 2 次退避应为 2s');

  h.clock.fireLast();
  h.sockets[2].drop(1006, '');
  await flush();
  eq(h.clock.lastMs(), 4000, '第 3 次退避应为 4s');

  // 继续到封顶
  for (let i = 3; i < 7; i += 1) {
    h.clock.fireLast();
    h.sockets[h.sockets.length - 1].drop(1006, '');
    await flush();
  }
  ok(h.clock.lastMs() <= BACKOFF_MAX_MS, `退避必须封顶 ${BACKOFF_MAX_MS}ms，实际 ${h.clock.lastMs()}`);
  eq(h.clock.lastMs(), BACKOFF_MAX_MS, '长连失败后应稳定在 30s 上限');
});

await checkAsync('E', '成功连接后重置退避（下次失败从 1s 重新开始，而不是接着 16s）', async () => {
  const h = createHarness({ fetchRoutes: { sessionList: { status: 200, json: RPC_OK } } });
  h.conn.start();
  // 累计两次失败：1s、2s
  h.sockets[0].drop(1006, '');
  await flush();
  eq(h.clock.lastMs(), 1000);
  h.clock.fireLast();
  h.sockets[1].drop(1006, '');
  await flush();
  eq(h.clock.lastMs(), 2000);

  // 这一次连上并成功 session.list → ready + attempt 归零
  h.clock.fireLast();
  const live = h.sockets[h.sockets.length - 1];
  live.open();
  await flush();
  ok(h.state.states.some((s) => s.type === 'ready'), '成功连接必须报 ready');

  // 再断开：退避必须回到 1s
  live.drop(1006, '');
  await flush();
  eq(h.clock.lastMs(), 1000, '成功之后退避必须重置（否则会一路涨到 30s）');
  eq(h.state.states.filter((s) => s.type === 'ready').length, 1);
});

await checkAsync('E', 'onopen 里 session.list 返回 401 也走 auth 分流（HTTP 侧同判据）', async () => {
  const h = createHarness({ fetchRoutes: { sessionList: { status: 401, json: {} } } });
  h.conn.start();
  h.sockets[0].open();
  await flush();
  await flush();
  eq(h.state.auth.length, 1);
  eq(h.state.auth[0].status, 401);
  eq(h.clock.pending().length, 0, 'HTTP 401 之后不得再排重连');
  eq(h.sockets[0].closed, true, '失效态下不应继续保留数据流 socket');
});

await checkAsync('E', '半开看门狗：90s（可注入）无任何帧 → 强制关闭并重连', async () => {
  const h = createHarness({ fetchRoutes: { sessionList: { status: 200, json: RPC_OK } }, watchdogMs: 90_000 });
  h.conn.start();
  h.sockets[0].open();
  await flush();
  eq(h.clock.pending().length, 1, 'onopen 后应挂上看门狗');
  eq(h.clock.lastMs(), 90_000);

  // 收到任何帧都应重置看门狗（同一个 socket 上重新计时）
  h.sockets[0].emitStreamItem({ type: 'ready', clientId: 'c1' });
  eq(h.clock.pending().length, 1);
  eq(h.clock.lastMs(), 90_000);

  // 之后 90s 没有任何帧 → 强制重连
  h.clock.fireLast();
  await flush();
  eq(h.sockets[0].closed, true, '看门狗触发时必须关掉死 socket');
  eq(h.clock.pending().length, 1, '看门狗触发后应安排重连');
  eq(h.clock.lastMs(), 1000);
});

await checkAsync('E', 'stop() 之后不再有任何重连/看门狗', async () => {
  const h = createHarness({ fetchRoutes: { sessionList: { status: 200, json: RPC_OK } }, watchdogMs: 90_000 });
  h.conn.start();
  h.sockets[0].open();
  await flush();
  h.conn.stop();
  eq(h.clock.pending().length, 0);
  h.sockets[0].drop(1006, '');
  await flush();
  eq(h.sockets.length, 1, 'stop() 之后 onclose 不得再重连');
});

await checkAsync('E', '去重：同一会话内同一 eventId 只弹一次', async () => {
  const h = createHarness();
  h.conn.start();
  h.sockets[0].open();
  await flush();
  h.sockets[0].emitStreamItem({ type: 'ready', clientId: 'c1' });
  h.sockets[0].emitStreamItem({ type: 'waterfall', event: 'approval/request', eventId: 'ev-1', request: { toolName: 'x' } });
  h.sockets[0].emitStreamItem({ type: 'waterfall', event: 'approval/request', eventId: 'ev-1', request: { toolName: 'x' } });
  h.sockets[0].emitStreamItem({ type: 'waterfall', event: 'approval/request', eventId: 'ev-2', request: { toolName: 'y' } });
  eq(h.state.requests.map((r) => r.rpcId), ['ev-1', 'ev-2']);
  ok(h.state.requests.every((r) => r.answerable === true));
});

await checkAsync('E', '应答成功 → 落盘；**App 重启（新实例）后同一 eventId 不再弹**', async () => {
  const storage = createFakeStorage();
  const first = createHarness({ fakeStorage: storage });
  first.conn.start();
  first.sockets[0].open();
  await flush();
  first.sockets[0].emitStreamItem({ type: 'ready', clientId: 'c1' });
  first.sockets[0].emitStreamItem({ type: 'waterfall', event: 'approval/request', eventId: 'ev-persist', request: {} });
  eq(first.state.requests.length, 1);

  eq(await first.conn.respond('ev-persist', { kind: 'result', value: 'allowed-once' }), true);
  ok(
    JSON.parse(storage.getItem(ANSWERED_LEDGER_KEY)).ids.includes('ev-persist'),
    '应答成功后必须落盘',
  );
  eq(first.state.respondFailures.length, 0);

  // —— App 重启：全新实例，同一份 localStorage ——
  const restarted = createHarness({ fakeStorage: storage });
  restarted.conn.start();
  restarted.sockets[0].open();
  await flush();
  restarted.sockets[0].emitStreamItem({ type: 'ready', clientId: 'restarted' });
  restarted.sockets[0].emitStreamItem({ type: 'waterfall', event: 'approval/request', eventId: 'ev-persist', request: {} });
  eq(restarted.state.requests.length, 0, '重启后不该再弹已经处理过的审批');
});

await checkAsync('E', '应答失败（HTTP 500）→ 不落盘、通知 onRespondFailure、允许再次处理', async () => {
  const storage = createFakeStorage();
  const h = createHarness({ fakeStorage: storage, fetchRoutes: { respond: { status: 500, json: {} } } });
  h.conn.start();
  h.sockets[0].open();
  await flush();
  h.sockets[0].emitStreamItem({ type: 'ready', clientId: 'c1' });
  h.sockets[0].emitStreamItem({ type: 'waterfall', event: 'approval/request', eventId: 'ev-fail', request: {} });

  eq(await h.conn.respond('ev-fail', { kind: 'result', value: 'allowed-once' }), false);
  eq(storage.getItem(ANSWERED_LEDGER_KEY), null, '失败**不能**写入账本（否则会永久吞掉审批）');
  eq(h.state.respondFailures.length, 1);
  eq(h.state.respondFailures[0].eventId, 'ev-fail');
  eq(h.state.respondFailures[0].status, 500);
  ok(/500/.test(h.state.respondFailures[0].message), h.state.respondFailures[0].message);

  // 事件被重放时仍应再次弹出（因为没落盘）
  h.sockets[0].emitStreamItem({ type: 'waterfall', event: 'approval/request', eventId: 'ev-fail', request: {} });
  eq(h.state.requests.length, 2, '应答失败后重放应再次弹给用户');
});

await checkAsync('E', '应答时事件流未就绪（无 clientId）→ 可诊断，而不是静默 false', async () => {
  const h = createHarness();
  h.conn.start();
  const result = await h.conn.respond('ev-x', {});
  eq(result, false);
  eq(h.state.respondFailures.length, 1);
  eq(h.state.respondFailures[0].status, null);
  ok(/clientId/.test(h.state.respondFailures[0].message), h.state.respondFailures[0].message);
});

await checkAsync('E', 'call() 的 401 抛出的错误带状态码（供上层分流）', async () => {
  const h = createHarness({ fetchRoutes: { sessionList: { status: 401, json: {} } } });
  let caught = null;
  try {
    await h.conn.call('session.list', { _request: {} });
  } catch (err) {
    caught = err;
  }
  ok(caught, '非 2xx 必须抛错');
  eq(caught.status, 401);
  ok(/HTTP 401/.test(caught.message), caught.message);
});

await checkAsync('E', '鉴权探测超时 → 不卡死，仍能安排退避重连（网络黑洞自愈）', async () => {
  const h = createHarness({ fetchRoutes: { sessionList: { hang: true } } });
  h.conn.start();
  h.sockets[0].drop(1006, '');
  await flush();

  const probeTimer = h.clock.pending().find((t) => t.ms === 5000);
  ok(probeTimer, '探测必须自带 5s 超时（否则网络黑洞会永远卡住重连）');
  h.clock.fire(probeTimer);
  await flush();
  await flush();

  const retry = h.clock.pending().find((t) => !t.cleared);
  ok(retry, '探测超时后必须能安排重连');
  eq(retry.ms, 1000);
});

// ── §F 源码级护栏：旧缺陷的实现方式不得复活 ────────────────────────────────

const CONNECTION_SRC = readFileSync(path.join(SRC, 'services', 'connection.ts'), 'utf8');
const STORE_SRC = readFileSync(path.join(SRC, 'services', 'store.ts'), 'utf8');

check('F', 'connection.ts 里不再有"无条件 3s 重连"', () => {
  ok(!/connectReal\(\)\s*;?\s*\}\s*,\s*3000\s*\)/.test(CONNECTION_SRC), '仍然存在固定 3000ms 重连');
  ok(!/answeredEventIds/.test(CONNECTION_SRC), '内存态 answeredEventIds 必须已移除');
});

check('F', 'connection.ts 暴露了 onAuthFailure / onRespondFailure / 退避与判定', () => {
  ['onAuthFailure', 'onRespondFailure', 'clearAuthFailure', 'classifyClose', 'nextBackoff', 'probeAuthStatus'].forEach(
    (name) => ok(CONNECTION_SRC.includes(name), `缺少 ${name}`),
  );
  ok(CONNECTION_SRC.includes('private createSocket('), 'socket 创建必须收敛到可注入的 createSocket');
  ok(!/const ws = new WebSocket\(/.test(CONNECTION_SRC), 'connectReal 里不得再直接 new WebSocket');
});

check('F', 'store.ts 暴露了带版本号的落盘账本', () => {
  ok(STORE_SRC.includes('ANSWERED_LEDGER_KEY'), '缺少落盘键');
  ok(STORE_SRC.includes('createAnsweredLedger'), '缺少 createAnsweredLedger');
  ok(/import type \{ HostRecord \}/.test(STORE_SRC), 'store.ts 的 types 导入必须保持 import type');
  // 已有公有 API 不能改签名（HostStore 五个方法必须仍在）
  ['all(', 'find(', 'upsert(', 'remove(', 'getActiveId(', 'setActiveId('].forEach((m) =>
    ok(STORE_SRC.includes(m), `HostStore 缺少 ${m}`),
  );
  ok(typeof HostStore.all === 'function', 'HostStore 必须是可用的值导出');
});

// ── 汇总 ────────────────────────────────────────────────────────────────────

const groups = [...new Set([...failures.map((f) => f.group)])];
console.log('');
console.log(`  连接层策略测试：${passed} 通过 / ${failures.length} 失败`);
console.log('');
if (failures.length > 0) {
  for (const f of failures) {
    console.log(`  ✗ [${f.group}] ${f.name}`);
    console.log(`      ${f.message.split('\n').join('\n      ')}`);
  }
  console.log('');
  console.log(`  失败的组：${groups.join(', ')}`);
  process.exit(1);
}
console.log('  ✓ 全部通过（A 设备唯一标识 / B 退避 / C 401-403 分流 / D 去重落盘 / E 连接行为 / F 源码护栏）');
console.log('');