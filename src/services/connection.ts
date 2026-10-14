// ⚠️ 必须是 `import type`：`../types` 只有类型、没有任何运行时导出。
// 写成值导入时，打包器（esbuild）会保留这条语句，于是**任何 Node 直跑 `src/` 的
// 回归测试**都会在链接期炸掉 —— `SyntaxError: does not provide an export named`。
// 这正是契约测试长期缺席的结构性原因，见 scripts/ts-resolve-hook.mjs。
import type { LinkState, PendingPrompt, SessionRow, ChatLine } from '../types';
import type { StorageLike } from './device';
import { Envelopes } from './envelopes';
import { DEMO_MODE } from './demo';
import { createAnsweredLedger, type AnsweredLedger } from './store';

export interface HostRequestItem {
  rpcId: string;
  method: string;
  payload: Record<string, unknown>;
  answerable: boolean;
}

// Built-in simulated session storage for local test drive & fallback
const MOCK_SESSIONS: SessionRow[] = [
  {
    sessionId: 'session-project-init-01',
    title: '全栈电商平台架构迁移与重构',
    preview: '已完成数据库索引升级，当前正在执行前端构建与微服务拆分…',
    updatedAt: Date.now() - 1000 * 60 * 12,
    running: false,
    isSubagent: false,
    workspace: '~/Developer/workspaces/nexus-ecommerce',
  },
  {
    sessionId: 'session-deploy-fix-02',
    title: '生产环境网关 502 错误排查与流量切换',
    preview: '分析 Nginx 错误日志与 upstream 超时参数，准备更新配置文件',
    updatedAt: Date.now() - 1000 * 60 * 45,
    running: true,
    isSubagent: false,
    workspace: '/var/www/infrastructure/gateway',
  },
  {
    sessionId: 'session-ai-agent-03',
    title: 'MCP 远程工具与终端自动化测试',
    preview: '终端命令执行完成：pytest tests/test_agent_flow.py (全部通过)',
    updatedAt: Date.now() - 1000 * 3600 * 3,
    running: false,
    isSubagent: false,
    workspace: '~/Projects/dsh-mobile-remote',
  },
  {
    sessionId: 'subagent-trace-internal-99',
    title: 'Subagent: 日志分析与指标收集',
    preview: '后台静默聚合 Prometheus 节点指标',
    updatedAt: Date.now() - 1000 * 3600 * 5,
    running: false,
    isSubagent: true,
    parentSessionId: 'session-deploy-fix-02',
    workspace: '/var/www/infrastructure/gateway',
  },
];

const MOCK_MESSAGES: Record<string, ChatLine[]> = {
  'session-project-init-01': [
    {
      key: 'msg-1',
      role: 'user',
      text: '帮我检查一下 nexus-ecommerce 项目的构建配置，并将数据库连接池大小提升到 50。',
      kind: 'user/message',
    },
    {
      key: 'msg-2',
      role: 'assistant',
      text: '正在连线你的本地工作环境并扫描配置文件…\n\n- [x] 读取 `package.json` 与 `database.config.ts`\n- [x] 验证当前连接池大小与环境变量\n- [ ] 更新连接池最大活跃连接为 50\n- [ ] 运行数据库健康检查与单元测试',
      kind: 'assistant/message',
    },
    {
      key: 'msg-3',
      role: 'assistant',
      text: '调用 read_file · {"path": "config/database.ts"}',
      kind: 'tool/call',
      toolName: 'read_file',
      toolArgs: '{"path": "config/database.ts", "encoding": "utf-8"}',
      toolCallId: 'call_read_db_config',
    },
    {
      key: 'msg-4',
      role: 'assistant',
      text: '{\n  "host": "localhost",\n  "port": 5432,\n  "pool": {\n    "min": 5,\n    "max": 20\n  }\n}',
      kind: 'tool/result',
      toolName: 'read_file',
      toolResult: '{\n  "host": "localhost",\n  "port": 5432,\n  "pool": { "min": 5, "max": 20 }\n}',
      toolCallId: 'call_read_db_config',
    },
    {
      key: 'msg-5',
      role: 'assistant',
      text: '调用 edit_file · {"path": "config/database.ts", "max": 50}',
      kind: 'tool/call',
      toolName: 'edit_file',
      toolArgs: '{"path": "config/database.ts", "changes": [{"line": 6, "replace": "\\"max\\": 50"}]}',
      toolCallId: 'call_edit_db_config',
    },
    {
      key: 'msg-6',
      role: 'assistant',
      text: '文件更新成功：`config/database.ts` (连接池上限已调整为 50)。',
      kind: 'tool/result',
      toolName: 'edit_file',
      toolResult: 'Success: patched 1 file with 1 replacement chunk.',
      toolCallId: 'call_edit_db_config',
    },
    {
      key: 'msg-7',
      role: 'assistant',
      text: '修改已落盘！接下来准备在你的本地机器上启动数据库连接压测。',
      kind: 'assistant/message',
    },
  ],
  'session-deploy-fix-02': [
    {
      key: 'msg-10',
      role: 'user',
      text: '网关上有很多 502 报警，马上查一下错误原因并重启服务。',
      kind: 'user/message',
    },
    {
      key: 'msg-11',
      role: 'assistant',
      text: '收到遥控指令！正在排查服务器日志：\n\n- [x] 查询 Nginx error.log 最新 100 条错误\n- [x] 检查后端 upstream 进程存活状态\n- [ ] 申请安全权限并重启网关进程',
      kind: 'assistant/message',
    },
    {
      key: 'msg-12',
      role: 'assistant',
      text: '调用 run_command · {"command": "tail -n 30 /var/log/nginx/error.log"}',
      kind: 'tool/call',
      toolName: 'run_command',
      toolArgs: '{"command": "tail -n 30 /var/log/nginx/error.log"}',
      toolCallId: 'call_tail_nginx_log',
    },
    {
      key: 'msg-13',
      role: 'assistant',
      text: '2026/10/13 12:40:02 [error] 1420#1420: *49812 connect() to unix:/run/app.sock failed (111: Connection refused) while connecting to upstream',
      kind: 'tool/result',
      toolName: 'run_command',
      toolResult: 'connect() to unix:/run/app.sock failed (111: Connection refused)',
      toolCallId: 'call_tail_nginx_log',
    },
    {
      key: 'msg-14',
      role: 'assistant',
      text: '排查发现是本地应用套接字服务崩溃。正在准备拉起守护进程。',
      kind: 'assistant/message',
    },
  ],
};

export const WS_MUX = '/mobile-gateway/remote.mux';
export const EVENT_STREAM_ENDPOINT = '$events';
export const EVENT_RESULT_ENDPOINT = '$events/result';

// 演示模式开关（定义见 ./demo.ts —— 它被 connection/store/pairing 三处共用）
export { DEMO_MODE } from './demo';

// ─────────────────────────────────────────────────────────────────────────────
// 重连策略（纯函数，可离线测试）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 为什么必须有分流（2026-10-14 实测）
 *
 * 旧实现的 `ws.onclose` 无条件 `setTimeout(connectReal, 3000)`：
 *
 *     token 被吊销 → 网关 rawReject 401/403 → 浏览器只看到 onerror/onclose(1006)
 *                  → 3s 后重连 → 再 401 → 无限循环
 *
 * 表现是「一直转圈、流量白烧、日志刷屏」，而用户得不到任何"该重新配对"的提示。
 * 原生侧（Android 前台服务）已经改成 401 只尝试一次即停，网页端必须同语义。
 *
 * 分流依据有两条：
 *   ① `onclose` 的 code/reason。自定义码（4001/4401/4403）与带鉴权语义的 1008 直接判 auth；
 *      注意**浏览器不会把 WS 握手的 HTTP 状态暴露给 onclose**，所以：
 *   ② 关闭后先用**带令牌的 HTTP 探测**（`probeAuthStatus`）兜底：
 *      同一个网关对同一枚令牌返回 401/403 即证明令牌失效 → 停止重连。
 */
export const BACKOFF_BASE_MS = 1000;

/** 退避上限：30s。 */
export const BACKOFF_MAX_MS = 30_000;

/** 抖动比例：±25%，避免多台客户端同一时刻齐步重连（惊群）。 */
export const BACKOFF_JITTER_RATIO = 0.25;

/** 半开连接看门狗：90s 内没有收到任何帧就强制重连。 */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

/** 鉴权探测请求的超时：探测本身不能卡死重连（网络黑洞时必须能自愈）。 */
export const AUTH_PROBE_TIMEOUT_MS = 5000;

/** 按自定义关闭码判定为鉴权失败（网关/原生壳可能使用这些码）。 */
export const AUTH_CLOSE_CODES: readonly number[] = [4001, 4401, 4403];

export type CloseDisposition = 'auth' | 'retry';

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

/** HTTP 状态码是不是"令牌失效"（需要重新配对，而不是重试）。 */
export function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * 把一次 `onclose` 判定成 `'auth'`（停止重连，通知上层重新配对）或 `'retry'`（退避重连）。
 *
 * 注意：浏览器对 WS 握手 401/403 **只给 1006、不给 HTTP 状态**，
 * 所以 `'retry'` 之后还要用 HTTP 探测兜底（见 `DshConnection`）。
 */
export function classifyClose(code: number, reason: string = ''): CloseDisposition {
  if (isAuthStatus(code)) return 'auth';
  if (AUTH_CLOSE_CODES.includes(code)) return 'auth';
  if (code === 1008 && /401|403|unauthor|forbidden|token|auth|credential|expired/i.test(reason)) {
    return 'auth';
  }
  return 'retry';
}

/**
 * 第 `attempt` 次重连前的等待毫秒数：指数退避 `base * 2^(attempt-1)`，封顶 `maxMs`，
 * 再叠加 ±`jitterRatio` 抖动（抖动后仍被夹到 `[0, maxMs]`）。
 *
 * `attempt` 从 1 开始（第一次失败=1）。注入 `random` 可让测试完全确定：
 * `random: () => 0.5` 得到无抖动阶梯。
 */
export function nextBackoff(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? BACKOFF_BASE_MS;
  const max = options.maxMs ?? BACKOFF_MAX_MS;
  const jitterRatio = options.jitterRatio ?? BACKOFF_JITTER_RATIO;
  const random = options.random ?? Math.random;

  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const raw = Math.min(base * 2 ** (safeAttempt - 1), max);
  const spread = raw * Math.max(0, jitterRatio);
  const value = raw + (random() * 2 - 1) * spread;
  return Math.max(0, Math.min(max, Math.round(value)));
}

/** RPC/探测失败时携带 HTTP 状态，便于上层判定 401/403 而不是只看一句字符串。 */
export class ConnectionError extends Error {
  public readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ConnectionError';
    this.status = status;
  }
}

/** 从任意错误里尽量取出 HTTP 状态（`ConnectionError.status` 优先）。 */
export function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 可注入的运行时依赖（只为可测性；生产环境全部走默认值）
// ─────────────────────────────────────────────────────────────────────────────

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null;
}

export interface ConnectionDeps {
  /** 替换 `new WebSocket(url)`（测试用假 socket）。 */
  WebSocket?: (url: string) => WebSocketLike;
  /** 替换全局 `fetch`（测试用）。 */
  fetch?: typeof fetch;
  /** 去重账本的存储；`null` = 纯内存。 */
  storage?: StorageLike | null;
  /** 替换定时器（测试用假时钟）。 */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** 退避参数覆盖（测试用）。 */
  backoff?: BackoffOptions;
  /** 看门狗超时覆盖；`<= 0` 关闭。 */
  watchdogMs?: number;
  /** 鉴权探测超时覆盖（默认 5s）。 */
  probeTimeoutMs?: number;
}

/** 鉴权失败回调的载荷。 */
export interface AuthFailureInfo {
  status: number;
  message: string;
}

/** 应答失败回调的载荷（`status` 为 null 表示网络层异常）。 */
export interface RespondFailureInfo {
  eventId: string;
  status: number | null;
  message: string;
}

export class DshConnection {
  private baseUrl: string;
  private token: string;
  private instanceName: string;
  private socket: WebSocketLike | null = null;
  private stateListeners: Set<(state: LinkState) => void> = new Set();
  private requestListeners: Set<(req: HostRequestItem) => void> = new Set();
  private authFailureListeners: Set<(info: AuthFailureInfo) => void> = new Set();
  private respondFailureListeners: Set<(info: RespondFailureInfo) => void> = new Set();
  private isStopped = false;
  private attempt = 0;
  private eventClientId: string | null = null;
  /** 已应答（**已落盘**）的 eventId：重启后依然有效，不再弹已处理的审批。 */
  private answered: AnsweredLedger;
  /** 本会话内已投递但尚未确认应答的 eventId：防止同一事件重复弹窗（内存态，故意的）。 */
  private inflightEventIds: Set<string> = new Set();
  private mockSessions: SessionRow[] = [...MOCK_SESSIONS];
  private mockMessages: Record<string, ChatLine[]> = { ...MOCK_MESSAGES };
  private deps: ConnectionDeps;
  private authFailed = false;
  private authFailureStatus: number | null = null;
  private reconnectTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private probeInFlight: Promise<number | null> | null = null;
  /** 最近一次安排的退避毫秒数（诊断用）。 */
  private lastBackoffMs = 0;

  constructor(baseUrl: string, token: string, instanceName = '', deps: ConnectionDeps = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.instanceName = instanceName;
    this.deps = deps;
    this.answered = createAnsweredLedger(deps.storage === undefined ? undefined : deps.storage);
  }

  public onStateChange(listener: (state: LinkState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  public onRequest(listener: (req: HostRequestItem) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  /**
   * 【新增】令牌失效（401/403）时的通知：已**停止**自动重连，需要用户重新配对。
   * 返回取消订阅函数。App.tsx 里用它展示"需重新配对"入口。
   */
  public onAuthFailure(listener: (info: AuthFailureInfo) => void): () => void {
    this.authFailureListeners.add(listener);
    return () => this.authFailureListeners.delete(listener);
  }

  /**
   * 【新增】`respond()` 非 2xx / 网络异常时的可诊断通知（不再静默吞成 false）。
   */
  public onRespondFailure(listener: (info: RespondFailureInfo) => void): () => void {
    this.respondFailureListeners.add(listener);
    return () => this.respondFailureListeners.delete(listener);
  }

  /** 【新增】是否处于"令牌失效、等待重新配对"状态。 */
  public isAuthFailed(): boolean {
    return this.authFailed;
  }

  /**
   * 【新增】重新配对成功后调用：清掉 auth 失败态，之后 `start()` 才会真的连接。
   * （`start()` 在 auth 失败态下**不会**自动重连 —— 否则又回到死循环。）
   */
  public clearAuthFailure(): void {
    this.authFailed = false;
    this.authFailureStatus = null;
  }

  /** 【新增】最近一次退避时长（毫秒），便于上层/日志诊断。 */
  public getLastBackoffMs(): number {
    return this.lastBackoffMs;
  }

  /** 【新增】已应答事件账本（落盘）。可用于调试或"清空免打扰记录"。 */
  public answeredLedger(): AnsweredLedger {
    return this.answered;
  }

  private notifyState(state: LinkState) {
    this.stateListeners.forEach((fn) => fn(state));
  }

  private notifyAuthFailure(info: AuthFailureInfo) {
    this.authFailureListeners.forEach((fn) => fn(info));
  }

  private notifyRespondFailure(info: RespondFailureInfo) {
    this.respondFailureListeners.forEach((fn) => fn(info));
  }

  /**
   * fetch 的实现来源。
   *
   * 🔴 **必须 bind(globalThis)**，否则浏览器里会炸：
   * `Failed to execute 'fetch' on 'Window': Illegal invocation`。
   *
   * 原因：`fetch` 是 `window` 上的方法，调用时 `this` 必须是 `window`。
   * 写成 `return this.deps.fetch ?? fetch;` 之后，调用点变成 `this.fetchImpl(...)`，
   * `this` 就成了 DshConnection —— 浏览器直接拒绝执行。
   *
   * 这个 bug 用"注入假 fetch"的单测**永远抓不到**（假函数不检查接收者），
   * 只有在真机的 WebView 里才会暴露：整条网页 RPC 全废、会话列表恒空、
   * 而原生中继照常工作（所以"审批通知"看起来还是好的）。
   * 回归测试：scripts/test-connection-fetch-binding.mjs（模拟浏览器的接收者检查）。
   */
  private get fetchImpl(): typeof fetch {
    if (this.deps.fetch) return this.deps.fetch;
    return ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch;
  }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.deps.setTimeout) return this.deps.setTimeout(fn, ms);
    return setTimeout(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    if (handle === null || handle === undefined) return;
    if (this.deps.clearTimeout) {
      this.deps.clearTimeout(handle);
      return;
    }
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  private createSocket(url: string): WebSocketLike {
    if (this.deps.WebSocket) return this.deps.WebSocket(url);
    return new WebSocket(url) as unknown as WebSocketLike;
  }

  public start() {
    // 令牌已失效：不得自动重连（要等用户重新配对 → clearAuthFailure()）。
    if (this.authFailed) {
      this.notifyState({ type: 'degraded', reason: '令牌已失效，等待重新配对', attempt: this.attempt });
      this.notifyAuthFailure({
        status: this.authFailureStatus ?? 401,
        message: '令牌已失效，需要重新配对后才能连接',
      });
      return;
    }

    this.isStopped = false;
    this.attempt += 1;
    this.notifyState({ type: 'connecting', attempt: this.attempt });

    // If demo token or local demo host, activate robust simulated mode
    if (DEMO_MODE) {
      setTimeout(() => {
        if (!this.isStopped) {
          this.eventClientId = 'mock-client-' + Math.random().toString(36).slice(2, 8);
          this.notifyState({
            type: 'ready',
            hostName: this.instanceName || 'MacBook Pro (Demo 实例)',
          });
        }
      }, 500);
      return;
    }

    this.connectReal();
  }

  public stop() {
    this.isStopped = true;
    this.clearReconnectTimer();
    this.clearWatchdog();
    if (this.socket) {
      const ws = this.socket;
      this.socket = null;
      // 先摘掉回调：stop() 不该再触发 onclose 的重连判定
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // 关闭失败无妨，引用已丢弃
      }
    }
    this.notifyState({ type: 'disconnected' });
  }

  private clearReconnectTimer() {
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearWatchdog() {
    this.clearTimer(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /** 90s 内没有任何帧 → 判定半开，强制重连（旧实现会让死 socket 一直显示"连着"）。 */
  private armWatchdog() {
    this.clearWatchdog();
    const ms = this.deps.watchdogMs ?? HEARTBEAT_TIMEOUT_MS;
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.watchdogTimer = this.setTimer(() => {
      this.watchdogTimer = null;
      if (this.isStopped || this.authFailed) return;
      this.notifyState({
        type: 'degraded',
        reason: `${Math.round(ms / 1000)}s 未收到任何数据帧，连接可能已半开，强制重连`,
        attempt: this.attempt,
      });
      const ws = this.socket;
      this.socket = null;
      if (ws) {
        ws.onclose = null; // 摘掉回调，避免和下面的 handleClose 重复处理
        try {
          ws.close();
        } catch {
          // 已经死了就算了
        }
      }
      this.handleClose({ code: 1006, reason: 'watchdog-timeout' });
    }, ms);
  }

  private handleClose(ev?: { code?: number; reason?: string }) {
    this.clearWatchdog();
    if (this.isStopped || this.authFailed) return;

    const code = typeof ev?.code === 'number' ? ev.code : 1006;
    const reason = typeof ev?.reason === 'string' ? ev.reason : '';

    if (classifyClose(code, reason) === 'auth') {
      this.enterAuthFailure(code, `网关拒绝连接（关闭码 ${code}），令牌可能已失效，已停止重连`);
      return;
    }

    this.notifyState({
      type: 'degraded',
      reason: '连接已关闭，准备重连…',
      attempt: this.attempt,
    });

    // 浏览器不会把 WS 握手的 401/403 暴露给 onclose → 用带令牌的 HTTP 探测兜底。
    void this.probeAuthThenRetry();
  }

  /**
   * 带令牌探测同一网关的 HTTP 端点：返回状态码；网络异常返回 null。
   * 网关对"缺少令牌"回 401、"令牌未知/吊销"回 403（见 bridge.mjs），
   * 所以这与 mux 握手能否通过是同一个判据。
   */
  private probeAuthStatus(): Promise<number | null> {
    if (this.probeInFlight) return this.probeInFlight;
    const run = (async (): Promise<number | null> => {
      // 探测必须自带超时：网络黑洞下 fetch 可能永远不返回，
      // 那样重连就会被无限期卡住（比"重试死循环"更隐蔽）。
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutMs = this.deps.probeTimeoutMs ?? AUTH_PROBE_TIMEOUT_MS;
      const timeoutHandle =
        controller && timeoutMs > 0
          ? this.setTimer(() => {
              try {
                controller.abort();
              } catch {
                // 已经结束的 signal 再 abort 不致命
              }
            }, timeoutMs)
          : null;
      try {
        const body = Envelopes.clientRequest('probe' + Date.now(), 'session.list', { _request: {} });
        const res = await this.fetchImpl(
          `${this.baseUrl}/mobile-gateway/api/${Envelopes.toEndpoint('session.list')}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.token}`,
            },
            body: JSON.stringify(body),
            signal: controller ? controller.signal : undefined,
          } as RequestInit,
        );
        return res.status;
      } catch {
        // 网络不可达/超时：不是鉴权问题，按网络故障重试
        return null;
      } finally {
        if (timeoutHandle !== null) this.clearTimer(timeoutHandle);
      }
    })();
    this.probeInFlight = run.finally(() => {
      this.probeInFlight = null;
    });
    return this.probeInFlight;
  }

  private async probeAuthThenRetry(): Promise<void> {
    let status: number | null = null;
    try {
      status = await this.probeAuthStatus();
    } catch {
      status = null;
    }
    if (this.isStopped || this.authFailed) return;
    if (status !== null && isAuthStatus(status)) {
      this.enterAuthFailure(status, `令牌已失效（HTTP ${status}），已停止自动重连，需要重新配对`);
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.isStopped || this.authFailed) return;
    this.clearReconnectTimer();
    const delay = nextBackoff(this.attempt, {
      ...(this.deps.backoff ?? {}),
    });
    this.lastBackoffMs = delay;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (this.isStopped || this.authFailed) return;
      this.attempt += 1;
      this.notifyState({ type: 'connecting', attempt: this.attempt });
      this.connectReal();
    }, delay);
  }

  private enterAuthFailure(status: number, message: string) {
    if (this.authFailed) return;
    this.authFailed = true;
    this.authFailureStatus = status;
    this.clearReconnectTimer();
    this.clearWatchdog();
    // 失效态下不该再有任何数据流：把还开着的 socket 也收掉
    // （否则界面已说"需重新配对"，事件却还在往下灌）
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        // 已经断了就算了
      }
    }
    this.notifyState({ type: 'degraded', reason: message, attempt: this.attempt });
    this.notifyAuthFailure({ status, message });
  }

  private connectReal() {
    if (this.authFailed) return;
    try {
      const wsBase = this.baseUrl.replace(/^http/, 'ws') + WS_MUX;
      // 🔴 令牌必须走 **query 参数**，不能指望请求头（2026-10-14 修复）
      //
      // 浏览器的 `new WebSocket(url)` **不支持自定义请求头** —— 这是 Web 规范限制，
      // 不是实现疏漏。所以 `Authorization: Bearer` 在渲染进程里**根本发不出去**。
      //
      // 原来的写法是 `new WebSocket(wsUrl)`，既无头也无 query →
      // 网关 `handleUpgrade` 拿不到令牌 → 直接 **401 拒绝**，
      // 结果是**事件流永远连不上**（而后面的 `session.list` 探测又是走 fetch 带头的，
      // 所以会看到「HTTP 能通、事件流不通」这种很迷惑的现象）。
      //
      // 网关的 `readToken()` 支持两种来源：`Authorization` 头 **或** `?token=` 查询参数
      // （见 packages/dsh-mobile-gateway/lib/bridge.mjs）。渲染进程只能用后者。
      //
      // ⚠️ 已知代价：30 天有效的**完全控制凭据会进 URL** —— 会落到反代/隧道访问日志
      // （本项目的公网链路是 Caddy + FRP）、以及 devtools 记录里。
      // 正确的长期做法是**把连接放到 Electron 主进程**（Node 侧 WebSocket 可以带头），
      // 渲染进程经 IPC 订阅事件 —— 见 docs/design.md §2.4.1。
      const ws = this.createSocket(`${wsBase}?token=${encodeURIComponent(this.token)}`);
      this.socket = ws;

      ws.onopen = () => {
        if (this.isStopped || this.authFailed) {
          ws.onclose = null;
          ws.close();
          return;
        }
        this.armWatchdog();
        // Send open frame for $events stream
        const openFrame = {
          type: 'open',
          streamId: 'stream-' + Date.now(),
          endpoint: EVENT_STREAM_ENDPOINT,
          payload: { args: {} },
        };
        ws.send(JSON.stringify(openFrame));

        // Test probe with session.list
        this.call('session.list', { _request: {} })
          .then(() => {
            if (this.isStopped) return;
            // 连接成功 → 重置退避/尝试计数
            this.attempt = 0;
            this.notifyState({
              type: 'ready',
              hostName: this.instanceName || this.baseUrl,
            });
          })
          .catch((err: unknown) => {
            if (this.isStopped) return;
            const status = errorStatus(err);
            if (status !== null && isAuthStatus(status)) {
              // fetch 侧的 401/403 与 mux 握手是同一判据：立即停止重连
              this.enterAuthFailure(status, `令牌已失效（HTTP ${status}），已停止自动重连，需要重新配对`);
              return;
            }
            const message = (err as Error)?.message || '未知错误';
            this.notifyState({
              type: 'degraded',
              reason: '主机未响应 session.list: ' + message,
              attempt: this.attempt,
            });
          });
      };

      ws.onmessage = (event) => {
        // 收到任何帧都算"活着"：重置半开看门狗
        this.armWatchdog();
        try {
          // `String(...)` 是类型收敛：DOM 的 MessageEvent.data 在不同 lib 配置下
          // 可能是 unknown（T3 交付时未跑 tsc，这里由 Lead 集成时修正）。
          const frame = JSON.parse(String(event.data));
          if (frame.type === 'item' && frame.value) {
            this.handleStreamItem(frame.value);
          } else if (frame.type === 'end' || frame.type === 'error') {
            this.notifyState({
              type: 'degraded',
              reason: frame.error?.message || '事件流被关闭',
              attempt: this.attempt,
            });
          }
        } catch (e) {
          console.warn('Failed to parse frame', e);
        }
      };

      ws.onerror = () => {
        this.notifyState({
          type: 'degraded',
          reason: 'WebSocket 连接异常',
          attempt: this.attempt,
        });
      };

      ws.onclose = (ev?: { code?: number; reason?: string }) => {
        this.handleClose(ev);
      };
    } catch (e: unknown) {
      const err = e as Error;
      this.notifyState({
        type: 'degraded',
        reason: '无法创建网络连接: ' + (err?.message || '网络不可达'),
        attempt: this.attempt,
      });
      // 创建失败（网络不可达）也走退避重连，而不是干等
      void this.probeAuthThenRetry();
    }
  }

  private handleStreamItem(value: Record<string, unknown>) {
    if (value.type === 'ready') {
      const val = value;
      this.eventClientId = String(val.clientId);
    } else if (value.type === 'emit') {
      const eventName = String(value.event || '');
      this.requestListeners.forEach((fn) =>
        fn({
          rpcId: eventName,
          method: eventName,
          payload: value,
          answerable: false,
        }),
      );
    } else if (value.type === 'waterfall') {
      const eventName = String(value.event || '');
      const eventId = String(value.eventId || '');
      if (!eventId) return;
      // 已应答（**落盘**，重启后依然有效）→ 绝不再弹
      if (this.answered.has(eventId)) return;
      // 本次会话内已经投递过、还没确认 → 不重复弹
      if (this.inflightEventIds.has(eventId)) return;
      this.inflightEventIds.add(eventId);

      this.requestListeners.forEach((fn) =>
        fn({
          rpcId: eventId,
          method: eventName,
          payload: (value.request as Record<string, unknown>) || value,
          answerable: true,
        }),
      );
    }
  }

  public async call(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // If running in demo mode or offline simulated fallback
    if (DEMO_MODE) {
      return this.handleMockCall(method, args);
    }

    const rpcId = 'r' + Math.random().toString(36).slice(2, 9);
    const endpoint = Envelopes.toEndpoint(method);
    const body = Envelopes.clientRequest(rpcId, method, args);

    const res = await this.fetchImpl(`${this.baseUrl}/mobile-gateway/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // 带上状态码：401/403 是"要重新配对"，不是"网络抖动"（上层据此分流）
      throw new ConnectionError(`RPC 失败: HTTP ${res.status}`, res.status);
    }

    const json = await res.json();
    if (json.result?.ok) {
      return json.result.value;
    } else {
      throw new ConnectionError(json.result?.error?.message || `${method} 返回了错误`);
    }
  }

  /**
   * 应答一次审批/提问。
   *
   * **签名不变**（`Promise<boolean>`），但不再静默吞错：
   * 非 2xx / 网络异常会通过 `onRespondFailure` 通知（含 eventId 与 HTTP 状态），
   * 并且**只有成功才写入落盘账本** —— 失败的事件保持"可再次处理"，
   * 不会因为一次失败的应答而永久吞掉用户的审批。
   */
  public async respond(eventId: string, outcome: Record<string, unknown>): Promise<boolean> {
    if (DEMO_MODE) {
      this.answered.remember(eventId);
      this.inflightEventIds.delete(eventId);
      return true;
    }
    const clientId = this.eventClientId;
    if (!clientId) {
      const message = '事件流尚未就绪（缺少 clientId），应答未发出';
      this.inflightEventIds.delete(eventId);
      this.notifyRespondFailure({ eventId, status: null, message });
      return false;
    }

    try {
      const rpcId = 'r' + Math.random().toString(36).slice(2, 9);
      const body = Envelopes.clientRequest(rpcId, '$events/result', {
        clientId,
        eventId,
        outcome,
      });

      const res = await this.fetchImpl(`${this.baseUrl}/mobile-gateway/api/${EVENT_RESULT_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // 失败 → 不落盘，允许再次处理
        this.inflightEventIds.delete(eventId);
        this.notifyRespondFailure({
          eventId,
          status: res.status,
          message: `应答未被接受: HTTP ${res.status}`,
        });
        return false;
      }

      // ⚠️ 顺序很重要：**成功之后**才落盘去重账本（App 重启后不再重复弹）
      this.answered.remember(eventId);
      this.inflightEventIds.delete(eventId);
      return true;
    } catch (err: unknown) {
      this.inflightEventIds.delete(eventId);
      this.notifyRespondFailure({
        eventId,
        status: errorStatus(err),
        message: `应答失败: ${(err as Error)?.message || '网络异常'}`,
      });
      return false;
    }
  }

  // --- Mock Engine for instant interactive testing ---
  private handleMockCall(method: string, args: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const norm = method.replace(/\//g, '.');

        if (norm === 'session.list') {
          resolve({
            items: this.mockSessions.map((s) => ({
              sessionId: s.sessionId,
              origin: s.isSubagent ? 'subagent' : 'user',
              parentSessionId: s.parentSessionId || null,
              running: s.running,
              updatedAt: s.updatedAt,
              cwd: s.workspace,
              projections: {
                values: {
                  title: s.title,
                  preview: s.preview,
                  cwd: s.workspace,
                },
              },
            })),
          });
        } else if (norm === 'session.search') {
          const req = (args.request || {}) as { query?: string };
          const q = (req.query || '').toLowerCase();
          const filtered = this.mockSessions.filter(
            (s) => s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q),
          );
          resolve({
            items: filtered.map((s) => ({
              sessionId: s.sessionId,
              title: s.title,
              snippet: s.preview,
              updatedAt: s.updatedAt,
            })),
          });
        } else if (norm === 'session.create') {
          const req = (args.request || {}) as { cwd?: string };
          const newId = 'session-' + Date.now();
          const newSession: SessionRow = {
            sessionId: newId,
            title: '新建遥控会话 #' + this.mockSessions.length,
            preview: '等待下发遥控指令…',
            updatedAt: Date.now(),
            running: false,
            isSubagent: false,
            workspace: req.cwd || '~/Developer/workspaces/app',
          };
          this.mockSessions.unshift(newSession);
          this.mockMessages[newId] = [
            {
              key: 'init-' + Date.now(),
              role: 'assistant',
              text: '电脑端 AI 遥控就绪 ⚡\n\n已绑定工作区：`' + (newSession.workspace || '~') + '`\n你可以发送文字，或按住右下角麦克风语音遥控。',
              kind: 'assistant/message',
            },
          ];
          resolve({ sessionId: newId });
        } else if (norm === 'session.page') {
          const req = (args.request || {}) as {
            address?: { sessionId?: string };
            throughSeq?: number;
            maxMessages?: number;
          };
          const sid = req.address?.sessionId || '';
          const msgs = this.mockMessages[sid] || [];
          resolve({
            records: msgs.map((m, idx) => ({
              type: 'event',
              seq: idx + 1,
              event: {
                type: m.kind,
                seq: idx + 1,
                time: Date.now(),
                data: {
                  name: m.toolName,
                  callId: m.toolCallId,
                  arguments: m.toolArgs,
                  result: m.toolResult,
                  isError: m.isError,
                  message: {
                    content: [{ type: 'text', text: m.text }],
                  },
                },
              },
            })),
          });
        } else if (norm === 'session.prompt') {
          const req = (args.request || {}) as {
            sessionId?: string;
            content?: Array<{ type: string; text?: string }>;
          };
          const sid = req.sessionId || '';
          const text = req.content?.[0]?.text || '';
          const list = this.mockMessages[sid] || [];

          // Add user message
          list.push({
            key: 'user-' + Date.now(),
            role: 'user',
            text,
            kind: 'user/message',
          });

          // Simulate agent execution steps & tool card
          setTimeout(() => {
            list.push({
              key: 'tool-call-' + Date.now(),
              role: 'assistant',
              text: `执行终端命令 · {"command": "npm test"}`,
              kind: 'tool/call',
              toolName: 'run_command',
              toolArgs: '{"command": "npm test", "cwd": "' + (this.mockSessions.find((s) => s.sessionId === sid)?.workspace || '~') + '"}',
              toolCallId: 'call_test_' + Date.now(),
            });

            setTimeout(() => {
              list.push({
                key: 'tool-res-' + Date.now(),
                role: 'assistant',
                text: 'PASS src/index.test.ts (4 passed, 4 total)\nTest Suites: 1 passed, 1 total\nSnapshots:   0 total\nTime:        1.42s',
                kind: 'tool/result',
                toolName: 'run_command',
                toolResult: 'PASS src/index.test.ts (4 passed, 4 total)',
                toolCallId: 'call_test_' + Date.now(),
              });

              list.push({
                key: 'assistant-reply-' + Date.now(),
                role: 'assistant',
                text: `指令 **"${text}"** 已在远程电脑执行完毕！\n\n- [x] 解析移动端语音/文字遥控意图\n- [x] 调用桌面本地环境执行命令\n- [x] 单元测试执行并通过 (4/4)\n\n电脑状态平稳，工作区无未提交的脏变更。`,
                kind: 'assistant/message',
              });

              // Update session preview
              const session = this.mockSessions.find((s) => s.sessionId === sid);
              if (session) {
                session.preview = text;
                session.updatedAt = Date.now();
                session.running = false;
              }
            }, 800);
          }, 600);

          resolve({ ok: true });
        } else if (norm === 'session.cancel') {
          const req = (args.request || {}) as { sessionId?: string };
          const sid = req.sessionId || '';
          const session = this.mockSessions.find((s) => s.sessionId === sid);
          if (session) session.running = false;
          resolve({ ok: true });
        } else {
          resolve({ ok: true });
        }
      }, 150);
    });
  }

  // Trigger interactive approval or question for testing
  public triggerSimulatedPrompt(pending: PendingPrompt) {
    this.requestListeners.forEach((fn) =>
      fn({
        rpcId: pending.rpcId,
        method: pending.method,
        payload: {
          questions: pending.questionId
            ? [
                {
                  id: pending.questionId,
                  header: pending.title,
                  question: pending.body,
                  options: pending.options.map((opt) => ({ label: opt })),
                },
              ]
            : undefined,
          displayReason: pending.body,
          toolName: 'execute_sensitive_shell_script',
        },
        answerable: true,
      }),
    );
  }
}
