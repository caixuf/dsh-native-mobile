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

/** 模拟 `ctx.connection.createSharedFetchHandler('/api')`。 */
async function fakeApiFetch(request) {
  const url = new URL(request.url);
  const method = url.pathname.replace(/^\/api\//, '');
  const body = await request.json().catch(() => ({}));
  calls.push({ method, body });

  // 特权方法在官方载体里靠「空信任表」钉在回环；这里如实复现：只有回环能到。
  if (PRIVILEGED_METHODS.includes(method)) {
    privilegedLeak.push(method);
    return Response.json(
      { type: 'server-response', result: { ok: true, value: { shouldNotHappen: true } } },
      { status: 200 },
    );
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

/**
 * 复刻 DSH `webServer.register` 的真实匹配语义。
 *
 * 这段是本次最大的教训：原来的桩写成宽松的 `pathname.startsWith(r.path)`，
 * 比现实更宽松，于是放过了「prefix path 带尾斜杠」这个 bug ——
 * 18 项断言全绿，真机上一个路由都命中不了。
 *
 * 由实测反推的规则（对照能正常工作的 dsh-bot-gateway）：
 *   path='/bot-gateway'    →  /bot-gateway       命中
 *                             /bot-gateway/      命中
 *                             /bot-gateway/anything 命中
 *   path='/mobile-gateway/'→  /mobile-gateway/     命中（精确相等）
 *                             /mobile-gateway/health **不命中**
 * 即：exact 相等，或 pathname 以 `path + '/'` 开头。带尾斜杠会让后半条永远为假。
 */
function matchesRoute(route, pathname) {
  if (route.kind === 'exact') return route.path === pathname;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  const hit = routes.find((r) => matchesRoute(r, pathname));
  if (!hit) return sendError(res, 404, 'not_found', `no route for ${pathname}`);
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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

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

console.log('\n[4] 特权方法闸门');
const before = privilegedLeak.length;
const settings = await api('settings.describe', { token });
check('settings.describe 被网关拒绝(403)', settings.status === 403, `status=${settings.status}`);
check('拒绝时没有触达宿主', privilegedLeak.length === before);
const creds = await api('credentials.set', { token });
check('credentials.set 被拒绝(403)', creds.status === 403, `status=${creds.status}`);

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
check('管理面只应答回环(本进程是回环所以 200)', manageRemote.status === 200, `status=${manageRemote.status}`);

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