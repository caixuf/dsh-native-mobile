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
import { WebSocket } from 'ws';
import { DeviceStore } from '../lib/store.mjs';
import { createBridge } from '../lib/bridge.mjs';
import { createManageApi } from '../lib/manage.mjs';
import { sendError, sendJson, readJsonBody } from '../lib/http.mjs';
import { createLogger } from '../lib/util.mjs';
import { PRIVILEGED_METHODS } from '../lib/bridge.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    return {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 3; i += 1) {
          if (signal?.aborted) return;
          yield { type: 'server-request', rpcId: `evt-${endpoint}-${i}`, method: 'tick', payload: { i } };
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

async function pair(code) {
  const res = await fetch(`${base}/mobile-gateway/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'Pixel', platform: 'android' }),
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

console.log('\n[5] 事件流');
async function readFrames(path, token, expected) {
  const ws = new WebSocket(base.replace('http', 'ws') + path, { headers: { authorization: `Bearer ${token}` } });
  const frames = [];
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  });
  const deadline = Date.now() + 3000;
  while (frames.length < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  ws.close();
  return frames;
}
const muxFrames = await readFrames('/mobile-gateway/events.mux', token, 3);
check('mux 推来 3 帧', muxFrames.length === 3, `got ${muxFrames.length}`);
check('帧形状为 server-request', muxFrames[0]?.type === 'server-request' && muxFrames[0].method === 'tick');
const hostFrames = await readFrames('/mobile-gateway/events.host', token, 3);
check('host 推来 3 帧', hostFrames.length === 3, `got ${hostFrames.length}`);

console.log('\n[6] WS 鉴权');
const badWs = new WebSocket(base.replace('http', 'ws') + '/mobile-gateway/events.mux', {
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

console.log('\n[9] /api/respond（审批/提问的应答通道）');
// 官方契约：服务端主动请求的应答**不走 WS**，而是 POST /api/respond，
// 且 result 必须是 { ok, value } 信封（见 docs/api-contract.md §1.4）。
// 这条路径此前零覆盖 —— 而它是 App 审批交互的唯一出口。
//
// ⚠️ 必须重新配对：上面的 [7] 已经把先前那台设备吊销了，用旧 token 打过来
// 只会得到 401（本组第一次写成这样，误判为「网关没转发 respond」）。
{
  const freshCode = await mint();
  const freshPair = await pair(freshCode);
  const respondToken = freshPair.json?.token;
  check('respond 组重新配对成功', !!respondToken, `status=${freshPair.status}`);

  const rpcId = 'host-pending-1';
  const body = {
    type: 'client-response',
    rpcId,
    result: { ok: true, value: { kind: 'allow', approved: true } },
  };
  const res = await fetch(`${base}/mobile-gateway/api/respond`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${respondToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  check('respond 经网关可达（非 404/403）', res.status !== 404 && res.status !== 403, `status=${res.status}`);
  check('respond 由插件应答（非宿主兜底）', text.length > 0, `bodyLen=${text.length}`);

  // 关键：网关必须把 body **原样**交给上游，不能改写信封。
  // 注意 calls 是全局累积的，这里按「本次 respond 的那条」筛选，别用 at(-1)。
  const forwarded = [...calls].reverse().find((c) => c.method === 'respond');
  check('respond 被转发到上游 /api/respond', !!forwarded, `未找到 respond 转发记录`);
  check(
    'respond 的 { ok, value } 信封被原样透传',
    forwarded?.body?.result?.ok === true && forwarded.body.result.value?.kind === 'allow',
    JSON.stringify(forwarded?.body).slice(0, 160),
  );
  check('respond 的 rpcId 未被改写', forwarded?.body?.rpcId === rpcId, `rpcId=${forwarded?.body?.rpcId}`);

  // 无令牌必须被拦。
  const noAuth = await fetch(`${base}/mobile-gateway/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  check('respond 无令牌被拒 401', noAuth.status === 401, `status=${noAuth.status}`);
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