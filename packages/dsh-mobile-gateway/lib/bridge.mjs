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
 * 把方法名归一化成**点号形式**，用于与上面两张表比对。
 *
 * 真实 endpoint 是斜杠形式（`settings/describe`），而名单用点号书写；
 * 只取第一个斜杠，避免误伤命名空间本身含斜杠的情况（目前没有）。
 * 同时统一小写，防大小写绕过。
 */
export function normalizeMethod(method) {
  const firstSlash = method.indexOf('/');
  const dotted = firstSlash < 0 ? method : method.slice(0, firstSlash) + '.' + method.slice(firstSlash + 1);
  return dotted.trim().toLowerCase();
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
   * 🔴 必须用 normalizeMethod() 归一化后再比对：真实请求走**斜杠 endpoint**
   * （`settings/describe`），而名单用点号书写。曾经因为直接比对原字符串，
   * 导致 `settings/describe` 一路放行 —— 实测确认那是提权（settings.describe 成功返回）。
   *
   * 另外先去掉首尾斜杠与空白，防 `/settings/describe`、` settings/describe ` 这类变体绕过。
   */
  function isDenied(method) {
    const normalized = normalizeMethod(String(method ?? '').replace(/^\/+|\/+$/g, ''));
    if (deniedExact.has(normalized)) return true;
    return deniedPrefixes.some((p) => normalized.startsWith(p));
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
    const upstream = new Request(`http://127.0.0.1/api/${method}`, {
      method: req.method,
      headers: { 'content-type': header(req, 'content-type') ?? 'application/json' },
      body: body && body.length ? body : undefined,
    });

    const response = await apiFetch.fetch(upstream);
    const buffer = Buffer.from(await response.arrayBuffer());
    const headers = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'content-length') headers[key] = value;
    });
    res.writeHead(response.status, { ...headers, 'Content-Length': buffer.length });
    res.end(buffer);
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