/**
 * @file lib/bridge.mjs
 * @description 协议透明的 `/api` 桥：把 DSH 官方 RPC 与**唯一的 mux 事件流**，
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
 *   WS   /mobile-gateway/remote.mux        →  mux 帧协议；每条逻辑流映射成一次
 *                                             typertGateway.wireStream.open(endpoint, …)
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
              // 只保留列表页真正用到的。
              //
              // 🔴 `origin` / `parentSessionId` **必须留**（2026-10-13 公网实测）：
              // 真实主机把**子代理会话**也列在 session/list 里，靠这两个字段区分。
              // 68 个会话里 53 个是子代理，而子代理会话**不能用裸 sessionId 打开**
              // （主机回 `subagent Sessions require their durable parent address`）。
              // 早前这里把顶层字段整体丢弃，App 拿不到判据，只能把它们混在主列表里，
              // 用户点进去全是错误页。`blank`/`cwd` 供将来做空态与工作区显示。
              item.projections.values = {
                title: vals.title,
                sessionListMetadata: vals.sessionListMetadata,
              };
              item.projections.asOfSeq = undefined;
            }
            // 顶层字段 `origin` / `parentSessionId` / `blank` / `agentAvailable` / `cwd`
            // **原样保留**（上面只动了 projections.values，顶层没碰）。
            //
            // 🔴 这不是可有可无的：`origin`/`parentSessionId` 决定「这一行能不能点开」。
            // 真实主机把**子代理会话**也列在 session/list 里，靠这两个字段区分；
            // 68 个会话里 53 个是子代理，而子代理会话不能用裸 sessionId 打开
            // （主机回 `subagent Sessions require their durable parent address`）。
            // 早前若有谁顺手把顶层也白名单化，App 就会拿不到判据、把它们混进主列表，
            // 用户点进去全是错误页。
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

  // ---- WebSocket: 单一 mux（真实主机只有一条 WS）-------------------------
  //
  // 🔴 2026-10-13 公网实测 + app.asar 权威源码取证：
  //
  // 真实主机**只有一条** mux WebSocket，常量取自
  // `@deepseek-ai/dsh-api-gateway/src/stream-protocol.ts`：
  //
  //     export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'
  //
  // 而 `/api/events.mux` / `/api/events.host` 在真实源码里**零出现**。
  // 原来的实现注册两条 WS、各自把整个 socket 绑到一个 endpoint，主机侧直接抛
  // `invalid Remote endpoint "/api/events.host"`（endpoint 校验要求 split('/')
  // 恰好 2 段，`/api/events.host` 有 3 段）。实测两条流都在 attach 后立刻断开，
  // 日志里只有 `device attached to event stream` + `event stream ended`。
  //
  // 真实协议是**一条 WS 承载多条逻辑流**，帧形状（stream-protocol.ts 逐字）：
  //
  //   客户端 → 主机： { type:'open',   streamId, endpoint, payload }
  //                   { type:'item',   streamId, value? }
  //                   { type:'end',    streamId }
  //                   { type:'cancel', streamId }
  //   主机 → 客户端： { type:'item',  streamId, value? }
  //                   { type:'end',   streamId }
  //                   { type:'error', streamId, error:{code,message,details} }
  //
  // `open` 必须**精确**这 4 个键（权威实现用 exactKeys 校验）；`streamId`
  // 非空字符串；重复 streamId 的 open 会关 socket（1008）；二进制帧回 1003。
  //
  // 事件流用**内部 endpoint `$events`**，payload 必须是 `{args:{}}`：
  //     REMOTE_EVENT_STREAM_ENDPOINT = '$events'
  //     REMOTE_EVENT_STREAM_PAYLOAD  = { args: {} }
  // 主机在该逻辑流上回 `ready` / `emit` / `waterfall` / `cancel` 四种 item。

  /** 事件流的内部 endpoint（真实主机侧常量，不是我们编的）。 */
  const EVENT_STREAM_ENDPOINT = '$events';

  /**
   * 一条逻辑流的有界上行队列。
   *
   * 复刻权威实现 `stream-server.ts` 的 UplinkInbox 语义（简化版）：
   * 单消费者、`end` 之后不允许再 `item`、容量超限即失败。
   * 事件流是**只下行**的，这个队列永远读不到东西，但形状必须正确 ——
   * `wireStream.open()` 会把它当作方法读取的 uplink。
   */
  class UplinkInbox {
    #queue = [];
    #bytes = 0;
    #ended = false;
    #closed = false;
    #taken = false;
    #failure;
    #wake;
    #maxBytes;
    #onViolation;

    constructor(maxBytes, onViolation) {
      this.#maxBytes = maxBytes;
      this.#onViolation = onViolation;
    }

    push(value, frameBytes) {
      if (this.#failure !== undefined || this.#closed) return;
      if (this.#ended) {
        this.#violate(new Error('api gateway: Remote stream uplink item after end'));
        return;
      }
      if (this.#bytes + frameBytes > this.#maxBytes) {
        this.#violate(new Error(`api gateway: Remote stream uplink exceeded ${this.#maxBytes} buffered bytes`));
        return;
      }
      this.#queue.push({ value, bytes: frameBytes });
      this.#bytes += frameBytes;
      this.#signal();
    }

    end() {
      if (this.#ended) return;
      this.#ended = true;
      this.#signal();
    }

    fail(error) {
      if (this.#failure !== undefined) return;
      this.#failure = error;
      this.#queue = [];
      this.#bytes = 0;
      this.#signal();
    }

    [Symbol.asyncIterator]() {
      if (this.#taken) throw new Error('api gateway: Remote stream uplink inbox already has a consumer');
      this.#taken = true;
      return this;
    }

    async next() {
      for (;;) {
        if (this.#closed) return { value: undefined, done: true };
        const entry = this.#queue.shift();
        if (entry !== undefined) {
          this.#bytes -= entry.bytes;
          return { value: entry.value, done: false };
        }
        if (this.#failure !== undefined) throw this.#failure;
        if (this.#ended) return { value: undefined, done: true };
        await new Promise((resolve) => { this.#wake = resolve; });
      }
    }

    return() {
      this.#closed = true;
      this.#queue = [];
      this.#bytes = 0;
      this.#signal();
      return Promise.resolve({ value: undefined, done: true });
    }

    #violate(error) {
      this.fail(error);
      this.#onViolation(error);
    }

    #signal() {
      const wake = this.#wake;
      this.#wake = undefined;
      wake?.();
    }
  }

  wss.on('connection', (socket, req, device) => {
    /** streamId → { abort, inbox, done } */
    const streams = new Map();
    /** 串行化写入，避免同一 socket 上并发 send 交错。 */
    let writes = Promise.resolve();

    function send(frame) {
      const delivery = writes.then(
        () =>
          new Promise((resolve, reject) => {
            if (socket.readyState !== socket.OPEN) {
              reject(new Error('api gateway: Remote stream socket is closed'));
              return;
            }
            socket.send(JSON.stringify(frame), (error) => (error ? reject(error) : resolve()));
          }),
      );
      writes = delivery.catch(() => undefined);
      return delivery;
    }

    async function sendFailure(streamId, error) {
      if (socket.readyState !== socket.OPEN) return;
      const detail = error?.details;
      await send({
        type: 'error',
        streamId,
        error: {
          code: String(error?.code ?? 'gateway/internal'),
          message: String(error?.message ?? error),
          details: detail && typeof detail === 'object' ? detail : {},
        },
      }).catch(() => {
        socket.close(1011, 'Remote stream failure could not be delivered');
      });
    }

    /**
     * 跑一条逻辑流：open → 逐项 item → end，失败则 error。
     *
     * ⚠️ 结束顺序与权威实现一致：先把 uplink 失败掉（后续上行帧不能再改变结果），
     * 再判断是「被 abort（取消）」还是「正常/异常结束」。
     */
    async function pump(streamId, endpoint, payload, active) {
      let outcome;
      try {
        const source = await typert.wireStream.open(endpoint, payload, active.inbox, peer, active.abort.signal);
        for await (const value of source) {
          if (socket.readyState !== socket.OPEN) break;
          await send({ type: 'item', streamId, value });
        }
        outcome = { failed: false };
      } catch (error) {
        outcome = { failed: true, error };
      }
      active.inbox.fail(new Error('Remote stream ended'));
      if (active.abort.signal.aborted) {
        // 取消：客户端主动 cancel 或 socket 关闭，不需要再发终止帧。
        return;
      }
      if (outcome.failed) {
        log.warn('remote stream failed', { endpoint, error: String(outcome.error?.message ?? outcome.error) });
        await sendFailure(streamId, outcome.error);
        return;
      }
      await send({ type: 'end', streamId }).catch(() => undefined);
    }

    function openStream(message) {
      const { streamId, endpoint, payload } = message;
      if (streams.has(streamId)) {
        // 权威语义：重复 streamId 的 open 是唯一会关 socket 的协议违规。
        socket.close(1008, 'duplicate Remote stream id');
        return;
      }
      const abort = new AbortController();
      const inbox = new UplinkInbox(MAX_BODY_BYTES, (error) => abort.abort(error));
      const active = { abort, inbox, done: Promise.resolve() };
      streams.set(streamId, active);
      const done = pump(streamId, endpoint, payload, active);
      active.done = done;
      const remove = () => streams.delete(streamId);
      void done.then(remove, remove);
    }

    function receive(text) {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        socket.close(1008, 'invalid Remote stream request');
        return;
      }
      if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        socket.close(1008, 'invalid Remote stream request');
        return;
      }
      const { type, streamId } = message;
      const validId = typeof streamId === 'string' && streamId.length > 0;

      if (type === 'open') {
        // 精确 4 键 + 非空 endpoint（权威 exactKeys 语义）。
        const keys = Object.keys(message);
        const exact = keys.length === 4
          && keys.includes('type') && keys.includes('streamId')
          && keys.includes('endpoint') && keys.includes('payload');
        if (!exact || !validId || typeof message.endpoint !== 'string' || message.endpoint.length === 0) {
          socket.close(1008, 'invalid Remote stream request');
          return;
        }
        openStream(message);
        return;
      }

      if (type === 'item' || type === 'end' || type === 'cancel') {
        if (!validId) {
          socket.close(1008, 'invalid Remote stream request');
          return;
        }
        // 未知 streamId **静默丢弃**：已结束的流会先离开表，而在途帧还在到。
        const active = streams.get(streamId);
        if (active === undefined) return;
        if (type === 'item') {
          active.inbox.push(message.value, Buffer.byteLength(text, 'utf8'));
        } else if (type === 'end') {
          active.inbox.end();
        } else {
          active.abort.abort(new Error('Remote stream cancelled'));
          active.inbox.fail(new Error('Remote stream cancelled'));
        }
        return;
      }

      socket.close(1008, 'invalid Remote stream request');
    }

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text messages required');
        return;
      }
      receive(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    });

    socket.on('close', () => {
      for (const active of streams.values()) {
        active.abort.abort(new Error('Remote stream socket closed'));
        active.inbox.fail(new Error('Remote stream socket closed'));
      }
      streams.clear();
    });
    socket.on('error', (error) => {
      log.warn('remote mux socket error', { error: String(error), deviceId: device.id });
      socket.terminate();
    });

    log.info('device attached to remote mux', { deviceId: device.id });
  });

  function handleUpgrade(req, socket, head) {
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
      wss.emit('connection', ws, req, device);
    });
  }

  return {
    handleApi,
    handleMuxUpgrade: handleUpgrade,
    EVENT_STREAM_ENDPOINT,
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