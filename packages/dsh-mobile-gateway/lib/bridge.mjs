/**
 * @file lib/bridge.mjs
 * @description 协议透明的 `/api` 桥：把 DSH 官方 RPC 与两条下行事件流，
 *              在**已鉴权**的前提下原样送到手机。
 *
 * 为什么是透明桥而不是另造一套移动 API：
 *   - `/api` 的契约由官方包（`@deepseek-ai/dsh-client-connection`，BSD-3-Clause）定义并随版本演进；
 *     另造一套只会让我们永久追在后面。
 *   - 手机端因此与官方 Web 客户端**讲同一种协议**，上游新增能力无需改网关。
 *
 * 关键安全点（务必理解后再改）：
 *   官方 node 载体会把一组**特权方法**（settings/credentials/pluginManager/…）用**空信任表**
 *   过栅栏，从而把它们钉死在回环。但我们构造的内部请求永远是回环身份，若原样转发，
 *   等于给配对设备额外开了一整片本机特权面。因此这里显式复刻那张名单并默认拒绝。
 *
 * 转发规则：
 *   POST /mobile-gateway/api/<method...>   →  http://127.0.0.1/api/<method...>
 *   WS   /mobile-gateway/events.mux        →  typertGateway.wireStream.open('/api/events.mux', …)
 *   WS   /mobile-gateway/events.host       →  typertGateway.wireStream.open('/api/events.host', …)
 */

import { WebSocketServer } from 'ws';
import { header } from './util.mjs';

/**
 * 与官方 node 载体一致：这组方法即使在受信部署上也只对回环开放。
 *
 * ⚠️ 用**点号**书写（便于与官方文档对照），但匹配时会先归一化 ——
 * 真实请求走的是**斜杠 endpoint**（`settings/describe`）。
 * 曾经因为只比对点号形式，导致 `settings/describe` 直接放行（提权漏洞，实测发现）。
 */
export const PRIVILEGED_METHODS = [
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
  'directoryPicker.pick',
];

/**
 * 按命名空间前缀整体拒绝。同样用点号书写，匹配前归一化。
 *
 * 这两个命名空间是**配置面与凭据面**：放行等于把本机特权交给每台配对设备。
 * `directoryPicker` 会驱动宿主桌面（弹原生目录选择器），也一并拦下。
 */
export const PRIVILEGED_PREFIXES = [
  'settings.',
  'credentials.',
  'pluginManager.',
  'agentPreset.',
  'directoryPicker.',
];

/**
 * 把方法名归一化成**点号小写形式**，用于与上面两张表比对。
 *
 * ## 为什么不能只做字符串替换（这是一个真实漏洞的修法）
 *
 * 攻击者可以构造 `./settings.describe` 或 `x/../settings.describe`：
 *   - 闸门若按**原样**比对，`./settings.describe` ≠ `settings.describe`，于是放行；
 *   - 而下游 `new Request('http://127.0.0.1/api/./settings.describe')` 会把它
 *     **归一化成** `/api/settings.describe`，主机最终执行的正是那个特权方法。
 *
 * 即「闸门看到的字符串 ≠ 上游执行的端点」。verifier 独立发现并验证了这条绕过路径。
 *
 * 所以这里必须**真正解析路径**（折叠 `.` 与 `..`、丢弃空段），而不是字符串替换 ——
 * 替换只会让 `./settings.describe` 变成 `..settings.describe`，依然不等于
 * `settings.describe`，闸门照样放行（这正是第一次修复时的错误）。
 */
export function normalizeMethod(method) {
  const raw = String(method ?? '').trim();
  // 用 WHATWG URL 做权威归一化：它会折叠 `.` / `..` / 空段，
  // 与下游 new Request() 的行为一致。
  let pathname = raw;
  try {
    pathname = new URL(`http://x/${raw.replace(/^\/+/, '')}`).pathname;
  } catch {
    /* 解析失败就用原串，下面仍会做段清洗 */
  }
  const segments = pathname.split('/').filter((s) => s.length > 0 && s !== '.' && s !== '..');
  const joined = segments.join('/');
  const firstSlash = joined.indexOf('/');
  const dotted =
    firstSlash < 0 ? joined : `${joined.slice(0, firstSlash)}.${joined.slice(firstSlash + 1)}`;
  return dotted.toLowerCase();
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function rawReject(socket, status, text, body) {
  const payload = JSON.stringify(body);
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      'Connection: close\r\n\r\n' +
      payload,
  );
  socket.destroy();
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体超过 32 MiB 上限');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function readToken(req, url) {
  const auth = header(req, 'authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const fromQuery = url?.searchParams?.get('token');
  return fromQuery ? fromQuery.trim() : null;
}

export function createBridge({ ctx, store, log, config }) {
  const apiFetch = ctx.connection.createSharedFetchHandler('/api');
  const typert = ctx.typertGateway;
  const peer = ctx.connection.operator;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });

  // 两张表都归一化成点号小写形式，与 normalizeMethod() 的输出可比。
  const deniedExact = new Set(
    [...(config.deniedMethods ?? PRIVILEGED_METHODS)].map((m) => normalizeMethod(m)),
  );
  const deniedPrefixes = (config.deniedPrefixes ?? PRIVILEGED_PREFIXES).map((p) =>
    p.trim().toLowerCase(),
  );

  /**
   * 特权方法闸门。
   *
   * 🔴 三条都必须做，缺一条就是一个真实的提权漏洞（都实测过）：
   *
   * 1. **归一化后再比对**：真实请求走斜杠 endpoint（`settings/describe`），
   *    而名单用点号书写。直接比对原字符串会让 `settings/describe` 一路放行。
   * 2. **真正解析路径**：`./settings.describe`、`x/../settings.describe` 必须
   *    折叠成 `settings.describe` 再判断 —— 因为下游 `new Request()` 会折叠它们，
   *    「闸门看到的字符串」必须等于「上游执行的端点」。
   * 3. **先做百分号解码**：`%2e` 就是 `.`，不解码则 `%2e/settings.describe` 绕过。
   *
   * 任一步失败都**倾向于拒绝**（fail-closed）：解析异常时用原串继续比对，
   * 而不是放行。
   */
  function isDenied(method) {
    let raw = String(method ?? '');
    // 3. 百分号解码（多次，防 %252e 这类双重编码）。解码失败就用原串。
    for (let i = 0; i < 2; i += 1) {
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded === raw) break;
        raw = decoded;
      } catch {
        break; // 非法编码序列：保留原串，下面按原样比对（倾向拒绝）
      }
    }
    // 1 + 2. 去掉首尾斜杠后做真正的路径归一化。
    const normalized = normalizeMethod(raw.replace(/^\/+|\/+$/g, ''));
    if (deniedExact.has(normalized)) return true;
    if (deniedPrefixes.some((p) => normalized.startsWith(p))) return true;
    // 额外兜底：归一化结果里若仍残留点段（说明有我们没预料到的形式），一律拒绝。
    if (/(^|[.\/])\.\.?([.\/]|$)/.test(normalized)) return true;
    return false;
  }

  // ---- HTTP: /mobile-gateway/api/<method...> -----------------------------
  async function handleApi(req, res, apiPath) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = readToken(req, url);
    const device = token ? store.verify(token) : null;
    if (!device) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: '设备令牌缺失或已吊销' } }));
      return;
    }

    // method 既是路径段，也是官方 envelope 里的 `method` 字段；两者必须一致。
    const method = apiPath.replace(/^\/+/, '');
    if (isDenied(method)) {
      log.warn('privileged method refused for paired device', { method, deviceId: device.id });
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          type: 'server-response',
          result: {
            ok: false,
            error: {
              code: 'loopback_only',
              message: `方法 ${method} 仅对本机回环开放，已被移动网关拒绝`,
              details: {},
            },
          },
        }),
      );
      return;
    }

    const body = req.method === 'POST' ? await readBody(req) : undefined;

    // ---- 移动端瘦身（实测 432 KB → ~30 KB）--------------------------------
    // `session/list` 的每条 item 都带全量 projections，其中 tokenUsage/contextBreakdown
    // 含几百个 UUID 的统计，而列表页只需要 title/running/updatedAt。
    // 手机带宽有限（公网走 FRP 隧道），把用不到的字段剥掉，列表秒开。
    let upstreamBody = body;
    const isSessionList = method === 'session/list' || method === 'session.list';
    if (isSessionList && body && body.length) {
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        if (parsed?.payload?.args) {
          // args 形状保持不变（服务器只认 `_request`），瘦身发生在**响应侧**。
          upstreamBody = body; // 请求原样转发；真正的瘦身在下面响应处理里
        }
      } catch {
        /* 非 JSON 就原样转发 */
      }
    }

    const upstream = new Request(`http://127.0.0.1/api/${method}`, {
      method: req.method,
      headers: { 'content-type': header(req, 'content-type') ?? 'application/json' },
      body: upstreamBody && upstreamBody.length ? upstreamBody : undefined,
    });

    const response = await apiFetch.fetch(upstream);
    const buffer = Buffer.from(await response.arrayBuffer());

    // ---- 响应侧瘦身：session/list 剥掉重字段 ------------------------------
    let outBuffer = buffer;
    if (isSessionList && response.status === 200) {
      try {
        const json = JSON.parse(buffer.toString('utf8'));
        const items = json?.result?.value?.items;
        if (Array.isArray(items)) {
          for (const item of items) {
            const vals = item?.projections?.values;
            if (vals && typeof vals === 'object') {
              // 只保留列表页真正用到的
              item.projections.values = {
                title: vals.title,
                sessionListMetadata: vals.sessionListMetadata,
              };
              item.projections.asOfSeq = undefined;
            }
          }
          const slim = JSON.stringify(json);
          log.debug('session/list slimmed', {
            before: `${(buffer.length / 1024).toFixed(0)} KB`,
            after: `${(slim.length / 1024).toFixed(0)} KB`,
          });
          outBuffer = Buffer.from(slim, 'utf8');
        }
      } catch {
        /* 解析失败就原样返回，瘦身是优化不是正确性依赖 */
      }
    }

    const headers = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'content-length') headers[key] = value;
    });
    res.writeHead(response.status, { ...headers, 'Content-Length': outBuffer.length });
    res.end(outBuffer);
  }

  // ---- WebSocket: 两条下行事件流 -----------------------------------------
  wss.on('connection', (socket, req, device, endpoint) => {
    const controller = new AbortController();

    // 官方下行是只下行的：uplink 给一个永不产出、只等中止的空流即可。
    const uplink = {
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
      },
    };

    socket.on('message', () => {
      // 官方语义：下行通道收到任何上行数据都以 1008 关闭。
      socket.close(1008, 'downlink only');
    });

    const pump = async () => {
      try {
        const stream = await typert.wireStream.open(endpoint, {}, uplink, peer, controller.signal);
        for await (const frame of stream) {
          if (socket.readyState !== socket.OPEN) break;
          socket.send(JSON.stringify(frame));
        }
      } catch (error) {
        log.warn('event stream ended', { endpoint, error: String(error?.message ?? error) });
      } finally {
        if (socket.readyState === socket.OPEN) socket.close(1000, 'stream closed');
        socket.removeAllListeners();
      }
    };

    socket.on('close', () => controller.abort());
    socket.on('error', (error) => {
      log.warn('event socket error', { endpoint, error: String(error) });
      controller.abort();
    });

    log.info('device attached to event stream', { endpoint, deviceId: device.id });
    void pump();
  });

  function handleUpgrade(req, socket, head, endpoint) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = readToken(req, url);
    if (!token) {
      rawReject(socket, 401, 'Unauthorized', { error: { code: 'unauthorized', message: '缺少设备令牌' } });
      return;
    }
    const device = store.verify(token);
    if (!device) {
      rawReject(socket, 403, 'Forbidden', { error: { code: 'invalid_token', message: '设备令牌未知或已吊销' } });
      return;
    }
    // 官方下行不带子协议：显式拒绝任何 Sec-WebSocket-Protocol，避免协商歧义。
    if (header(req, 'sec-websocket-protocol')) {
      rawReject(socket, 400, 'Bad Request', {
        error: { code: 'no_subprotocol', message: '下行通道不接受子协议' },
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, device, endpoint);
    });
  }

  return {
    handleApi,
    handleEventsUpgrade: handleUpgrade,
    describe: () => ({ eventSockets: wss.clients.size }),

    async dispose() {
      // 用 terminate 而不是 close：插件卸载时不能等对端优雅关闭，
      // 而且有残留 socket 时 wss.close() 的回调可能永远不来，故加一道兜底超时。
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
        wss.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}