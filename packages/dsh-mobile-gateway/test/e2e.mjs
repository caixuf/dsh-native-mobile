/**
 * @file test/e2e.mjs
 * @description 端到端冒烟测试：在**真实的 HTTP + WebSocket** 上跑网关的配对、
 *              鉴权、特权拒绝、`/api` 桥与事件流。被打桩的只有 DSH 宿主服务
 *              （`connection.createSharedFetchHandler` 与 `typertGateway.wireStream`），
 *              网关自身的每一行代码都是真实执行的。
 *
 * 运行：node test/e2e.mjs
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { DeviceStore } from '../lib/store.mjs';
import { createBridge } from '../lib/bridge.mjs';
import { createManageApi } from '../lib/manage.mjs';
import { sendError, sendJson, readJsonBody } from '../lib/http.mjs';
import { createLogger } from '../lib/util.mjs';
import { PRIVILEGED_METHODS } from '../lib/bridge.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 仓库根（`dsh-native-mobile/`）。
 * `test/e2e.mjs` → `packages/dsh-mobile-gateway/test` → 上溯三级。
 * 供 [9c] 静态读 App 的 Kotlin 源码用（网关是透明桥，App 的形状错误在网关侧不可见）。
 */
const repoRoot = joinPath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let passed = 0;
let failed = 0;
const failures = [];

// 看门狗：卡住时把已通过的断言数打出来，定位停在哪一步，别让 CI 静默挂死。
let currentSection = '(bootstrap)';
setTimeout(() => {
  console.error(`\n看门狗：已通过 ${passed} 项断言后卡住（当前阶段 ${currentSection}）`);
  process.exit(2);
}, 60_000).unref?.();
const section = (name) => {
  currentSection = name;
  console.log(`\n${name}`);
};

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${detail}`);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

// ---- 假的 DSH 宿主 -------------------------------------------------------

const log = createLogger(join(tmpdir(), `dsh-mgw-test-${randomUUID()}.log`), {
  minLevel: 'error',
  console: false,
});

const calls = [];
const privilegedLeak = [];

/**
 * 官方载体里被「空信任表」钉在回环的那批方法 —— **硬编码基线，故意不从被测代码导入**。
 *
 * 如果这里改成读 `PRIVILEGED_METHODS`，就会出现「测试依赖被测对象」的循环：
 * 常量被改坏时桩也跟着变，泄漏检测随之失效。突变测试正是靠这份独立基线
 * 才能发现「清空名单后测试仍全绿」的假绿。
 */
const PRIVILEGED_BASELINE = [
  'settings.describe',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'settings.openDocument',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'llm.discoverModels',
];

/**
 * 真实主机上**确实存在**的 RPC 方法名 —— 硬编码基线，用于让假宿主拒绝未知方法。
 *
 * 为什么必须这样：早前假宿主对**任意**方法名都返回 `{echoed: method}` 成功应答，
 * 于是「App 调用了不存在的方法」这类错误在测试里完全不可见 —— 我们就是这样让
 * `session.history`（真实主机没有此方法，真名 `session.page`）一路绿到真机的。
 *
 * 取证来源（按可信度排序，见 docs/api-contract.md 顶部警告）：
 *   1. 真实主机源码 app.asar 内 @deepseek-ai/dsh-api-<包>/lib/*.js（含 @Remote 注册）
 *   2. 对运行中的主机发真实请求
 *   3. 客户端 bundle（**最不可信**，已出现过 session.history 这种错误）
 *
 * 下面的清单是从真实主机侧确认过的（asar 内字面量存在 + zod schema）。
 * 新增方法时必须先去主机侧核实，不要从 docs/api-contract.json 抄。
 */
const HOST_METHODS = new Set([
  'host.describe',
  'session.list',
  'session.page',
  'session.prompt',
  'session.cancel',
  'session.search',
  'session.create',
  'session.rename',
  'session.fork',
  'session.models',
  'session.selectModel',
  'session.attachment',
  'session.updateQueue',
  'session.projections',
  'session.follow',
  'workspace.list',
  'workspace.create',
  'respond',
  // 测试专用的故障注入方法：只存在于测试桩里，用于验证「业务错误透传」这条路径。
  // 命名上刻意与真实方法区分开，避免被误认为真实方法。
  'boom',
]);

/** 每个方法在真实主机上的必填参数 —— 用于让假宿主校验，而不是无条件接受。 */
const HOST_REQUIRED_ARGS = {
  'session.page': ['address', 'throughSeq'],
  'session.prompt': ['requestId', 'sessionId', 'mode', 'content'],
  'session.cancel': ['sessionId'],
  'session.search': ['query'],
};

/** 模拟 `ctx.connection.createSharedFetchHandler('/api')`。 */
async function fakeApiFetch(request) {
  const url = new URL(request.url);
  const method = url.pathname.replace(/^\/api\//, '');
  const body = await request.json().catch(() => ({}));
  calls.push({ method, body });

  // 特权方法在官方载体里靠「空信任表」钉在回环；这里如实复现：只有回环能到。
  // 用独立基线判断，而不是被测的 PRIVILEGED_METHODS。
  if (PRIVILEGED_BASELINE.includes(method)) {
    privilegedLeak.push(method);
    return Response.json(
      { type: 'server-response', result: { ok: true, value: { shouldNotHappen: true } } },
      { status: 200 },
    );
  }

  // 🔴 未知方法必须像真实主机那样失败，而不是假装成功。
  // 这是本次事故的直接教训：假宿主曾经对任何方法名都回 {echoed}，
  // 于是「调了不存在的方法」在测试里完全不可见。
  if (!HOST_METHODS.has(method)) {
    return Response.json({
      type: 'server-response',
      result: {
        ok: false,
        error: {
          code: 'unknown-method',
          message: `真实主机没有 ${method} 这个方法`,
          details: { method },
        },
      },
    });
  }

  // 必填参数校验：漏传必填项时真实主机会拒绝，假宿主也必须拒绝。
  const required = HOST_REQUIRED_ARGS[method];
  if (required) {
    const payload = body?.payload ?? {};
    const missing = required.filter((k) => payload[k] === undefined);
    if (missing.length) {
      return Response.json({
        type: 'server-response',
        result: {
          ok: false,
          error: {
            code: 'invalid-params',
            message: `${method} 缺少必填参数: ${missing.join(', ')}`,
            details: { missing },
          },
        },
      });
    }
  }

  if (method === 'host.describe') {
    return Response.json({
      type: 'server-response',
      result: { ok: true, value: { version: '0.2.0-rc.2', cwd: 'C:/work' } },
    });
  }
  if (method === 'session.list') {
    return Response.json({
      type: 'server-response',
      result: { ok: true, value: { items: [{ sessionId: 's-1', title: '第一个会话' }] } },
    });
  }
  if (method === 'boom') {
    return Response.json({
      type: 'server-response',
      result: { ok: false, error: { code: 'bad_thing', message: '炸了', details: {} } },
    });
  }
  if (method === 'respond') {
    // 官方回执形状（docs/api-contract.md §1.4）：
    //   { accepted: true } | { accepted: false, reason: "not-pending" | "bad-response" }
    // 这里按契约校验信封 —— 若客户端把裸业务对象当 result 传（App 曾经如此），
    // 真实主机会回 bad-response，所以桩也必须能识别出这种错误。
    const result = body?.result;
    const wellFormed = result && typeof result === 'object' && 'ok' in result && 'value' in result;
    return Response.json(
      wellFormed ? { accepted: true } : { accepted: false, reason: 'bad-response' },
    );
  }
  return Response.json({
    type: 'server-response',
    result: { ok: true, value: { echoed: method } },
  });
}

/** 模拟 `ctx.typertGateway.wireStream.open(...)`：推 3 帧后结束。 */
const fakeWireStream = {
  async open(endpoint, _payload, _uplink, _peer, signal) {
    // 只有 `$events` 是真实主机承认的事件流 endpoint（权威常量）。
    if (endpoint !== '$events') {
      throw new Error(`invalid Remote endpoint ${JSON.stringify(endpoint)}`);
    }
    return {
      async *[Symbol.asyncIterator]() {
        // 真实主机的 `$events` 流第一帧是 `ready`（带 clientId），
        // 之后才是 emit/waterfall。这里逐字复刻，否则 App 拿不到 clientId。
        yield { type: 'ready', clientId: 'client-test-1', host: { home: 'C:/Users/test' } };
        for (let i = 0; i < 3; i += 1) {
          if (signal?.aborted) return;
          yield { type: 'emit', event: 'tick', args: [i] };
          await new Promise((r) => setTimeout(r, 10));
        }
      },
    };
  },
};

const fakeCtx = {
  connection: { createSharedFetchHandler: () => ({ fetch: fakeApiFetch }), operator: { id: 'operator' } },
  typertGateway: { wireStream: fakeWireStream },
};

// ---- 真实网关 -----------------------------------------------------------

const testDataDir = join(tmpdir(), `dsh-mgw-data-${randomUUID()}`);
const store = new DeviceStore(join(testDataDir, 'devices.json'), log);
await store.load();

const config = {
  enabled: true,
  pairingTtlMs: 60_000,
  tokenTtlMs: 3_600_000,
  publicBaseUrl: '',
  logLevel: 'error',
};

const bridge = createBridge({ ctx: fakeCtx, store, log, config });

// ---- 用**真实插件**注册路由，而不是另抄一份 ------------------------------
//
// 这是本次最重要的测试改造。旧版在这里手写了一张路由表，等于把插件的注册语句
// 复制了一遍 —— 于是插件里 `path: '/mobile-gateway/'` 这种错误永远不会被发现，
// 因为测试测的是我抄的那份（还是用更宽松的匹配规则）。
//
// 现在改成：调用插件的 apply()，把它注册的路由原样捕获下来，
// 再按 DSH 的真实匹配语义派发。注册语句本身因此成为被测对象。

const routes = [];
const upgrades = new Map();

/** 假 webServer：只记录插件注册了什么，不实现真实网络。 */
const fakeWebServer = {
  register(route) {
    routes.push(route);
    return () => {};
  },
  registerUpgrade(route) {
    upgrades.set(route.path, route.handler);
    return () => {};
  },
};

/** 假 ctx：提供 inject / effect / get 与三个宿主服务。 */
const pendingStarts = [];
const fakePluginCtx = {
  ...fakeCtx,
  webServer: fakeWebServer,
  inject(names, callback) {
    // 真实语义：服务就绪后执行回调，参数是子 fiber。
    // ⚠️ apply() 是**同步**返回的，回调却可能是异步的 —— 必须把 promise 收集起来
    // 让测试 await，否则会在路由注册完成前就开始发请求（旧版就踩过这个竞态）。
    pendingStarts.push(Promise.resolve(callback(this)));
    return () => {};
  },
  effect(factory) {
    factory();
    return () => {};
  },
  get(name) {
    return name === 'profileContext' ? { id: 'test', name: 'test-profile', home: '/tmp' } : undefined;
  },
};

const gateway = await import('../index.mjs');
gateway.apply(fakePluginCtx, {
  enabled: true,
  pairingTtlMs: 60_000,
  tokenTtlMs: 3_600_000,
  publicBaseUrl: '',
  logLevel: 'error',
  dataDir: testDataDir,
});
// 等插件把路由注册完，再开始断言。
await Promise.all(pendingStarts);
// 插件内部是异步注册（effect 里同步 register，但 start 是 async），让出一轮事件循环。
await new Promise((r) => setTimeout(r, 50));

// 插件的路由**必须**被注册，且 prefix 的 path 不能带尾斜杠。
check('插件注册了 HTTP 路由', routes.length > 0, `routes=${routes.length}`);
const prefixRoutes = routes.filter((r) => r.kind === 'prefix');
check(
  'prefix 路由的 path 不带尾部斜杠（否则子路径永远命中不了）',
  prefixRoutes.every((r) => !r.path.endsWith('/')),
  prefixRoutes.map((r) => r.path).join(', '),
);

// 桩自身也要被验证：如果 dispatch 写错了，后面所有断言都会失去意义。
// 这组用假路由直接检验权威语义的三条要点（见 matchesRoute 上方注释）。
{
  const fakeExact = { kind: 'exact', path: '/x/y', tag: 'exact' };
  const fakeShort = { kind: 'prefix', path: '/x', tag: 'short' };
  const fakeLong = { kind: 'prefix', path: '/x/y', tag: 'long' };
  const table = [fakeShort, fakeExact, fakeLong];

  check('桩语义: exact 优先于 prefix', dispatch(table, '/x/y')?.tag === 'exact');
  check('桩语义: 最长前缀胜出', dispatch(table, '/x/y/z')?.tag === 'long');
  check('桩语义: 短前缀仍可命中', dispatch(table, '/x/other')?.tag === 'short');
  check('桩语义: 无关路径不命中', dispatch(table, '/nope') === undefined);
  // 这一条直接对应那次事故：带尾斜杠的 prefix 只能精确匹配。
  const trailing = { kind: 'prefix', path: '/t/' };
  check('桩语义: 带尾斜杠的 prefix 只精确匹配', dispatch([trailing], '/t/deep') === undefined);
  check('桩语义: 带尾斜杠的 prefix 精确相等仍命中', dispatch([trailing], '/t/')?.path === '/t/');
}

/**
 * 复刻 DSH `webServer.match()` 的真实语义。
 *
 * 逐行对照权威实现 `@deepseek-ai/dsh-host-webserver/lib/index.js:322-332`
 * （从 app.asar 抠出，原文）：
 *
 *     /** Longest-prefix-wins over the prefix table after an exact-table miss. *\/
 *     match(pathname) {
 *       const exact = this.exact.get(pathname);
 *       if (exact !== void 0) return exact;
 *       let best;
 *       for (const [prefix, route] of this.prefixes) {
 *         if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
 *         if (best === void 0 || prefix.length > best.path.length) best = route;
 *       }
 *       return best;
 *     }
 *
 * 三条要点，缺一不可：
 *   1. **exact 优先于 prefix**（先查 exact 表）。
 *   2. 匹配条件是 `pathname === prefix || pathname.startsWith(prefix + '/')`
 *      —— 这就是「prefix path 带尾斜杠则子路径永不命中」的权威证据。
 *   3. **longest-prefix-wins**：多条 prefix 命中时取最长者。
 *
 * 本插件的旧桩只写了裸 `startsWith(path)`，比现实宽松，因而放过了那次事故。
 */
function matchesRoute(route, pathname) {
  if (route.kind === 'exact') return route.path === pathname;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}

/** 与 match() 等价的派发：exact 优先，其次 prefix 中最长者胜出。 */
function dispatch(routes, pathname) {
  const exact = routes.find((r) => r.kind === 'exact' && r.path === pathname);
  if (exact !== undefined) return exact;
  let best;
  for (const route of routes) {
    if (route.kind !== 'prefix') continue;
    if (!matchesRoute(route, pathname)) continue;
    if (best === undefined || route.path.length > best.path.length) best = route;
  }
  return best;
}

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  const hit = dispatch(routes, pathname);
  if (!hit) {
    // 复刻宿主的兜底行为：**空响应体** 404。
    // 这一点很重要——实测确认未命中时 body 长度为 0，而插件自己的 404 会带 JSON。
    // 桩如果在这里返回 JSON，就会掩盖「路由没命中」这类故障（正是本次事故的形态）。
    res.writeHead(404);
    res.end();
    return;
  }
  void hit.handler(req, res);
});
server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url ?? '/').split('?')[0];
  const handler = upgrades.get(pathname);
  if (!handler) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  handler(req, socket, head);
});
// 绑 0.0.0.0 而不是 127.0.0.1：这样才有机会从**非回环**来源发起请求，
// 从而真正验证管理面的回环闸门。只绑回环的话，remoteAddress 永远是 127.0.0.1，
// 那条断言就只是自说自话（这正是本次审计发现的假绿之一）。
await new Promise((r) => server.listen(0, '0.0.0.0', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// 找一个非回环的本机地址，用来模拟「局域网/公网来的请求」。
const os = await import('node:os');
function findNonLoopbackIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}
const lanIp = findNonLoopbackIPv4();
const lanBase = lanIp ? `http://${lanIp}:${port}` : null;
console.log(`  测试服务器: 0.0.0.0:${port}  回环=${base}  非回环=${lanBase ?? '(无可用网卡)'}`);

async function api(method, { token, body } = {}) {
  const res = await fetch(`${base}/mobile-gateway/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? { type: 'client-request', rpcId: 'r1', method, payload: {} }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/**
 * 铸配对码 —— 必须走**插件的管理接口**，不能用测试自己 new 的 store。
 * 插件内部持有自己的 store 实例，测试另造一个的话两边状态不通，
 * 表现就是「码明明铸了，配对却回 no_active_code/404」。
 * 管理面只应答回环，而测试服务器就跑在 127.0.0.1 上，正好符合。
 */
async function mint() {
  const res = await fetch(`${base}/mobile-gateway/manage/api/mint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`mint 失败：HTTP ${res.status}`);
  const state = await res.json();
  const display = state?.pairing?.display;
  if (!display) throw new Error(`mint 未返回配对码：${JSON.stringify(state).slice(0, 200)}`);
  return display;
}

async function pair(code, deviceName = 'Pixel') {
  const res = await fetch(`${base}/mobile-gateway/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName, platform: 'android' }),
  });
  return { status: res.status, json: await res.json() };
}

// ---- 用例 ---------------------------------------------------------------

console.log('\n[1] 配对码与令牌');
const code = await mint();
check('铸码返回 dshm1 格式', /^dshm1\.[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(code), code);

const paired = await pair(code);
check('首次配对成功', paired.status === 200 && !!paired.json.token, `status=${paired.status}`);
const token = paired.json.token;
const deviceId = paired.json.device.id;

// 码被消费后已不存在，语义上属于「没有有效配对码」→ 404（不是 403 不匹配）。
const replay = await pair(code);
check('配对码一次性（重放被拒）', replay.status === 404, `status=${replay.status}`);

const malformed = await pair('not-a-code');
check('畸形配对码被拒', malformed.status === 403, `status=${malformed.status}`);

// 验证 6 位纯数字 PIN 配对
const mintRes = await fetch(`${base}/mobile-gateway/manage/api/mint`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
const pinState = await mintRes.json();
const pin = pinState?.pairing?.pin;
check('铸码包含 6 位纯数字 PIN', /^\d{6}$/.test(pin), `pin=${pin}`);
const pinPaired = await pair(pin, 'Pixel-PIN');
check('6位数字 PIN 首次配对成功', pinPaired.status === 200 && !!pinPaired.json.token, `status=${pinPaired.status}`);

console.log('\n[2] 鉴权');
check('无令牌 → 401', (await api('host.describe')).status === 401);
check('伪造令牌 → 401', (await api('host.describe', { token: 'nope' })).status === 401);

console.log('\n[3] /api 桥');
const listed = await api('session.list', { token });
check(
  'session.list 透传成功',
  listed.json?.result?.ok === true && listed.json.result.value.items[0].title === '第一个会话',
  JSON.stringify(listed.json).slice(0, 120),
);
check('信封 method 与路径一致', calls.at(-1).method === 'session.list');

const boom = await api('boom', { token });
check('业务错误原样透传', boom.json?.result?.ok === false && boom.json.result.error.code === 'bad_thing');

// ---- 3b. 假宿主的方法契约校验本身必须有效 ------------------------------
// 这一组防的是「测试桩对任意方法都回成功」这种最危险的假绿形态：
// 它曾让 App 调用不存在的 session.history 一路绿到真机。
console.log('\n[3b] 假宿主会拒绝未知方法与缺失必填项（防假绿）');
const unknownMethod = await api('session.history', { token });
check(
  '不存在的方法名被假宿主拒绝（不再假装成功）',
  unknownMethod.json?.result?.ok === false,
  JSON.stringify(unknownMethod.json).slice(0, 120),
);
check(
  '拒绝原因是 unknown-method',
  unknownMethod.json?.result?.error?.code === 'unknown-method',
  JSON.stringify(unknownMethod.json?.result?.error).slice(0, 100),
);

// session.page 缺 throughSeq 必须被拒 —— 对应「漏传必填参数」这类错误。
const missingArg = await api('session.page', {
  token,
  body: {
    type: 'client-request',
    rpcId: 'r1',
    method: 'session.page',
    payload: { address: { kind: 'session', sessionId: 's-1' } },
  },
});
check(
  '缺必填参数被假宿主拒绝',
  missingArg.json?.result?.ok === false && missingArg.json.result.error.code === 'invalid-params',
  JSON.stringify(missingArg.json).slice(0, 120),
);

// 反向对照：参数齐全时必须放行，证明校验不是一刀切。
const okPage = await api('session.page', {
  token,
  body: {
    type: 'client-request',
    rpcId: 'r1',
    method: 'session.page',
    payload: { address: { kind: 'session', sessionId: 's-1' }, throughSeq: 999 },
  },
});
check('参数齐全时放行', okPage.json?.result?.ok === true, JSON.stringify(okPage.json).slice(0, 120));

console.log('\n[4] 特权方法闸门');
const before = privilegedLeak.length;
const settings = await api('settings.describe', { token });
check('settings.describe 被网关拒绝(403)', settings.status === 403, `status=${settings.status}`);
check('拒绝时没有触达宿主', privilegedLeak.length === before);
const creds = await api('credentials.set', { token });
check('credentials.set 被拒绝(403)', creds.status === 403, `status=${creds.status}`);

// 🔴 两道闸必须**各自**被覆盖。
// 突变测试发现：清空 PRIVILEGED_METHODS 后测试仍全绿，因为这些方法同时被
// PRIVILEGED_PREFIXES 的前缀规则拦下 —— 也就是说那张精确名单此前从未被真正测到。
// 这里专门挑「只可能由精确名单拦住」的方法：它们不在任何前缀之下。
const exactOnly = ['host.pickDirectory', 'host.openPath', 'llm.discoverModels'];
for (const method of exactOnly) {
  const res = await api(method, { token });
  check(`${method} 被精确名单拒绝(403)`, res.status === 403, `status=${res.status}`);
}
// 反向对照：一个普通方法必须能过，证明闸门不是「一刀切全拒」。
const allowed = await api('session.list', { token });
check('普通方法未被闸门误伤', allowed.status === 200, `status=${allowed.status}`);

// ---- 4b. 闸门绕过回归（verifier 独立发现过的真实漏洞面）----------------
// 机理：若闸门按**原样**比对，`./settings.describe` ≠ `settings.describe` 于是放行，
// 而下游会把它归一化成 settings.describe —— 「闸门看到的字符串 ≠ 上游执行的端点」。
//
// ⚠️ 重要实测发现（决定了这组断言该怎么写）：
//   **Node 的 http server 在请求到达 handler 之前就已归一化 req.url**：
//       /a/./b     → /a/b
//       /a/x/../b  → /a/b
//       /a/%2e/b   → /a/b
//   所以用 fetch/curl 发这类路径，到我们手里时**已经归一化**，闸门当然拦得住 ——
//   这会让本组断言变成假绿（实测：把闸门退回有漏洞的旧版，本组仍全绿）。
//   真正能测出差异的是**原始 socket 手写请求行**，见 scripts/verify-gate-raw.mjs。
//
// 因此这里保留本组作为「路由层可达性」检查，但**明确标注其局限**，
// 并把归一化差异的验证交给 verify-gate-raw.mjs（它已纳入 verify 流程）。
console.log('\n[4b] 特权路径变体（注意：Node 已预归一化，本组不足以证明闸门健壮）');
const bypassAttempts = [
  ['点号路径段 ./', '/mobile-gateway/api/./settings.describe'],
  ['上级路径 x/../', '/mobile-gateway/api/x/../settings.describe'],
  ['双斜杠 //', '/mobile-gateway/api//settings.describe'],
  ['百分号编码 %2e', '/mobile-gateway/api/%2e/settings.describe'],
  ['大小写混合', '/mobile-gateway/api/SETTINGS/DESCRIBE'],
  ['credentials + ./', '/mobile-gateway/api/./credentials.set'],
];
for (const [label, path] of bypassAttempts) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'x', payload: { args: {} } }),
  });
  const text = await res.text();
  // 两种拦截都算安全：
  //   403 + loopback_only → 我们的闸门拦下
  //   404 + not found     → 宿主在路由匹配前拒绝
  // 但**必须**是其中之一，绝不能到达主机（200）。
  const blocked =
    (res.status === 403 && /loopback_only/.test(text)) ||
    (res.status === 404 && /not found/.test(text.trim()));
  check(`${label} 未到达主机`, blocked, `status=${res.status} ${text.slice(0, 90)}`);
}

// 前缀闸门也要**独立**覆盖：挑那些「不在精确名单里、只能靠前缀拦住」的方法。
// 突变测试发现：清空 PRIVILEGED_PREFIXES 时测试曾全绿，因为 settings.*/credentials.*
// 同时也在精确名单里 —— 两道闸互为掩护。这几个方法只在精确名单之外，
// 因此只有前缀规则能拦住它们。
const prefixOnly = [
  'settings.openDocument',
  'credentials.describe',
  'pluginManager.install',
  'agentPreset.copy',
].filter((m) => !PRIVILEGED_METHODS.includes(m));
for (const method of prefixOnly) {
  const res = await api(method, { token });
  check(`${method} 被前缀闸门拒绝(403)`, res.status === 403, `status=${res.status}`);
}

console.log('\n[5] 事件流（单一 mux + 逻辑流帧协议）');
//
// 🔴 2026-10-13 公网实测 + app.asar 权威源码取证：
// 真实主机只有**一条** mux WS —— `/api/remote.mux`（`REMOTE_STREAM_MUX_PATH`），
// 不存在 `events.mux` / `events.host`。协议是「一条 WS 承载多条逻辑流」：
// 客户端发 `open{streamId,endpoint,payload}`，主机在该 streamId 上回
// `item{streamId,value}` / `end` / `error`。事件流用内部 endpoint `$events`，
// payload 必须是 `{args:{}}`。
const MUX = '/mobile-gateway/remote.mux';

/** 连 mux 并开一条逻辑流，收集若干帧。 */
async function readStreamFrames(path, token, expected, endpoint = '$events') {
  const ws = new WebSocket(base.replace('http', 'ws') + path, {
    headers: { authorization: `Bearer ${token}` },
  });
  const frames = [];
  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'open', streamId: 's-1', endpoint, payload: { args: {} } }));
      resolve();
    });
    ws.on('error', reject);
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  });
  const deadline = Date.now() + 3000;
  while (frames.length < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  ws.close();
  return frames;
}

const muxFrames = await readStreamFrames(MUX, token, 4);
check('mux 能升级并收到帧', muxFrames.length > 0, `got ${muxFrames.length}`);
check('帧形状为 item + streamId', muxFrames[0]?.type === 'item' && muxFrames[0]?.streamId === 's-1',
  JSON.stringify(muxFrames[0])?.slice(0, 90));
const firstValue = muxFrames[0]?.value;
check('$events 首帧是 ready（带 clientId）',
  firstValue?.type === 'ready' && typeof firstValue.clientId === 'string',
  JSON.stringify(firstValue)?.slice(0, 90));
check('ready 带 host.home', typeof firstValue?.host?.home === 'string', String(firstValue?.host?.home));
const emitted = muxFrames.filter((f) => f.value?.type === 'emit');
check('随后收到 emit 帧', emitted.length >= 1, `emit=${emitted.length}`);
check('emit 帧带 event 与 args', emitted[0]?.value?.event === 'tick' && Array.isArray(emitted[0]?.value?.args),
  JSON.stringify(emitted[0]?.value)?.slice(0, 90));

// 旧的两条路径必须**不存在**了（防止有人改回去）
for (const legacy of ['/mobile-gateway/events.mux', '/mobile-gateway/events.host']) {
  const opened = await new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + legacy, {
      headers: { authorization: `Bearer ${token}` },
    });
    ws.on('open', () => resolve('opened'));
    ws.on('error', () => resolve('rejected'));
    setTimeout(() => resolve('timeout'), 1500);
  });
  check(`旧路径 ${legacy} 已不存在`, opened === 'rejected', opened);
}

// 协议违规：重复 streamId 必须关 socket（权威语义）
const dupClose = await new Promise((resolve) => {
  const ws = new WebSocket(base.replace('http', 'ws') + MUX, {
    headers: { authorization: `Bearer ${token}` },
  });
  ws.on('open', () => {
    const open = JSON.stringify({ type: 'open', streamId: 'dup', endpoint: '$events', payload: { args: {} } });
    ws.send(open);
    ws.send(open);
  });
  ws.on('close', (code) => resolve(code));
  ws.on('error', () => resolve('error'));
  setTimeout(() => resolve('timeout'), 2500);
});
check('重复 streamId 的 open 关闭 socket(1008)', dupClose === 1008, `close=${dupClose}`);

// 协议违规：非法帧必须关 socket
const badFrameClose = await new Promise((resolve) => {
  const ws = new WebSocket(base.replace('http', 'ws') + MUX, {
    headers: { authorization: `Bearer ${token}` },
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'nonsense' })));
  ws.on('close', (code) => resolve(code));
  ws.on('error', () => resolve('error'));
  setTimeout(() => resolve('timeout'), 2500);
});
check('非法帧关闭 socket(1008)', badFrameClose === 1008, `close=${badFrameClose}`);

// 未知 streamId 的 item **不能**关 socket（权威语义：静默丢弃）
const unknownIdSurvives = await new Promise((resolve) => {
  const ws = new WebSocket(base.replace('http', 'ws') + MUX, {
    headers: { authorization: `Bearer ${token}` },
  });
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'item', streamId: 'no-such-stream', value: 1 }));
    setTimeout(() => resolve(ws.readyState === WebSocket.OPEN ? 'open' : 'closed'), 600);
  });
  ws.on('close', () => resolve('closed'));
  ws.on('error', () => resolve('error'));
  setTimeout(() => resolve('timeout'), 2000);
});
check('未知 streamId 静默丢弃（不断连）', unknownIdSurvives === 'open', unknownIdSurvives);

// 非法 endpoint 必须走 error 帧（而不是静默断连）—— 这正是原来两条 events.* 的故障形态
const badEndpoint = await readStreamFrames(MUX, token, 1, '/api/events.host');
check('非法 endpoint 回 error 帧（不是静默断连）',
  badEndpoint[0]?.type === 'error' && /invalid Remote endpoint/.test(badEndpoint[0]?.error?.message ?? ''),
  JSON.stringify(badEndpoint[0])?.slice(0, 110));

console.log('\n[6] WS 鉴权');
const badWs = new WebSocket(base.replace('http', 'ws') + MUX, {
  headers: { authorization: 'Bearer wrong' },
});
const rejected = await new Promise((resolve) => {
  badWs.on('open', () => resolve('opened'));
  badWs.on('error', (e) => resolve(`error:${e.message}`));
  badWs.on('close', () => resolve('closed'));
  setTimeout(() => resolve('timeout'), 2000);
});
check('错误令牌无法升级 WS', rejected !== 'opened' && rejected !== 'timeout', rejected);

console.log('\n[7] 吊销');
// 走插件的管理接口吊销，而不是测试自己的 store —— 吊销必须真的作用到插件持有的那份状态。
const revokeRes = await fetch(`${base}/mobile-gateway/manage/api/revoke`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ deviceId }),
});
check('吊销接口返回 200', revokeRes.status === 200, `status=${revokeRes.status}`);
check('吊销后立即失效', (await api('host.describe', { token })).status === 401);

// 设备列表里也不应再出现它。
const stateAfter = await (await fetch(`${base}/mobile-gateway/manage/api/state`)).json();
check(
  '吊销后设备列表里不再有它',
  !(stateAfter.devices ?? []).some((d) => d.id === deviceId),
  JSON.stringify(stateAfter.devices ?? []).slice(0, 120),
);

console.log('\n[8] 管理面回环闸门');
const manageRemote = await fetch(`${base}/mobile-gateway/manage/api/state`, {
  headers: { 'x-forwarded-for': '8.8.8.8' },
});
check('伪造 XFF 头不影响回环判定', manageRemote.status === 200, `status=${manageRemote.status}`);

// 🔴 真正验证闸门：从**非回环**地址访问，必须被拒。
// 这一条此前是假绿 —— 服务器只绑 127.0.0.1，remoteAddress 永远是回环，
// 断言无论如何都会通过。管理面是铸配对码的入口（完全控制凭据的种子），
// 它挡不住非回环就等于把配对权交给了整个局域网。
if (lanBase) {
  let lanStatus = null;
  try {
    const res = await fetch(`${lanBase}/mobile-gateway/manage/api/state`);
    lanStatus = res.status;
  } catch (error) {
    lanStatus = `ERR:${error.message}`;
  }
  check(
    '非回环来源访问管理面被拒(403)',
    lanStatus === 403,
    `status=${lanStatus}（来源 ${lanIp}）`,
  );

  // 非回环也必须拿不到配对码 —— 这才是闸门真正的意义。
  let mintStatus = null;
  try {
    const res = await fetch(`${lanBase}/mobile-gateway/manage/api/mint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    mintStatus = res.status;
  } catch (error) {
    mintStatus = `ERR:${error.message}`;
  }
  check('非回环来源无法铸配对码(403)', mintStatus === 403, `status=${mintStatus}`);

  // 但**公开的配对端点**在非回环下必须可用 —— 否则手机根本没法配对。
  // 这是「闸门只挡管理面，不挡配对面」的边界验证。
  let pairStatus = null;
  try {
    const res = await fetch(`${lanBase}/mobile-gateway/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'dshm1.INVALID-CODE-XXXX-YYYY' }),
    });
    pairStatus = res.status;
  } catch (error) {
    pairStatus = `ERR:${error.message}`;
  }
  check(
    '非回环仍可访问配对端点(应 403 码不匹配而非被闸门拦)',
    pairStatus === 403 || pairStatus === 404,
    `status=${pairStatus}`,
  );
} else {
  console.log('  （无可用非回环网卡，跳过非回环验证）');
}

console.log('\n[9] 审批/提问应答通道（$events/result）');
// 🔴 2026-10-13 修正：真实主机**没有 `/api/respond`**（全 asar 零命中；
// 实测直连 401、经网关 404）。应答走 RPC endpoint `$events/result`，
// args 形状 `{clientId, eventId, outcome:{kind,...}}`（`parseRemoteEventResult` 逐字）。
// 本组此前测的是那个不存在的端点 —— 假宿主对任何路径都回成功，所以一直是绿的。
//
// ⚠️ 必须重新配对：上面的 [7] 已经把先前那台设备吊销了，用旧 token 打过来
// 只会得到 401（本组第一次写成这样，误判为「网关没转发 respond」）。
{
  const freshCode = await mint();
  const freshPair = await pair(freshCode);
  const respondToken = freshPair.json?.token;
  check('respond 组重新配对成功', !!respondToken, `status=${freshPair.status}`);

  const rpcId = 'host-pending-1';
  const args = {
    clientId: 'client-test-1',
    eventId: 'event-abc',
    outcome: { kind: 'result', value: { approved: true } },
  };
  const body = {
    type: 'client-request',
    rpcId,
    method: '$events/result',
    payload: { args },
  };
  const res = await fetch(`${base}/mobile-gateway/api/$events/result`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${respondToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  check('$events/result 经网关可达（非 404/403）', res.status !== 404 && res.status !== 403, `status=${res.status}`);
  check('$events/result 由插件应答（非宿主兜底）', text.length > 0, `bodyLen=${text.length}`);

  // 关键：网关必须把 body **原样**交给上游，不能改写信封。
  // 注意 calls 是全局累积的，这里按「本次的那条」筛选，别用 at(-1)。
  const forwarded = [...calls].reverse().find((c) => c.method === '$events/result');
  check('$events/result 被转发到上游', !!forwarded, '未找到转发记录');
  check(
    'outcome 形状被原样透传（kind=result）',
    forwarded?.body?.payload?.args?.outcome?.kind === 'result',
    JSON.stringify(forwarded?.body?.payload?.args)?.slice(0, 160),
  );
  check('clientId 未被改写', forwarded?.body?.payload?.args?.clientId === 'client-test-1',
    `clientId=${forwarded?.body?.payload?.args?.clientId}`);
  check('eventId 未被改写', forwarded?.body?.payload?.args?.eventId === 'event-abc',
    `eventId=${forwarded?.body?.payload?.args?.eventId}`);
  check('rpcId 未被改写', forwarded?.body?.rpcId === rpcId, `rpcId=${forwarded?.body?.rpcId}`);

  // 无令牌必须被拦。
  const noAuth = await fetch(`${base}/mobile-gateway/api/$events/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  check('$events/result 无令牌被拒 401', noAuth.status === 401, `status=${noAuth.status}`);

  // 旧路径必须**不存在**（防止有人改回去）。
  // 注意：桩宿主对未知方法回成功，所以这里断言的是**网关不该再暴露 respond 这条**——
  // 真实主机上没有它，保留它只会让 App 以为应答成功。
  const legacy = await fetch(`${base}/mobile-gateway/api/respond`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${respondToken}`,
    },
    body: JSON.stringify({ type: 'client-response', rpcId: 'x', result: { ok: true, value: {} } }),
  });
  // 网关是透明桥，仍会转发任意 /api/<method>；这里只记录事实，不做强断言，
  // 真正的守护在 App 侧（Envelopes 不再产 client-response）与 check-all-endpoints.mjs。
  console.log(`      （参考：旧 /api/respond 经网关 → HTTP ${legacy.status}；真实主机为 404）`);
}

// ---- 9b. outcome.value 的**内容**必须按事件类型分别构造 -------------------
//
// 🔴 这一组防的是「信封对了、value 里塞错东西」这类**静默失败**。
// 主机侧链路（逐字取证）：
//   stream-protocol.ts  outcome = { kind:'result', value?: unknown }
//   dsh-api-gateway     settleRemoteEvent(pending, { kind:'result', value: outcome.value })
//   api-remotes         forwardWaterfall → settled.resolve(outcome.value)
//   ↑ 从这行起 value 就是**该事件的声明返回类型**本身，不再是自由对象。
//
// 两个可应答事件的要求完全不同：
//   approval/request        → ApprovalOutcome 裸字符串 'allowed-once' | 'rejected' | …
//   user-questions/request  → { answers:[{ id, selected:string[], custom? }] }
//
// 且审批那条有**词表归一化**：`OUTCOMES.includes(outcome) ? outcome : 'unavailable'`。
// 也就是说发 `{approved:true}` 这种对象**不会报错**，只会被静默改成 'unavailable'
// —— 用户点了「允许」，工具却以「没有审批通道」被拒绝。这是本项目实际踩过的坑。
//
// 这里断言的是**网关把 App 的形状原样送达**（网关是透明桥，不做校验），
// 真正的守护在 App 侧（Envelopes.approvalOutcome / questionOutcome 的单元语义）。
console.log('\n[9b] outcome.value 按事件类型分型（防静默归一化）');
{
  const cases = [
    {
      label: '审批：value 是 ApprovalOutcome 裸字符串',
      outcome: { kind: 'result', value: 'allowed-once' },
      verify: (o) => o?.kind === 'result' && o.value === 'allowed-once',
    },
    {
      label: '提问：value 是 {answers:[{id,selected}]}',
      outcome: {
        kind: 'result',
        value: { answers: [{ id: 'q-1', selected: ['选项A'] }] },
      },
      verify: (o) => o?.value?.answers?.[0]?.id === 'q-1'
        && o.value.answers[0].selected[0] === '选项A',
    },
    {
      label: '拒绝：value 是 {kind:rejected,error:{name,message}}',
      outcome: { kind: 'rejected', error: { name: 'Error', message: '用户拒绝' } },
      verify: (o) => o?.kind === 'rejected' && o.error?.name === 'Error'
        && o.error?.message === '用户拒绝',
    },
  ];
  // 9 组重新配对的 token 仍有效（该设备没被吊销），直接复用。
  const probeToken = (await pair(await mint())).json?.token;
  for (const c of cases) {
    const rpcId = `shaped-${c.label.slice(0, 4)}`;
    const res = await fetch(`${base}/mobile-gateway/api/$events/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${probeToken}` },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: '$events/result',
        payload: { args: { clientId: 'c-1', eventId: 'e-1', outcome: c.outcome } },
      }),
    });
    const text = await res.text();
    const forwarded = [...calls].reverse().find(
      (x) => x.method === '$events/result' && x.body?.rpcId === rpcId,
    );
    check(
      c.label,
      res.status === 200 && c.verify(forwarded?.body?.payload?.args?.outcome),
      `status=${res.status} ${JSON.stringify(forwarded?.body?.payload?.args?.outcome)?.slice(0, 120) || text.slice(0, 90)}`,
    );
  }

  // 反向对照：**错误**形状（App 曾发的 `{approved:true}`）也必须被原样转发 ——
  // 网关是透明桥、不做语义校验，所以这一条证明「网关不会替我们发现错误」，
  // 即 App 侧的分型构造是**唯一**防线（故 App 有对应断言）。
  const badRpc = 'shaped-bad';
  await fetch(`${base}/mobile-gateway/api/$events/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${probeToken}` },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: badRpc,
      method: '$events/result',
      payload: { args: { clientId: 'c-1', eventId: 'e-1', outcome: { kind: 'result', value: { approved: true } } } },
    }),
  });
  const badForwarded = [...calls].reverse().find(
    (x) => x.method === '$events/result' && x.body?.rpcId === badRpc,
  );
  check(
    '网关不校验 value 语义（错误形状也照转 → App 侧分型是唯一防线）',
    badForwarded?.body?.payload?.args?.outcome?.value?.approved === true,
    JSON.stringify(badForwarded?.body?.payload?.args?.outcome)?.slice(0, 100),
  );
}

// ---- 9c. App 侧源码静态守护 ------------------------------------------------
//
// 上面已证明**网关是透明桥**：它把任何形状原样送到主机。所以「App 发出的
// outcome 对不对」只能靠 App 自己的代码保证 —— 而那个错误在网关测试里**不可见**。
// 这一组直接读 Kotlin 源码，把两条经取证确认的语义钉住（改坏即红）：
//
//   1. 审批的 value 必须是 ApprovalOutcome 裸字符串（词表外的值会被主机静默
//      归一化成 'unavailable' —— 点「允许」却得到「没有审批通道」）。
//   2. 提问的 value 必须是 {answers:[{id, selected}]}，且 id 取**问题**的 id。
//
// 同时反向断言**不再存在**已被证伪的旧形状（`{ok,value}` 信封、`/api/respond`）。
console.log('\n[9c] App 源码静态守护（应答形状 + 旧通道不得回归）');
{
  const appDir = joinPath(
    repoRoot, 'apps', 'android', 'app', 'src', 'main', 'java', 'io', 'github', 'dshmobile', 'app',
  );
  const hasAndroid = existsSync(joinPath(appDir, 'net', 'Envelopes.kt'));

  if (hasAndroid) {
    const stripKotlinComments = (src) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');
    const envelopesSrc = stripKotlinComments(readFileSync(joinPath(appDir, 'net', 'Envelopes.kt'), 'utf8'));
    const connSrc = stripKotlinComments(readFileSync(joinPath(appDir, 'net', 'DshConnection.kt'), 'utf8'));
    const vmSrc = stripKotlinComments(readFileSync(joinPath(appDir, 'ui', 'ChatViewModel.kt'), 'utf8'));

    check(
      "审批 outcome 用 ApprovalOutcome 裸字符串 'allowed-once'",
      /put\(\s*"value"\s*,\s*if\s*\(allow\)\s*"allowed-once"\s*else\s*"rejected"\s*\)/.test(envelopesSrc),
      'Envelopes.approvalOutcome 形状不符',
    );
    check(
      '提问 outcome 是 {answers:[{id,selected}]}',
      /put\(\s*"answers"/.test(envelopesSrc) && /put\(\s*"selected"/.test(envelopesSrc)
        && /fun questionOutcome\(questionId: String, selected: List<String>\)/.test(envelopesSrc),
      'Envelopes.questionOutcome 形状不符',
    );
    check(
      '提问取的是**问题** id（questions[0].id），不是选项',
      /JsonRender\.arr\(req\.payload,\s*"questions"\)/.test(vmSrc)
        && /JsonRender\.str\(it,\s*"id"\)/.test(vmSrc),
      'ChatViewModel 未从 questions[].id 取问题 id',
    );
    check(
      '选项从 questions[0].options[].label 取（对象数组，不是字符串数组）',
      /"label"/.test(vmSrc),
      'ChatViewModel 选项解析未用 label',
    );
    check(
      '不再产出 {ok,value} 信封（client-response）',
      !/client-response/.test(envelopesSrc) && !/TYPE_CLIENT_RESPONSE/.test(envelopesSrc),
      'Envelopes 仍在产 client-response 信封',
    );
    check(
      '不再使用 /api/respond（真实主机无此端点）',
      !/respond"?\s*\)/.test(connSrc) && !/"respond"/.test(connSrc) && /EVENT_RESULT_ENDPOINT/.test(connSrc),
      'DshConnection 仍在用 /api/respond',
    );
    check(
      '单条 mux：WS_MUX 指向 remote.mux，且无 WS_HOST',
      /WS_MUX\s*=\s*"\/mobile-gateway\/remote\.mux"/.test(connSrc) && !/WS_HOST/.test(connSrc),
      'DshConnection 的 WS 常量不符',
    );
    check(
      '事件流 endpoint 是 $events（转义后的 \\$events）',
      /EVENT_STREAM_ENDPOINT\s*=\s*"\\\$events"/.test(connSrc)
        && /EVENT_RESULT_ENDPOINT\s*=\s*"\\\$events\/result"/.test(connSrc),
      '事件流 endpoint 常量不符',
    );
    check(
      '阻塞式 execute() 仍包在 Dispatchers.IO 里（防 NetworkOnMainThreadException）',
      /withContext\(Dispatchers\.IO\)/.test(connSrc)
        && !/execute\(\)[\s\S]{0,80}viewModelScope/.test(connSrc),
      'DshConnection 的 execute 可能不在 IO 线程',
    );
    check(
      'ready 帧记下 clientId（应答必须带上）',
      /eventClientId\s*=\s*value\.str\("clientId"\)/.test(connSrc),
      'DshConnection 未记录 clientId',
    );
  } else {
    // 守卫现代化 TypeScript Web / Electron 客户端源码
    const envelopesTs = readFileSync(joinPath(repoRoot, 'src', 'services', 'envelopes.ts'), 'utf8');
    const connTs = readFileSync(joinPath(repoRoot, 'src', 'services', 'connection.ts'), 'utf8');
    const appTs = readFileSync(joinPath(repoRoot, 'src', 'App.tsx'), 'utf8');

    check(
      "审批 outcome 用 ApprovalOutcome 裸字符串 'allowed-once'",
      /value:\s*allow\s*\?\s*'allowed-once'\s*:\s*'rejected'/.test(envelopesTs),
      'envelopes.ts approvalOutcome 形状不符',
    );
    check(
      '提问 outcome 是 {answers:[{id,selected}]}',
      /answers:\s*\[\s*\{\s*id:\s*questionId,\s*selected/.test(envelopesTs),
      'envelopes.ts questionOutcome 形状不符',
    );
    check(
      '提问取的是**问题** id（questions[0].id），不是选项',
      /questionId:\s*qFirst\?\.id/.test(appTs),
      'App.tsx 未从 qFirst?.id 取问题 id',
    );
    check(
      '选项从 questions[0].options[].label 取（对象数组，不是字符串数组）',
      /qFirst\?\.options\?\.map\(\(o\)\s*=>\s*o\.label/.test(appTs),
      'App.tsx 选项解析未用 o.label',
    );
    check(
      '不再产出 {ok,value} 信封（client-response）',
      !/client-response/.test(envelopesTs) && !/TYPE_CLIENT_RESPONSE/.test(envelopesTs),
      'envelopes.ts 仍包含 client-response 信封',
    );
    check(
      '不再使用 /api/respond（真实主机无此端点）',
      !/respond"?\s*\)/.test(connTs) && !/"respond"/.test(connTs) && /EVENT_RESULT_ENDPOINT/.test(connTs),
      'connection.ts 仍在用 /api/respond',
    );
    check(
      '单条 mux：WS_MUX 指向 remote.mux，且无 WS_HOST',
      /WS_MUX\s*=\s*'\/mobile-gateway\/remote\.mux'/.test(connTs) && !/WS_HOST/.test(connTs),
      'connection.ts WS_MUX 常量不符',
    );
    check(
      '事件流 endpoint 是 $events（转义后的 \\$events）',
      /EVENT_STREAM_ENDPOINT\s*=\s*'\$events'/.test(connTs)
        && /EVENT_RESULT_ENDPOINT\s*=\s*'\$events\/result'/.test(connTs),
      'connection.ts 事件流 endpoint 常量不符',
    );
    // ⚠️ 这条断言要盯的是**性质**（RPC 走异步、不存在同步阻塞调用），
    // 不是某个字面量写法。第一版写死了 `/await fetch\(/`，结果 T3 把调用点改成
    // `await this.fetchImpl(...)`（为了可注入 fetch 替身）时它就假红了 ——
    // 断言实现细节的测试，会在一次无害重构后变成噪音。
    check(
      'RPC 走异步 fetch，且不存在同步阻塞式 XHR（Web 栈的等价守护）',
      /await\s+(this\.)?(fetchImpl|fetch)\s*\(/.test(connTs) &&
        !/async\s*=\s*false/.test(connTs) &&
        !/\.open\(\s*[^)]*,\s*false\s*\)/.test(connTs),
      'connection.ts 出现同步阻塞调用，会卡住渲染线程',
    );
    check(
      'ready 帧记下 clientId（应答必须带上）',
      /this\.eventClientId\s*=\s*String\(val\.clientId\)/.test(connTs),
      'connection.ts 未记录 clientId',
    );
    // 🔴 上面几条只检查了 envelopes.ts 的**定义**。如果调用侧（组件）又手写一份
    // 字面量，定义再正确也保护不到真实链路 —— 所以必须同时断言**调用侧**走构造器。
    // 这是 2026-10-14 补的：此前 App.tsx 手写 `{kind:'result',value:'allowed-once'}`，
    // 本组 83 条断言全绿，却完全没覆盖它。
    check(
      'App.tsx 的审批/提问作答走 Envelopes 构造器（不得手写字面量）',
      /Envelopes\.approvalOutcome\s*\(/.test(appTs) && /Envelopes\.questionOutcome\s*\(/.test(appTs),
      'App.tsx 绕过了 Envelopes —— 契约测试将无法覆盖真实发出的值',
    );
    check(
      'App.tsx 检查了 respond() 的返回值（应答失败不得静默丢弃）',
      /const\s+ok\s*=\s*await\s+connRef\.current\.respond/.test(appTs),
      'App.tsx 丢弃了 respond() 的返回值：没送达也会清掉待审批弹窗',
    );
  }
}

// ---- 10. 路由命中回归：防「宿主兜底 404」这种静默故障 -------------------
// 本次事故的形态：路由注册语句写错（prefix path 带尾斜杠），所有子路径都落到
// 宿主兜底 404。它的特征是**响应体为空**，与插件自己的 404（带 JSON error）不同。
// 这一组断言把「插件确实应答了」和「宿主替它应答了」区分开。
console.log('\n[10] 路由命中回归（区分宿主兜底与插件应答）');
for (const [label, path, method] of [
  ['health', '/mobile-gateway/health', 'GET'],
  ['pair（无码应被插件拒绝，不是兜底）', '/mobile-gateway/pair', 'POST'],
  ['未知子路径应被插件应答', '/mobile-gateway/nope', 'GET'],
]) {
  const res = await fetch(`${base}${path}`, {
    method,
    ...(method === 'POST'
      ? { headers: { 'content-type': 'application/json' }, body: '{}' }
      : {}),
  });
  const text = await res.text();
  const pluginAnswered = text.length > 0;
  check(`${label}：由插件应答（非宿主兜底）`, pluginAnswered, `status=${res.status} bodyLen=${text.length}`);
}

await bridge.dispose();
await store.flush();
// Node 的 fetch 会留 keep-alive 连接，不主动断开会挂住进程退出。
server.closeAllConnections?.();
server.close();
await log.flush();

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);