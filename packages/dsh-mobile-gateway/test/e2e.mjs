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

const store = new DeviceStore(join(tmpdir(), `dsh-mgw-devices-${randomUUID()}.json`), log);
await store.load();

const config = {
  enabled: true,
  pairingTtlMs: 60_000,
  tokenTtlMs: 3_600_000,
  publicBaseUrl: '',
  logLevel: 'error',
};

const bridge = createBridge({ ctx: fakeCtx, store, log, config });
const manage = createManageApi({ store, log, config, instance: { name: 'test-host' }, gatewayVersion: '0.1.0' });

const API_PREFIX = '/mobile-gateway/api/';
const routes = [];
function route(kind, path, handler) {
  routes.push({ kind, path, handler });
}

route('exact', '/mobile-gateway/pair', async (req, res) => {
  const body = await readJsonBody(req);
  const result = await store.redeem(body.code, {
    ttlMs: config.tokenTtlMs,
    deviceName: body.deviceName,
    platform: body.platform,
  });
  if (!result.ok) return sendError(res, 403, result.reason, 'nope');
  sendJson(res, 200, { device: result.device, token: result.token, instance: { name: 'test-host' } });
});
route('prefix', '/mobile-gateway/api/', async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  await bridge.handleApi(req, res, path.slice(API_PREFIX.length - 1));
});
route('prefix', '/mobile-gateway/', async (req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  if (await manage(req, res, pathname)) return;
  sendError(res, 404, 'not_found', 'no route');
});
const upgrades = new Map();
for (const endpoint of ['/api/events.mux', '/api/events.host']) {
  upgrades.set(endpoint.replace('/api/', '/mobile-gateway/'), (req, socket, head) =>
    bridge.handleEventsUpgrade(req, socket, head, endpoint),
  );
}

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  const hit = routes.find((r) => (r.kind === 'exact' ? r.path === pathname : pathname.startsWith(r.path)));
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
  const res = await fetch(`${base}${API_PREFIX}${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? { type: 'client-request', rpcId: 'r1', method, payload: {} }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function mint() {
  const pairing = await store.mintPairing({ ttlMs: 60_000, origin: 'test' });
  return pairing.display;
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

const replay = await pair(code);
check('配对码一次性（重放被拒）', replay.status === 403, `status=${replay.status}`);

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
store.revoke(paired.json.device.id);
check('吊销后立即失效', (await api('host.describe', { token })).status === 401);

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