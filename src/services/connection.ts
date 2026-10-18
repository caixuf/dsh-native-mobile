// ⚠️ 必须是 `import type`：`../types` 只有类型、没有任何运行时导出。
// 写成值导入时，打包器（esbuild）会保留这条语句，于是**任何 Node 直跑 `src/` 的
// 回归测试**都会在链接期炸掉 —— `SyntaxError: does not provide an export named`。
// 这正是契约测试长期缺席的结构性原因，见 scripts/ts-resolve-hook.mjs。
import type { LinkState, PendingPrompt, SessionRow, ChatLine } from '../types';
import type { StorageLike } from './device';
import { Envelopes } from './envelopes';
import { DEMO_MODE } from './demo';
import {
  createAnsweredLedger,
  createOutboxQueue,
  type AnsweredLedger,
  type OutboxItem,
  type OutboxQueue,
} from './store';

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

export function isLanAddress(url: string): boolean {
  if (!url) return false;
  try {
    const raw = url.trim().replace(/^wss?:\/\//i, 'http://').replace(/^https?:\/\//i, 'http://');
    const parsed = new URL(raw.startsWith('http://') ? raw : `http://${raw}`);
    const host = parsed.hostname.toLowerCase();
    const cleanHost = host.replace(/^\[|\]$/g, '');
    if (cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === '::1' || cleanHost === '0.0.0.0') return true;
    if (host.startsWith('192.168.')) return true;
    if (host.startsWith('10.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (host.endsWith('.local') || host.endsWith('.lan')) return true;
    return false;
  } catch {
    return false;
  }
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
  /** 【新增】离线待发队列的存储覆盖；缺省沿用 `storage`。 */
  outboxStorage?: StorageLike | null;
  /** 【新增】离线待发队列容量覆盖。 */
  outboxCapacity?: number;
  /** 【新增】离线待发单项尝试上限覆盖。 */
  outboxMaxAttempts?: number;
  /** 【新增】注入时钟（测试确定性）。 */
  now?: () => number;
  /** 【新增】局域网候选地址列表（支持多个 candidate） */
  lanUrls?: string[];
  /** 【新增】用户指定的首选局域网地址 */
  preferredLanUrl?: string;
  /** 【新增】连接策略：auto (默认，优先局域网) | lan (仅局域网) | wan (仅公网服务器) */
  connectionMode?: 'auto' | 'lan' | 'wan';
  /** 【新增】当实际连接地址切换时通知（例如从公网无缝切换至局域网） */
  onActiveUrlChange?: (activeUrl: string, isLan: boolean) => void;
  /** 【新增】RPC 调用超时（毫秒），默认 15_000ms */
  callTimeoutMs?: number;
  /** 【新增】应答超时（毫秒），默认 10_000ms */
  respondTimeoutMs?: number;
  /** 【新增】局域网探测超时（毫秒），默认 1500ms（局域网通常 10-50ms 内响应） */
  lanProbeTimeoutMs?: number;
  /** 【新增】后台周期性探测局域网间隔（毫秒），默认 25_000ms */
  lanDiscoveryIntervalMs?: number;
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

// ─────────────────────────────────────────────────────────────────────────────
// 【新增】弱网/离线：连接阶段 + 落盘待发队列（outbox）
//
// 注意：这里**不**改 `types/index.ts` 的 `LinkState` 联合类型（`LinkStateType`）。
// 那个类型被多处组件消费，加一个成员会连锁破坏它们的穷尽分支。
// 于是新增一个**独立的只读视图** `LinkPhase`，由 `getLinkPhase()` / `onPhaseChange()`
// 暴露；已有 `onStateChange` 回调原样保留。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 粗粒度的连接阶段（给 UI 用）：
 *   - `'online'`      已握手且 `session.list` 验证通过 → 可以直发；
 *   - `'connecting'`  正在握手/验证（有 socket 在飞）；
 *   - `'offline'`     没有可用连接（含退避等待中、已 stop）；
 *   - `'auth-failed'` 令牌失效，**必须重新配对**，重试无意义。
 */
export type LinkPhase = 'online' | 'connecting' | 'offline' | 'auth-failed';

/** 待发队列快照（订阅 `onOutboxChange` 收到的东西）。 */
export interface OutboxSnapshot {
  /** 待发（含正在发送、不含失败）条数。 */
  pending: number;
  /** 已达尝试上限、等用户处理的条数。 */
  failed: number;
  total: number;
  /** 队首待发项（UI 可显示"正在等它送达"）。 */
  head: OutboxItem | null;
  /** 单项尝试上限（与队列配置一致）。 */
  maxAttempts: number;
}

/** `sendOrQueue()` 的结论。 */
export type SendResultReason =
  | 'sent'
  | 'queued-offline'
  | 'queued-network-error'
  | 'auth-failed'
  | 'invalid';

export interface SendResult {
  /** true = 主机已接收。 */
  delivered: boolean;
  /** true = 已落盘进待发队列，重连后自动发。 */
  queued: boolean;
  reason: SendResultReason;
  /** 入队项的 id（`queued` 时有值）。 */
  itemId?: string;
  /** 拒绝/失败原因（`invalid` / `auth-failed` / `queued-network-error` 时有值）。 */
  error?: string;
}

/** `flushOutbox()` 的结果（诊断用）。 */
export interface FlushOutboxResult {
  attempted: number;
  delivered: number;
  /** 本轮内达到尝试上限、被标为 failed 的条数。 */
  failed: number;
  /** true = 因 auth 失败 / stop() / 传输仍未恢复而提前结束。 */
  stopped: boolean;
}

export interface SendOptions {
  /** 显式指定入队 id（幂等去重用；不传则自动生成）。 */
  id?: string;
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
  /** 【新增】连接阶段订阅者（`getLinkPhase` 的推送面）。 */
  private phaseListeners: Set<(phase: LinkPhase) => void> = new Set();
  /** 【新增】待发队列订阅者。 */
  private outboxListeners: Set<(snapshot: OutboxSnapshot) => void> = new Set();

  /**
   * 按 `streamId` 路由的**子流**订阅者。
   *
   * 🔴 只有 `$events` 一条流时，App 是"盲"的：真主机实测（2026-10-15）
   * `$events` 只推 `api-session/status` / `api-session/activity` 这类粗粒度 emit，
   * **不含任何内容事件** —— 所以界面上只有"执行中"然后忽然出结果。
   * 会话的逐事件进度在 `session/follow` 这条**按会话的流**上。
   */
  private streamSubscribers: Map<
    string,
    {
      onItem?: (value: Record<string, unknown>) => void;
      onEnd?: () => void;
      onError?: (error: { message?: string }) => void;
    }
  > = new Map();
  /** 【新增】当前连接阶段（初值 offline）。 */
  private phase: LinkPhase = 'offline';
  private isStopped = false;
  private attempt = 0;
  /**
   * 【新增】握手去重标志：socket 已创建但还没 onopen/onclose。
   * 没有它时 `start()` / 退避定时器 / `retryNow()` 同时触发会堆出多条握手
   * （弱网下旧连接迟迟不关，页面会积累一排半死不活的 socket）。
   */
  private connecting = false;
  /** 【新增】当前 socket 已经 onopen（活着）。 */
  private socketAlive = false;
  private eventClientId: string | null = null;
  /** 已应答（**已落盘**）的 eventId：重启后依然有效，不再弹已处理的审批。 */
  private answered: AnsweredLedger;
  /** 【新增】落盘的离线待发队列（断线时用户指令不丢）。 */
  private outbox: OutboxQueue;
  /** 【新增】待发项 id 的自增序号（同一毫秒内不撞 id）。 */
  private outboxSeq = 0;
  /** 【新增】同一时刻只允许一轮 flush（防止重连瞬间并发轰炸主机）。 */
  private flushInFlight: Promise<FlushOutboxResult> | null = null;
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
  /** 【新增】实际正在通信的端点（局域网地址优先，断线时无缝回退到公网服务器）。 */
  private effectiveBaseUrl: string;
  /** 【新增】当前是否走局域网高速通道。 */
  private isLan = false;
  /** 【新增】候选局域网地址列表。 */
  private lanCandidates: string[] = [];
  /** 【新增】用户指定的局域网优选地址。 */
  private preferredLanUrl?: string;
  /** 【新增】连接策略（auto=局域网优先，自动回退 | lan=仅局域网 | wan=仅公网服务器）。 */
  private connectionMode: 'auto' | 'lan' | 'wan' = 'auto';
  /** 【新增】测得的网络延迟（毫秒）。 */
  private pingMs: number | null = null;
  /** 【新增】后台局域网自动发现定时器。 */
  private lanDiscoveryTimer: unknown = null;
  /** 【新增】正在执行的局域网探测。 */
  private lanProbeInFlight: Promise<boolean> | null = null;
  /** 【新增】网络恢复监听器清理函数。 */
  private onlineCleanup: (() => void) | null = null;

  constructor(baseUrl: string, token: string, instanceName = '', deps: ConnectionDeps = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.instanceName = instanceName;
    this.deps = deps;
    this.answered = createAnsweredLedger(deps.storage === undefined ? undefined : deps.storage);
    // 待发队列与去重账本共用同一份注入存储（键不同），但允许单独覆盖。
    const outboxStorage =
      deps.outboxStorage !== undefined
        ? deps.outboxStorage
        : deps.storage === undefined
          ? undefined
          : deps.storage;
    this.outbox = createOutboxQueue(outboxStorage, deps.outboxCapacity, deps.outboxMaxAttempts);

    this.connectionMode = deps.connectionMode ?? 'auto';
    this.preferredLanUrl = deps.preferredLanUrl ? deps.preferredLanUrl.replace(/\/+$/, '') : undefined;
    const candidates = new Set<string>();
    if (this.preferredLanUrl) candidates.add(this.preferredLanUrl);
    for (const u of deps.lanUrls ?? []) {
      if (u) candidates.add(u.replace(/\/+$/, ''));
    }
    if (isLanAddress(this.baseUrl)) {
      candidates.add(this.baseUrl);
    }
    this.lanCandidates = Array.from(candidates);

    if (this.connectionMode !== 'wan' && this.preferredLanUrl) {
      this.effectiveBaseUrl = this.preferredLanUrl;
      this.isLan = true;
    } else {
      this.effectiveBaseUrl = this.baseUrl;
      this.isLan = isLanAddress(this.baseUrl);
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const handleOnline = () => {
        if (this.isStopped || this.authFailed) return;
        this.retryNow();
      };
      window.addEventListener('online', handleOnline);
      this.onlineCleanup = () => window.removeEventListener('online', handleOnline);
    }
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
    // 回到"未连接"：等 start()（或 retryNow()）真正建链后才会变 connecting
    this.setPhase('offline');
  }

  /** 【新增】最近一次退避时长（毫秒），便于上层/日志诊断。 */
  public getLastBackoffMs(): number {
    return this.lastBackoffMs;
  }

  /** 【新增】已应答事件账本（落盘）。可用于调试或"清空免打扰记录"。 */
  public answeredLedger(): AnsweredLedger {
    return this.answered;
  }

  /** 【新增】获取当前实际通信生效的 URL（局域网地址优先，断线时无缝回退至公网）。 */
  public getEffectiveBaseUrl(): string {
    return this.effectiveBaseUrl || this.baseUrl;
  }

  /** 【新增】当前是否走局域网高速直连。 */
  public isLanConnected(): boolean {
    return this.isLan;
  }

  /** 【新增】获取最近一次测得的端点延迟（毫秒）。 */
  public getPingMs(): number | null {
    return this.pingMs;
  }

  /** 【新增】获取候选局域网地址列表。 */
  public getLanCandidates(): string[] {
    return [...this.lanCandidates];
  }

  /** 【新增】获取用户设定的首选局域网地址。 */
  public getPreferredLanUrl(): string | undefined {
    return this.preferredLanUrl;
  }

  /** 【新增】更新首选局域网地址。 */
  public setPreferredLanUrl(url?: string): void {
    this.preferredLanUrl = url ? url.replace(/\/+$/, '') : undefined;
    if (this.preferredLanUrl && !this.lanCandidates.includes(this.preferredLanUrl)) {
      this.lanCandidates.unshift(this.preferredLanUrl);
    }
  }

  /** 【新增】获取连接策略模式。 */
  public getConnectionMode(): 'auto' | 'lan' | 'wan' {
    return this.connectionMode;
  }

  /** 【新增】设置连接策略模式（auto / lan / wan）。 */
  public setConnectionMode(mode: 'auto' | 'lan' | 'wan'): void {
    if (this.connectionMode === mode) return;
    this.connectionMode = mode;
    if (mode === 'wan' && this.isLan) {
      this.isLan = false;
      this.effectiveBaseUrl = this.baseUrl;
      this.deps.onActiveUrlChange?.(this.baseUrl, false);
      this.retryNow();
    } else if (mode === 'lan' && !this.isLan) {
      void this.switchToLanNow();
    }
  }

  /** 【新增】探测指定端点的健康与延迟。 */
  public async probeEndpoint(
    targetUrl: string,
    timeoutMs = 1500,
  ): Promise<{ ok: boolean; pingMs: number; data?: Record<string, unknown> }> {
    const start = Date.now();
    const clean = targetUrl.replace(/\/+$/, '');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer =
      controller && timeoutMs > 0
        ? this.setTimer(() => {
            try {
              controller.abort();
            } catch {}
          }, timeoutMs)
        : null;

    try {
      const res = await this.fetchImpl(`${clean}/mobile-gateway/health`, {
        method: 'GET',
        signal: controller ? controller.signal : undefined,
      });
      if (timer !== null) this.clearTimer(timer);
      if (!res.ok) return { ok: false, pingMs: Date.now() - start };
      const json = (await res.json()) as Record<string, unknown>;
      const pingMs = Date.now() - start;
      return { ok: Boolean(json.ok), pingMs, data: json };
    } catch {
      if (timer !== null) this.clearTimer(timer);
      return { ok: false, pingMs: Date.now() - start };
    }
  }

  /** 【新增】立即主动尝试切换至局域网高速通道。 */
  public async switchToLanNow(): Promise<boolean> {
    if (this.authFailed) return false;
    for (const candidate of this.lanCandidates) {
      if (!candidate) continue;
      const res = await this.probeEndpoint(candidate, 2000);
      if (res.ok) {
        this.isLan = true;
        this.effectiveBaseUrl = candidate;
        this.preferredLanUrl = candidate;
        this.pingMs = res.pingMs;
        this.deps.onActiveUrlChange?.(candidate, true);
        if (this.socket) {
          const ws = this.socket;
          this.socket = null;
          this.socketAlive = false;
          this.connecting = false;
          ws.onclose = null;
          try {
            ws.close();
          } catch {}
        }
        this.attempt = 0;
        this.connectReal();
        return true;
      }
    }
    return false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 【新增】连接阶段（可订阅的只读视图；不动 LinkState 联合类型）
  // ───────────────────────────────────────────────────────────────────────────

  /** 【新增】当前连接阶段：`'online'|'connecting'|'offline'|'auth-failed'`。 */
  public getLinkPhase(): LinkPhase {
    return this.phase;
  }

  /**
   * 【新增】订阅连接阶段变化（只在**变化时**推送，不会重复推同一值）。
   * 返回取消订阅函数。已有 `onStateChange` 保持不变，两者可同时用。
   */
  public onPhaseChange(listener: (phase: LinkPhase) => void): () => void {
    this.phaseListeners.add(listener);
    return () => this.phaseListeners.delete(listener);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 【新增】离线待发队列（落盘）
  // ───────────────────────────────────────────────────────────────────────────

  /** 【新增】待发队列快照（可直接渲染"待发 N 条"）。 */
  public outboxSnapshot(): OutboxSnapshot {
    const items = this.outbox.list();
    const failed = items.filter((item) => item.status === 'failed').length;
    const pending = items.length - failed;
    return {
      pending,
      failed,
      total: items.length,
      head: items.find((item) => item.status !== 'failed') ?? null,
      maxAttempts: this.outbox.maxAttempts,
    };
  }

  /** 【新增】订阅待发队列变化（入队/出队/失败态变化时推送快照）。 */
  public onOutboxChange(listener: (snapshot: OutboxSnapshot) => void): () => void {
    this.outboxListeners.add(listener);
    return () => this.outboxListeners.delete(listener);
  }

  /** 【新增】当前待发项（FIFO 顺序，含 failed 项；UI 列待发队列用）。 */
  public outboxItems(): OutboxItem[] {
    return this.outbox.list();
  }

  /** 【新增】待发项条数。 */
  public outboxSize(): number {
    return this.outbox.size();
  }

  /** 【新增】删除一条待发项（用户放弃）。 */
  public removeOutboxItem(id: string): void {
    this.outbox.remove(id);
    this.notifyOutbox();
  }

  /** 【新增】用户手动重试一条失败项：清零 attempts 并置回 pending。 */
  public retryOutboxItem(id: string): void {
    this.outbox.retry(id);
    this.notifyOutbox();
  }

  /** 【新增】清掉所有失败项（用户主动放弃）。 */
  public clearOutboxFailed(): void {
    this.outbox.clearFailed();
    this.notifyOutbox();
  }

  /**
   * 【新增】立即重连：清掉退避定时器与累计退避，马上发起一次握手。
   *
   * @returns true = 已接受（已立即尝试，或本来就在连）；**false = 被拒绝**。
   *
   * 拒绝的唯一情形是 `authFailed`（令牌失效）：重试一万次也连不上，
   * 而且会让用户误以为"重试能绕过重新配对"。此时保持 `auth-failed` 不变，
   * 并再次通过 `onAuthFailure` 提醒上层去重新配对。
   */
  public retryNow(): boolean {
    if (this.authFailed) {
      this.setPhase('auth-failed');
      this.notifyState({
        type: 'degraded',
        reason: '令牌已失效，重试被拒绝（需要重新配对）',
        attempt: this.attempt,
      });
      this.notifyAuthFailure({
        status: this.authFailureStatus ?? 401,
        message: '令牌已失效，retryNow() 已拒绝：请先重新配对',
      });
      return false;
    }

    // 清退避：定时器取消 + 计数归零（下次失败从 1s 重新开始，而不是接着 30s）
    this.clearReconnectTimer();
    this.attempt = 0;
    this.lastBackoffMs = 0;
    this.isStopped = false;

    // 已经在飞：不重复建 socket（并发握手不堆积）
    if (this.connecting || this.socketAlive) return true;

    this.start();
    return true;
  }

  /**
   * 【新增】断线也能发。
   *
   * - `phase === 'online'`：直接发；网络异常（非 401/403）→ **入队**，不丢字。
   * - `phase` 为 offline/connecting：立即入队（**不阻塞**，等 `ready` 自动 flush）。
   * - `authFailed`：**拒绝**并不入队（这条链路上重试没意义，先重新配对）。
   *
   * 只新增 API，不改 `call()` / `respond()` 的既有签名。
   */
  public async sendOrQueue(
    method: string,
    args: Record<string, unknown> = {},
    options: SendOptions = {},
  ): Promise<SendResult> {
    const name = typeof method === 'string' ? method.trim() : '';
    if (!name) {
      return { delivered: false, queued: false, reason: 'invalid', error: 'method 不能为空' };
    }

    if (this.authFailed) {
      return {
        delivered: false,
        queued: false,
        reason: 'auth-failed',
        error: '令牌已失效，需要重新配对后才能发送',
      };
    }

    if (this.phase === 'online') {
      try {
        await this.call(name, args);
        return { delivered: true, queued: false, reason: 'sent' };
      } catch (err: unknown) {
        const status = errorStatus(err);
        if (status !== null && isAuthStatus(status)) {
          this.enterAuthFailure(
            status,
            `令牌已失效（HTTP ${status}），已停止自动重连，需要重新配对`,
          );
          return {
            delivered: false,
            queued: false,
            reason: 'auth-failed',
            error: `令牌已失效（HTTP ${status}）`,
          };
        }
        const message = (err as Error)?.message || '网络异常';
        const item = this.enqueueOutbox(name, args, options);
        return {
          delivered: false,
          queued: true,
          reason: 'queued-network-error',
          itemId: item?.id,
          error: message,
        };
      }
    }

    const item = this.enqueueOutbox(name, args, options);
    if (!item) {
      return { delivered: false, queued: false, reason: 'invalid', error: '待发项非法（id/method 缺失）' };
    }
    return { delivered: false, queued: true, reason: 'queued-offline', itemId: item.id };
  }

  /**
   * 【新增】按 FIFO flush 待发队列（重连成功时自动调用，也可手动调用）。
   *
   * 并发去重：同一时刻只有一轮 flush（`flushInFlight`），
   * 重连抖动不会把队列重复发一遍。
   *
   * 结束条件（避免"页面卡死"式无限刷）：
   *   - 队列空 → 正常结束；
   *   - 传输层仍不可用（网络异常）→ 停在本轮，留到下次 `ready`；
   *   - 401/403 → 立即停并进入 auth 失败（该项不计尝试次数，保留在队列里）；
   *   - 单项达尝试上限 → 标 `failed` 后**继续**后面的项（毒丸不堵队）。
   */
  public flushOutbox(): Promise<FlushOutboxResult> {
    if (this.flushInFlight) return this.flushInFlight;
    const run = this.runOutboxFlush();
    this.flushInFlight = run.finally(() => {
      this.flushInFlight = null;
    });
    return this.flushInFlight;
  }

  private async runOutboxFlush(): Promise<FlushOutboxResult> {
    const result: FlushOutboxResult = { attempted: 0, delivered: 0, failed: 0, stopped: false };
    if (this.authFailed) {
      result.stopped = true;
      return result;
    }

    for (;;) {
      if (this.authFailed || this.isStopped) {
        result.stopped = true;
        break;
      }
      const item = this.outbox.nextPending();
      if (!item) break;

      this.outbox.markSending(item.id);
      this.notifyOutbox();
      result.attempted += 1;

      try {
        await this.call(item.method, item.args);
        this.outbox.remove(item.id);
        result.delivered += 1;
        this.notifyOutbox();
      } catch (err: unknown) {
        const status = errorStatus(err);
        if (status !== null && isAuthStatus(status)) {
          // 丢掉这条指令比"发一半"更糟 —— 放回 pending 且不计尝试次数
          this.outbox.release(item.id);
          this.notifyOutbox();
          this.enterAuthFailure(
            status,
            `令牌已失效（HTTP ${status}），已停止自动重连，需要重新配对`,
          );
          result.stopped = true;
          break;
        }
        const message = (err as Error)?.message || '发送失败';
        const outcome = this.outbox.recordFailure(item.id, message);
        this.notifyOutbox();
        if (outcome.exhausted) {
          result.failed += 1;
          continue; // 毒丸已隔离，继续后面的项
        }
        result.stopped = true; // 传输层还没好：本轮到此为止
        break;
      }
    }

    return result;
  }

  private enqueueOutbox(
    method: string,
    args: Record<string, unknown>,
    options: SendOptions = {},
  ): OutboxItem | null {
    const explicit = typeof options.id === 'string' ? options.id.trim() : '';
    const raw = {
      id: explicit || this.makeOutboxId(),
      method,
      args,
      createdAt: this.nowMs(),
      attempts: 0,
      status: 'pending' as const,
    };
    const result = this.outbox.enqueue(raw);
    if (!result) return null;
    this.notifyOutbox();
    return result.item;
  }

  private notifyState(state: LinkState) {
    const fullState: LinkState = {
      ...state,
      isLan: this.isLan,
      effectiveUrl: this.effectiveBaseUrl || this.baseUrl,
      ...(this.pingMs !== null ? { pingMs: this.pingMs } : {}),
    };
    this.stateListeners.forEach((fn) => fn(fullState));
  }

  private notifyAuthFailure(info: AuthFailureInfo) {
    this.authFailureListeners.forEach((fn) => fn(info));
  }

  private notifyRespondFailure(info: RespondFailureInfo) {
    this.respondFailureListeners.forEach((fn) => fn(info));
  }

  /** 【新增】更新连接阶段（只在变化时推送）。 */
  private setPhase(phase: LinkPhase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseListeners.forEach((fn) => fn(phase));
  }

  /** 【新增】推送待发队列快照（没有订阅者时不算快照）。 */
  private notifyOutbox() {
    if (this.outboxListeners.size === 0) return;
    const snapshot = this.outboxSnapshot();
    this.outboxListeners.forEach((fn) => fn(snapshot));
  }

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private makeOutboxId(): string {
    this.outboxSeq += 1;
    return `ob-${this.nowMs()}-${this.outboxSeq}`;
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

  /**
   * 打开一条**按 streamId 路由**的子流（同一条 mux WS 上）。
   *
   * 用途：订阅 `session/follow` 拿会话的逐事件进度。
   * 真主机实测的帧序列：先 `item:{type:'snapshot', cursor, records}`，
   * 随后每次变更 `item:{type:'event', event:{type,seq,time,data}}`。
   *
   * ⚠️ 与 `call()` 不同，这里**不等待应答**：open 帧发出去后帧会自己来；
   * 出错时收到 `{type:'error', streamId}`，交给 `onError`（不会影响整体连接状态）。
   */
  public openStream(
    endpoint: string,
    args: Record<string, unknown>,
    handlers: {
      onItem?: (value: Record<string, unknown>) => void;
      onEnd?: () => void;
      onError?: (error: { message?: string }) => void;
    } = {},
  ): { streamId: string; close: () => void } {
    const streamId = `stream-${Math.random().toString(36).slice(2, 10)}`;
    this.streamSubscribers.set(streamId, handlers);

    const send = () => {
      const socket = this.socket;
      if (!socket) return false;
      try {
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
        return true;
      } catch {
        return false;
      }
    };

    if (!send()) {
      // socket 还没就绪：短暂重试，避免"打开会话时刚好在重连"导致订阅静默失败
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        if (send() || tries > 20 || !this.streamSubscribers.has(streamId)) clearInterval(timer);
      }, 250);
    }

    return {
      streamId,
      close: () => {
        this.streamSubscribers.delete(streamId);
        try {
          this.socket?.send(JSON.stringify({ type: 'end', streamId }));
        } catch {
          /* 关流失败不影响调用方 */
        }
      },
    };
  }

  private createSocket(url: string): WebSocketLike {
    if (this.deps.WebSocket) return this.deps.WebSocket(url);
    return new WebSocket(url) as unknown as WebSocketLike;
  }

  private isDemo(): boolean {
    return (
      DEMO_MODE ||
      this.baseUrl.includes('demo') ||
      this.token.includes('demo')
    );
  }

  public start() {
    // 令牌已失效：不得自动重连（要等用户重新配对 → clearAuthFailure()）。
    if (this.authFailed) {
      this.setPhase('auth-failed');
      this.notifyState({ type: 'degraded', reason: '令牌已失效，等待重新配对', attempt: this.attempt });
      this.notifyAuthFailure({
        status: this.authFailureStatus ?? 401,
        message: '令牌已失效，需要重新配对后才能连接',
      });
      return;
    }

    this.isStopped = false;
    // 已经在飞/已经连上：不重复握手（并发握手不堆积），也不要把 online 倒回 connecting
    if (this.connecting || this.socketAlive) return;
    this.setPhase('connecting');
    this.attempt += 1;
    this.notifyState({ type: 'connecting', attempt: this.attempt });

    // If demo token or local demo host, activate robust simulated mode
    if (this.isDemo()) {
      setTimeout(() => {
        if (!this.isStopped) {
          this.eventClientId = 'mock-client-' + Math.random().toString(36).slice(2, 8);
          this.socketAlive = true;
          this.setPhase('online');
          this.notifyState({
            type: 'ready',
            hostName: this.instanceName || 'MacBook Pro (演练主机)',
          });
          // 演习模式也要把离线期间攒下的指令送出去
          void this.flushOutbox();
        }
      }, 300);
      return;
    }

    this.connectReal();
  }

  public stop() {
    this.isStopped = true;
    this.connecting = false;
    this.socketAlive = false;
    this.clearReconnectTimer();
    this.clearWatchdog();
    this.clearLanDiscoveryTimer();
    if (this.onlineCleanup) {
      this.onlineCleanup();
      this.onlineCleanup = null;
    }
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
    this.setPhase('offline');
  }

  private clearLanDiscoveryTimer() {
    this.clearTimer(this.lanDiscoveryTimer);
    this.lanDiscoveryTimer = null;
  }

  private armLanDiscovery() {
    this.clearLanDiscoveryTimer();
    if (this.isStopped || this.authFailed) return;
    if (this.isLan || this.connectionMode !== 'auto') return;
    if (this.lanCandidates.length === 0) return;

    const interval = this.deps.lanDiscoveryIntervalMs ?? 25_000;
    this.lanDiscoveryTimer = this.setTimer(() => {
      this.lanDiscoveryTimer = null;
      void this.triggerLanProbe();
    }, interval);
  }

  public async triggerLanProbe(): Promise<boolean> {
    if (this.isStopped || this.authFailed) return false;
    if (this.isLan || this.connectionMode !== 'auto') return false;
    if (this.lanCandidates.length === 0) return false;
    if (this.lanProbeInFlight) return this.lanProbeInFlight;

    const run = (async () => {
      for (const candidate of this.lanCandidates) {
        if (!candidate || candidate === this.baseUrl) continue;
        const probeRes = await this.probeEndpoint(candidate, this.deps.lanProbeTimeoutMs ?? 1500);
        if (probeRes.ok) {
          this.isLan = true;
          this.effectiveBaseUrl = candidate;
          this.pingMs = probeRes.pingMs;
          this.deps.onActiveUrlChange?.(candidate, true);
          if (this.socket) {
            const ws = this.socket;
            this.socket = null;
            this.socketAlive = false;
            this.connecting = false;
            ws.onclose = null;
            try {
              ws.close();
            } catch {}
          }
          this.notifyState({
            type: 'ready',
            hostName: this.instanceName || candidate,
          });
          this.connectReal();
          return true;
        }
      }
      this.armLanDiscovery();
      return false;
    })();

    this.lanProbeInFlight = run.finally(() => {
      this.lanProbeInFlight = null;
    });
    return this.lanProbeInFlight;
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
    // 无论什么原因，这条 socket 都已经不在飞了 —— 清掉握手/存活标志，
    // 否则后续重连会被 connectReal 的"已有握手在飞"护栏永久挡住。
    this.connecting = false;
    this.socketAlive = false;
    this.clearWatchdog();
    if (this.isStopped || this.authFailed) return;

    // 局域网断开：auto 模式下自动回退至公网服务器，并重试
    if (this.isLan && this.connectionMode === 'auto' && this.effectiveBaseUrl !== this.baseUrl) {
      this.isLan = false;
      this.effectiveBaseUrl = this.baseUrl;
      this.deps.onActiveUrlChange?.(this.baseUrl, false);
      this.setPhase('connecting');
      this.notifyState({
        type: 'connecting',
        reason: '局域网不可达，正在自动切换至公网中继服务器…',
        attempt: this.attempt,
      });
      this.connectReal();
      return;
    }

    const code = typeof ev?.code === 'number' ? ev.code : 1006;
    const reason = typeof ev?.reason === 'string' ? ev.reason : '';

    if (classifyClose(code, reason) === 'auth') {
      this.enterAuthFailure(code, `网关拒绝连接（关闭码 ${code}），令牌可能已失效，已停止重连`);
      return;
    }

    this.setPhase('offline');
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
        const targetBase = this.effectiveBaseUrl || this.baseUrl;
        const res = await this.fetchImpl(
          `${targetBase}/mobile-gateway/api/${Envelopes.toEndpoint('session.list')}`,
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
    this.setPhase('offline');
    const delay = nextBackoff(this.attempt, {
      ...(this.deps.backoff ?? {}),
    });
    this.lastBackoffMs = delay;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (this.isStopped || this.authFailed) return;
      this.attempt += 1;
      this.setPhase('connecting');
      this.notifyState({ type: 'connecting', attempt: this.attempt });
      this.connectReal();
    }, delay);
  }

  private enterAuthFailure(status: number, message: string) {
    if (this.authFailed) return;
    this.authFailed = true;
    this.authFailureStatus = status;
    this.connecting = false;
    this.socketAlive = false;
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
    this.setPhase('auth-failed');
    this.notifyAuthFailure({ status, message });
  }

  private connectReal() {
    if (this.authFailed) return;
    // 同一时刻只允许一次握手/探测在飞：`start()` 被连点、退避定时器与
    // `retryNow()` 同时触发时，绝不能再堆出第二条握手（弱网下页面会积一排半死 socket）。
    if (this.connecting || this.socketAlive) return;
    try {
      const targetBase = this.effectiveBaseUrl || this.baseUrl;
      const wsBase = targetBase.replace(/^http/, 'ws') + WS_MUX;
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
      this.connecting = true; // 标记"这次握手在飞"，挡住重复 start()/重连
      this.socket = ws;

      ws.onopen = () => {
        this.connecting = false;
        this.socketAlive = true;
        if (this.isStopped || this.authFailed) {
          this.socketAlive = false;
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
            this.setPhase('online');
            this.notifyState({
              type: 'ready',
              hostName: this.instanceName || this.effectiveBaseUrl || this.baseUrl,
            });
            // 重连成功 → 把离线期间攒下的指令按序送出去（fire-and-forget，不阻塞事件流）
            void this.flushOutbox();
            // 在 auto 模式下如果当前在 WAN 端点，启动后台局域网发现定时器
            this.armLanDiscovery();
          })
          .catch((err: unknown) => {
            if (this.isStopped) return;
            const status = errorStatus(err);
            if (status !== null && isAuthStatus(status)) {
              // fetch 侧的 401/403 与 mux 握手是同一判据：立即停止重连
              this.enterAuthFailure(status, `令牌已失效（HTTP ${status}），已停止自动重连，需要重新配对`);
              return;
            }
            // 局域网若 session.list 失败，且处于 auto 模式，自动回退到公网服务器
            if (this.isLan && this.connectionMode === 'auto' && this.effectiveBaseUrl !== this.baseUrl) {
              this.isLan = false;
              this.effectiveBaseUrl = this.baseUrl;
              this.deps.onActiveUrlChange?.(this.baseUrl, false);
              this.socketAlive = false;
              if (this.socket) {
                this.socket.onclose = null;
                try {
                  this.socket.close();
                } catch {}
                this.socket = null;
              }
              this.setPhase('connecting');
              this.notifyState({
                type: 'connecting',
                reason: '局域网响应异常，正在尝试回退至公网服务器…',
                attempt: this.attempt,
              });
              this.connectReal();
              return;
            }
            const message = (err as Error)?.message || '未知错误';
            this.setPhase('offline');
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
          const streamId = typeof frame.streamId === 'string' ? frame.streamId : '';
          if (frame.type === 'item' && frame.value) {
            // **按 streamId 路由**：`$events` 之外还有按会话的流（`session/follow`），
            // 它们的 item 语义完全不同，不能都当全局事件处理。
            const subscriber = this.streamSubscribers.get(streamId);
            if (subscriber) subscriber.onItem?.(frame.value as Record<string, unknown>);
            else this.handleStreamItem(frame.value);
            return;
          }
          if (frame.type === 'end' || frame.type === 'error') {
            const subscriber = this.streamSubscribers.get(streamId);
            if (subscriber) {
              if (frame.type === 'error') {
                subscriber.onError?.(
                  (frame.error as { message?: string } | undefined) ?? { message: '流错误' },
                );
              } else {
                subscriber.onEnd?.();
              }
              this.streamSubscribers.delete(streamId);
              return;
            }
            // 只有**全局**流被关才降级；子流被关不该影响整体连接状态
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
      this.connecting = false;
      this.socketAlive = false;
      if (this.isLan && this.connectionMode === 'auto' && this.effectiveBaseUrl !== this.baseUrl) {
        this.isLan = false;
        this.effectiveBaseUrl = this.baseUrl;
        this.deps.onActiveUrlChange?.(this.baseUrl, false);
        this.connectReal();
        return;
      }
      this.setPhase('offline');
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
    } else if (
      value.type === 'cancel' ||
      value.type === 'waterfall/cancel' ||
      value.event === 'waterfall/cancel' ||
      value.event === 'cancel'
    ) {
      const cancelId = String(value.eventId || value.cancelEventId || value.rpcId || '');
      if (cancelId) {
        this.inflightEventIds.delete(cancelId);
      }
      this.requestListeners.forEach((fn) =>
        fn({
          rpcId: cancelId,
          method: 'cancel',
          payload: value,
          answerable: false,
        }),
      );
    }
  }

  public async call(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // If running in demo mode or offline simulated fallback
    if (this.isDemo()) {
      return this.handleMockCall(method, args);
    }

    const rpcId = 'r' + Math.random().toString(36).slice(2, 9);
    const endpoint = Envelopes.toEndpoint(method);
    const body = Envelopes.clientRequest(rpcId, method, args);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutMs = this.deps.callTimeoutMs ?? 15_000;
    const timeoutHandle =
      controller && timeoutMs > 0
        ? this.setTimer(() => {
            try {
              controller.abort();
            } catch {}
          }, timeoutMs)
        : null;

    try {
      const targetBase = this.effectiveBaseUrl || this.baseUrl;
      const res = await this.fetchImpl(`${targetBase}/mobile-gateway/api/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });

      if (timeoutHandle !== null) this.clearTimer(timeoutHandle);

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
    } catch (err: unknown) {
      if (timeoutHandle !== null) this.clearTimer(timeoutHandle);
      throw err;
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
    if (this.isDemo()) {
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

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutMs = this.deps.respondTimeoutMs ?? 10_000;
    const timeoutHandle =
      controller && timeoutMs > 0
        ? this.setTimer(() => {
            try {
              controller.abort();
            } catch {}
          }, timeoutMs)
        : null;

    try {
      const rpcId = 'r' + Math.random().toString(36).slice(2, 9);
      const body = Envelopes.clientRequest(rpcId, '$events/result', {
        clientId,
        eventId,
        outcome,
      });

      const targetBase = this.effectiveBaseUrl || this.baseUrl;
      const res = await this.fetchImpl(`${targetBase}/mobile-gateway/api/${EVENT_RESULT_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });

      if (timeoutHandle !== null) this.clearTimer(timeoutHandle);

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
      if (timeoutHandle !== null) this.clearTimer(timeoutHandle);
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
