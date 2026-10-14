/**
 * 假主机 —— **端到端验证审批链路**用的最小主机替身。
 *
 * ## 为什么需要它
 *
 * 「电脑端等授权 → 手机收到并当场处理」是这个产品存在的理由，但在此之前
 * **从未被端到端验证过**：真实主机不会因为你想测就发一条审批出来。
 * 这个脚本实现主机信号面的最小子集，于是这条链路可以被真正跑一遍：
 *
 * ```
 *   假主机 ──WS /mobile-gateway/remote.mux──▶ 手机中继服务
 *          ◀── ready / waterfall(审批) ──────
 *   手机通知栏 ──「允许一次」──▶ POST /mobile-gateway/api/$events/result
 *          ──▶ 假主机校验 outcome 并打印结论
 * ```
 *
 * ## 它校验什么（这才是重点）
 *
 * 不只是"收到一个请求"，而是**逐字校验**应答形状：
 * `method` 必须是 `$events/result`、`args` 必须恰好是 `{clientId,eventId,outcome}`、
 * 且 `outcome.value` 必须是**主机词表内的裸字符串** —— 词表外的值会被真实主机
 * 静默归一化成 `unavailable`（= 拒绝），这是本项目最贵的 bug。
 *
 * ## 用法
 *
 * ```bash
 * node packages/dsh-mobile-gateway/scripts/fake-host.mjs
 * adb reverse tcp:19400 tcp:19400
 * adb shell am start -n io.github.dshmobile.app/.MainActivity \
 *   --es dsh_relay_base_url http://127.0.0.1:19400 --es dsh_relay_token e2e-token-1
 * ```
 *
 * 退出码：0 = 收到合法应答；2 = 收到非法应答；3 = 超时没等到；4 = 鉴权被拒。
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.FAKE_HOST_PORT || 19400);
const TOKEN = process.env.FAKE_HOST_TOKEN || 'e2e-token-1';
const EVENT_ID = process.env.FAKE_HOST_EVENT_ID || 'ev-e2e-1';
const CLIENT_ID = 'fake-client-1';
/** 连上后多久发审批（给中继留出 ready 握手时间）。 */
const EMIT_DELAY_MS = Number(process.env.FAKE_HOST_EMIT_DELAY_MS || 2000);
/** 整体看门狗：超时没等到应答就如实失败，别静默挂死。 */
const DEADLINE_MS = Number(process.env.FAKE_HOST_DEADLINE_MS || 120000);

const VOCABULARY = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];

const log = (...args) => console.log('[fake-host]', ...args);

function authToken(req, url) {
  const auth = req.headers.authorization;
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const fromQuery = url?.searchParams?.get('token');
  return fromQuery ? fromQuery.trim() : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 校验应答形状；返回 null 表示合法，否则返回失败原因。 */
function validateResult(body) {
  if (body?.type !== 'client-request') return `信封 type 应为 client-request，实际 ${body?.type}`;
  if (body.method !== '$events/result') return `method 应为 $events/result（斜杠形式），实际 ${body.method}`;

  const args = body?.payload?.args;
  if (!args || typeof args !== 'object') return 'payload.args 缺失';
  const keys = Object.keys(args).sort();
  if (keys.join(',') !== 'clientId,eventId,outcome') return `args 键应为 {clientId,eventId,outcome}，实际 {${keys}}`;
  if (args.clientId !== CLIENT_ID) return `clientId 应为 ${CLIENT_ID}，实际 ${args.clientId}`;
  if (args.eventId !== EVENT_ID) return `eventId 应为 ${EVENT_ID}，实际 ${args.eventId}`;
  if (args.outcome?.kind !== 'result') return `outcome.kind 应为 result，实际 ${args.outcome?.kind}`;

  const value = args.outcome.value;
  if (typeof value !== 'string') {
    return `outcome.value 必须是**裸字符串**，实际是 ${typeof value} —— 真实主机会把它静默归一化成 unavailable（= 拒绝）`;
  }
  if (!VOCABULARY.includes(value)) {
    return `outcome.value='${value}' 不在主机词表 ${JSON.stringify(VOCABULARY)} 内 —— 真实主机会静默当成拒绝`;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/mobile-gateway/api/$events/result') {
    const token = authToken(req, url);
    if (token !== TOKEN) {
      log(`应答携带的令牌不对（收到 ${token ? '另一个值' : '空'}）→ 401`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unauthorized' } }));
      return;
    }

    const raw = await readBody(req);
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      log('应答不是合法 JSON');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'bad_json' } }));
      return;
    }

    log('收到应答：', JSON.stringify(body?.payload?.args?.outcome));

    const problem = validateResult(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: { ok: true, value: null } }));

    if (problem) {
      console.error(`\n✗ 端到端失败：${problem}\n`);
      setTimeout(() => process.exit(2), 200);
      return;
    }

    console.log(`\n✓ 端到端通过：审批到达手机 → 通知 → 用户点选 → 回执主机`);
    console.log(`  outcome.value = ${JSON.stringify(body.payload.args.outcome.value)}（词表内，未被归一化）`);
    console.log(`  eventId = ${body.payload.args.eventId}，clientId = ${body.payload.args.clientId}`);
    setTimeout(() => process.exit(0), 300);
    return;
  }

  log(`未实现的路径：${req.method} ${url.pathname}`);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'not_found' } }));
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const token = authToken(req, url);

  if (url.pathname !== '/mobile-gateway/remote.mux') {
    log(`未知 WS 路径：${url.pathname}`);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  if (token !== TOKEN) {
    // 这条分支同时验证「原生中继用 Authorization 头带令牌」—— 网页端只能用 ?token=
    const via = req.headers.authorization ? 'Authorization 头' : (url.searchParams.get('token') ? '?token= 查询参数' : '无令牌');
    log(`WS 鉴权失败（来源：${via}）→ 401`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    process.exitCode = 4;
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const via = req.headers.authorization ? 'Authorization 头' : '?token= 查询参数';
  log(`事件流已连接（令牌来源：${via}）`);

  ws.send(JSON.stringify({ type: 'item', streamId: 'probe', value: { type: 'ready', clientId: CLIENT_ID } }));
  log(`已下发 ready（clientId=${CLIENT_ID}）`);

  ws.on('message', (data) => {
    let msg = null;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log('收到非 JSON 帧');
      return;
    }

    if (msg.type === 'open') {
      const keys = Object.keys(msg).sort().join(',');
      if (keys !== 'endpoint,payload,streamId,type') {
        log(`⚠️ open 帧键不对：{${keys}} —— 网关会以 1008 关闭连接`);
      }
      if (msg.endpoint !== '$events') log(`⚠️ open 帧 endpoint 应为 $events，实际 ${msg.endpoint}`);
      log(`收到 open 帧（endpoint=${msg.endpoint}），${EMIT_DELAY_MS}ms 后下发一条审批`);

      setTimeout(() => {
        if (ws.readyState !== ws.OPEN) {
          log('审批下发失败：连接已关闭');
          return;
        }
        ws.send(JSON.stringify({
          type: 'item',
          streamId: msg.streamId,
          value: {
            type: 'waterfall',
            event: 'tool/approval',
            eventId: EVENT_ID,
            request: {
              toolName: 'shell',
              displayReason: '将要执行 rm -rf build/ 清理构建目录（假主机端到端验证）',
            },
          },
        }));
        log(`已下发 waterfall 审批 eventId=${EVENT_ID} —— 现在应当出现通知`);
      }, EMIT_DELAY_MS);
      return;
    }
    log(`收到帧：${msg.type}`);
  });

  ws.on('close', (code) => log(`事件流关闭 code=${code}`));
  ws.on('error', (err) => log(`事件流错误：${err.message}`));
});

server.listen(PORT, '0.0.0.0', () => {
  log(`已监听 0.0.0.0:${PORT}（token=${TOKEN}，eventId=${EVENT_ID}）`);
  log('等待手机中继连接…');
});

setTimeout(() => {
  console.error(`\n✗ 端到端超时（${DEADLINE_MS}ms）：没有收到合法的应答\n`);
  process.exit(3);
}, DEADLINE_MS).unref();