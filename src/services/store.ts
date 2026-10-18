// `import type`：`../types` 无运行时导出，值导入会让 Node 直跑 src/ 的测试在链接期失败
import type { HostRecord } from '../types';
import type { StorageLike } from './device';
import { DEMO_MODE } from './demo';

const STORAGE_KEY = 'dsh_hosts_v1';
const ACTIVE_HOST_KEY = 'dsh_active_host_id';

/**
 * 演示用主机 —— **只在 [DEMO_MODE] 开启时才会被使用**。
 *
 * 🔴 2026-10-14 修正：此前它在 `all()` 的**三条路径**上被返回：
 *   ① 首次运行（无数据时主动写入）
 *   ② 解析出的数组为空
 *   ③ 任何异常（catch 分支）
 *
 * 后果是**静默的假成功**：全新安装的用户会看到一台并不存在的
 * 「MacBook Pro (Demo 实例)」，界面一切正常 —— 但它连的不是他的电脑。
 * 这种失败比直接报错难查得多（而且掩盖了真实的存储/连接错误）。
 *
 * 现在：**只有显式设了 `VITE_DEMO_MODE=true` 才回退到它**；
 * 否则如实返回空列表，让用户走正常的「配对电脑」流程。
 */
export const DEFAULT_DEMO_HOST: HostRecord = {
  id: 'demo-local-host',
  label: 'MacBook Pro (演练主机)',
  baseUrl: 'http://127.0.0.1:4142',
  token: 'dsh_demo_token_3a7b9c1d2e',
  deviceId: 'web-companion-device-01',
  instanceName: 'MacBook Pro M3 Max (本地)',
  pairedAt: Date.now() - 86400000 * 2,
  lastUsedAt: Date.now(),
};

export const HostStore = {
  all(): HostRecord[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // 无数据：仅演示模式才注入假主机，否则返回空（用户该看到"请配对"）
      if (!raw) {
        if (DEMO_MODE) {
          const initial = [DEFAULT_DEMO_HOST];
          localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
          return initial;
        }
        return [];
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
      // 空数组：演示模式给假主机，否则就是"没有已配对电脑"
      return DEMO_MODE ? [DEFAULT_DEMO_HOST] : [];
    } catch (error) {
      // 读失败要**暴露**而不是伪装成"有一台演示机"。
      console.error('[HostStore] 读取已配对电脑失败：', error);
      return DEMO_MODE ? [DEFAULT_DEMO_HOST] : [];
    }
  },

  find(id: string): HostRecord | undefined {
    return this.all().find((h) => h.id === id);
  },

  upsert(record: HostRecord): void {
    const next = this.all().filter((h) => h.id !== record.id);
    next.unshift(record);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));

    // 🔴 关键修复：如果之前 active 是演练主机或为空，而新加入的是真实主机，
    // 必须自动切换 active 为真实主机，避免用户配对了电脑却依然挂在演练主机上！
    const currentActive = localStorage.getItem(ACTIVE_HOST_KEY);
    if (record.id !== DEFAULT_DEMO_HOST.id && (!currentActive || currentActive === DEFAULT_DEMO_HOST.id)) {
      this.setActiveId(record.id);
    }
  },

  touch(id: string): void {
    const record = this.find(id);
    if (record) {
      this.upsert({ ...record, lastUsedAt: Date.now() });
    }
  },

  remove(id: string): void {
    const next = this.all().filter((h) => h.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    if (this.getActiveId() === id) {
      this.setActiveId(next[0]?.id || null);
    }
  },

  rename(id: string, label: string): void {
    const record = this.find(id);
    if (record) {
      this.upsert({ ...record, label });
    }
  },

  updateNetwork(
    id: string,
    updates: {
      lanUrl?: string;
      lanAddresses?: string[];
      connectionMode?: HostRecord['connectionMode'];
      activeUrl?: string;
      baseUrl?: string;
    },
  ): void {
    const record = this.find(id);
    if (!record) return;
    const next: HostRecord = {
      ...record,
      ...(updates.baseUrl ? { baseUrl: updates.baseUrl.replace(/\/+$/, '') } : {}),
      ...(updates.lanUrl !== undefined ? { lanUrl: updates.lanUrl ? updates.lanUrl.replace(/\/+$/, '') : undefined } : {}),
      ...(updates.lanAddresses !== undefined ? { lanAddresses: updates.lanAddresses } : {}),
      ...(updates.connectionMode !== undefined ? { connectionMode: updates.connectionMode } : {}),
      ...(updates.activeUrl !== undefined ? { activeUrl: updates.activeUrl } : {}),
    };
    this.upsert(next);
  },

  updateActiveUrl(id: string, activeUrl: string): void {
    const record = this.find(id);
    if (record && record.activeUrl !== activeUrl) {
      this.upsert({ ...record, activeUrl });
    }
  },

  setConnectionMode(id: string, mode: NonNullable<HostRecord['connectionMode']>): void {
    const record = this.find(id);
    if (record) {
      this.upsert({ ...record, connectionMode: mode });
    }
  },

  getActiveId(): string | null {
    const saved = localStorage.getItem(ACTIVE_HOST_KEY);
    if (saved && this.find(saved)) {
      return saved;
    }
    const all = this.all();
    // 🔴 关键修复：优先挑真实主机，绝不让 demo 占第一位导致默认被选
    const realHost = all.find((h) => h.id !== DEFAULT_DEMO_HOST.id);
    const chosen = realHost?.id || all[0]?.id || null;
    if (chosen) {
      localStorage.setItem(ACTIVE_HOST_KEY, chosen);
    }
    return chosen;
  },

  setActiveId(id: string | null): void {
    if (id) {
      localStorage.setItem(ACTIVE_HOST_KEY, id);
      this.touch(id);
    } else {
      localStorage.removeItem(ACTIVE_HOST_KEY);
    }
  },

  addDemoHost(): HostRecord {
    // 🔴 关键修复：添加演练主机时，如果已有真实主机且 active 正常，绝不抢占 activeId！
    const all = this.all();
    const existing = this.find(DEFAULT_DEMO_HOST.id);
    if (!existing) {
      const next = [...all, DEFAULT_DEMO_HOST];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
    const currentActive = localStorage.getItem(ACTIVE_HOST_KEY);
    const hasRealActive = currentActive && currentActive !== DEFAULT_DEMO_HOST.id && this.find(currentActive);
    if (!hasRealActive && !currentActive) {
      this.setActiveId(DEFAULT_DEMO_HOST.id);
    }
    return DEFAULT_DEMO_HOST;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 已应答审批事件的落盘账本
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 为什么必须落盘（2026-10-14）
 *
 * 去重此前只用 `DshConnection` 里的一个内存 `Set`（`answeredEventIds`）。
 * 内存态在 App 重启 / WebView 被系统回收 / 用户下拉刷新后**全部丢失**，
 * 于是网关重放的同一条 `waterfall` 审批事件会被**再弹一次** ——
 * 用户刚刚点过"允许"，重启后又被问一遍，自然怀疑"到底批没批"。
 *
 * 这里把「已应答的 eventId」写进 localStorage（带版本号 key），
 * 重启后读回，已经处理过的事件不再进 `onRequest`。
 *
 * ⚠️ 语义边界：只记录**应答成功**的事件（`respond()` 返回 true 之后）。
 * 只在"收到"时记录会让一次失败/崩溃永久吞掉用户的审批；
 * 只在"收到"时记忆（内存）则用于同一会话内防止重复弹窗 —— 两者在
 * `connection.ts` 里分别对应 `answered`（落盘）与 `inflightEventIds`（内存）。
 */
export const ANSWERED_LEDGER_VERSION = 1;

/** 落盘键。带版本号：格式升级时可并存读取，旧数据不会把新代码炸掉。 */
export const ANSWERED_LEDGER_KEY = `dsh_answered_events_v${ANSWERED_LEDGER_VERSION}`;

/** 容量上限。超出后按 FIFO 淘汰最旧的记录（审批是低频事件，500 足够）。 */
export const ANSWERED_LEDGER_CAPACITY = 500;

export interface AnsweredLedger {
  /** 是否已应答过（O(1)）。 */
  has(eventId: string): boolean;
  /** 记录为已应答；**返回 true 表示这是新写入**（此前没有）。 */
  remember(eventId: string): boolean;
  /** 删除一条（应答失败需要允许重试时使用）。 */
  forget(eventId: string): void;
  /** 当前记录条数。 */
  size(): number;
  /** 快照（从旧到新）。 */
  ids(): string[];
  clear(): void;
}

interface LedgerFile {
  v: number;
  ids: string[];
}

/** 自动探测 localStorage；不可用时返回 null（只用内存）。 */
function detectLedgerStorage(): StorageLike | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch {
    // 隐私模式访问会抛
  }
  return null;
}

/** 从任意历史形状中解析出 id 列表：支持 `{v,ids}` 与裸数组两种格式。 */
function parseLedgerFile(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as LedgerFile)?.ids)
        ? (parsed as LedgerFile).ids
        : null;
    if (!list) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  } catch {
    // 损坏的 JSON 不能变成崩溃；如实告警后从空账本开始
    console.warn('[AnsweredLedger] 账本解析失败，已忽略损坏数据');
    return [];
  }
}

/**
 * 创建（或读回）一个已应答事件账本。
 *
 * @param storage `undefined` = 自动探测 localStorage；`null` = 纯内存（测试/SSR）。
 * @param capacity 容量上限，超出按 FIFO 淘汰。
 */
export function createAnsweredLedger(
  storage: StorageLike | null | undefined = undefined,
  capacity: number = ANSWERED_LEDGER_CAPACITY,
): AnsweredLedger {
  const store = storage === undefined ? detectLedgerStorage() : storage;
  const limit = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : ANSWERED_LEDGER_CAPACITY;

  const read = (): Set<string> => {
    if (!store) return new Set();
    try {
      return new Set(parseLedgerFile(store.getItem(ANSWERED_LEDGER_KEY)).slice(-limit));
    } catch {
      return new Set();
    }
  };

  const ids = read();

  const persist = (): void => {
    if (!store) return;
    const file: LedgerFile = { v: ANSWERED_LEDGER_VERSION, ids: [...ids] };
    try {
      store.setItem(ANSWERED_LEDGER_KEY, JSON.stringify(file));
    } catch {
      // 配额/隐私模式写失败：本次运行仍以内存为准，不抛（审批流程不能被账本拖死）
    }
  };

  return {
    has(eventId: string): boolean {
      const id = String(eventId ?? '').trim();
      return !!id && ids.has(id);
    },

    remember(eventId: string): boolean {
      const id = String(eventId ?? '').trim();
      if (!id || ids.has(id)) return false;
      ids.add(id);
      while (ids.size > limit) {
        const oldest = ids.values().next();
        if (oldest.done) break;
        ids.delete(oldest.value);
      }
      persist();
      return true;
    },

    forget(eventId: string): void {
      const id = String(eventId ?? '').trim();
      if (!id || !ids.delete(id)) return;
      persist();
    },

    size(): number {
      return ids.size;
    },

    ids(): string[] {
      return [...ids];
    },

    clear(): void {
      ids.clear();
      if (!store) return;
      try {
        if (typeof store.removeItem === 'function') store.removeItem(ANSWERED_LEDGER_KEY);
        else store.setItem(ANSWERED_LEDGER_KEY, JSON.stringify({ v: ANSWERED_LEDGER_VERSION, ids: [] }));
      } catch {
        // 同上：清理失败不影响内存态
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 离线待发队列（outbox）—— 断线时**不丢用户指令**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 为什么必须落盘（2026-10-15）
 *
 * 弱网/离线时旧行为是「发送 → fetch 抛错 → 界面提示'指令未送达' → 用户自己重打」。
 * 在地铁/电梯里这等于**丢字**：用户以为发出去了，实际上什么都没发生。
 *
 * 这里把「待发的 RPC」整条（method + args）落盘到 localStorage：
 *   - 断线（非 auth 失败）时入队而不是报错；
 *   - 重连成功后按 **FIFO** 顺序自动 flush；
 *   - 每条有 attempts 上限（`OUTBOX_MAX_ATTEMPTS`），超过标 `failed` 等用户处理
 *     （而不是无限重试刷主机）。
 *
 * 与 `lib/message-queue.ts` 的分工：那个是**任务运行中**的内存排队（UI 语义），
 * 这个是**网络不可用**时的落盘待发（传输语义）。两者互不依赖。
 *
 * ⚠️ 崩溃恢复：`sending` 状态只在一次 flush 的瞬间存在，读回时一律降级为
 * `pending` —— 否则进程被杀会留下一条永远"正在发送"、谁也发不出去的僵尸项。
 */
export const OUTBOX_VERSION = 1;

/** 落盘键。带版本号：格式升级可并存读取，旧数据不会炸新代码。 */
export const OUTBOX_KEY = `dsh_outbox_v${OUTBOX_VERSION}`;

/** 容量上限。超出按 FIFO 淘汰最旧的 **pending**（failed 项优先保留给用户处理）。 */
export const OUTBOX_CAPACITY = 50;

/** 单条最大尝试次数：达到即标 `failed`，等用户显式重试。 */
export const OUTBOX_MAX_ATTEMPTS = 5;

export type OutboxStatus = 'pending' | 'sending' | 'failed';

export interface OutboxItem {
  id: string;
  /** RPC 方法名（如 `session.prompt`）。 */
  method: string;
  /** RPC 参数，必须是可 JSON 序列化的对象。 */
  args: Record<string, unknown>;
  createdAt: number;
  /** 已尝试次数（只增不清，除非用户手动 retry）。 */
  attempts: number;
  status: OutboxStatus;
  /** 最近一次失败原因（仅 status==='failed' 时有意义）。 */
  error?: string;
}

interface OutboxFile {
  v: number;
  items: OutboxItem[];
}

export interface OutboxEnqueueResult {
  item: OutboxItem;
  /** false = 同 id 已存在（幂等命中，队列不变）。 */
  added: boolean;
  evicted: OutboxItem[];
}

export interface OutboxFailureResult {
  item: OutboxItem | null;
  /** true = 已达 attempts 上限，该项已标 `failed`。 */
  exhausted: boolean;
}

/** 落盘待发队列的操作面（`createOutboxQueue` 的返回值）。 */
export interface OutboxQueue {
  list(): OutboxItem[];
  size(): number;
  pendingCount(): number;
  failedCount(): number;
  /** 队首待发项（FIFO），没有则 null。 */
  nextPending(): OutboxItem | null;
  /** 入队；非法项返回 null。同 id 幂等。 */
  enqueue(raw: unknown): OutboxEnqueueResult | null;
  /** 标记为「正在发送」（崩溃后读回会降级为 pending）。 */
  markSending(id: string): OutboxItem | null;
  /** 发送中止（如中途发现令牌失效）：回到 pending，**不**计尝试次数。 */
  release(id: string): void;
  remove(id: string): void;
  /** 记一次失败：attempts+1；达上限则标 failed。 */
  recordFailure(id: string, error?: string): OutboxFailureResult;
  /** 直接标失败（不依赖上限）。 */
  markFailed(id: string, error?: string): void;
  /** 用户手动重试：置回 pending 并清零 attempts/error。 */
  retry(id: string): void;
  clear(): void;
  clearFailed(): void;
  /** 尝试次数上限（与创建时一致）。 */
  maxAttempts: number;
}

const UNBOUNDED_OUTBOX = Number.MAX_SAFE_INTEGER;

/** 把任意输入收敛成合法待发项；非法（空 id / 空 method）返回 null。 */
export function normalizeOutboxItem(raw: unknown): OutboxItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const id = typeof source.id === 'string' ? source.id.trim() : '';
  const method = typeof source.method === 'string' ? source.method.trim() : '';
  if (!id || !method) return null;

  const rawArgs = source.args;
  const args =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  const createdAt =
    typeof source.createdAt === 'number' && Number.isFinite(source.createdAt) ? source.createdAt : 0;

  const attempts =
    typeof source.attempts === 'number' && Number.isFinite(source.attempts) && source.attempts > 0
      ? Math.floor(source.attempts)
      : 0;

  const status: OutboxStatus =
    source.status === 'failed' ? 'failed' : source.status === 'sending' ? 'sending' : 'pending';

  const item: OutboxItem = { id, method, args, createdAt, attempts, status };
  if (typeof source.error === 'string' && source.error) item.error = source.error;
  return item;
}

/** 同 id 只保留第一次出现的项（保证幂等/防重复点击）。 */
export function dedupeOutbox(items: OutboxItem[]): OutboxItem[] {
  const seen = new Set<string>();
  const out: OutboxItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * 超上限时淘汰最旧的 **pending**；`sending`/`failed` 优先保留
 * （正在飞的和等用户处理的都不能被静默丢掉）。全是这两类时才按最旧淘汰。
 */
export function applyOutboxLimit(
  items: OutboxItem[],
  limit: number = OUTBOX_CAPACITY,
): { items: OutboxItem[]; evicted: OutboxItem[] } {
  const max = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : OUTBOX_CAPACITY;
  if (items.length <= max) return { items: items.slice(), evicted: [] };

  let overflow = items.length - max;
  const kept: OutboxItem[] = [];
  const evicted: OutboxItem[] = [];

  for (const item of items) {
    if (overflow > 0 && item.status === 'pending') {
      evicted.push(item);
      overflow -= 1;
      continue;
    }
    kept.push(item);
  }

  if (overflow > 0) {
    const keptStrict: OutboxItem[] = [];
    for (const item of kept) {
      if (overflow > 0) {
        evicted.push(item);
        overflow -= 1;
        continue;
      }
      keptStrict.push(item);
    }
    return { items: keptStrict, evicted };
  }

  return { items: kept, evicted };
}

/** 清洗 + 去重 + 截断；用于把 localStorage / 外部来的数据收敛成合法队列。 */
export function normalizeOutbox(input: unknown, limit: number = OUTBOX_CAPACITY): OutboxItem[] {
  const list = Array.isArray(input) ? input : [];
  const cleaned: OutboxItem[] = [];
  for (const raw of list) {
    const item = normalizeOutboxItem(raw);
    if (item) cleaned.push(item);
  }
  return applyOutboxLimit(dedupeOutbox(cleaned), limit).items;
}

/** 入队（纯函数）。非法项返回 null；同 id 幂等。 */
export function enqueueOutbox(
  queue: OutboxItem[],
  raw: unknown,
  options: { limit?: number } = {},
): { queue: OutboxItem[]; item: OutboxItem; added: boolean; evicted: OutboxItem[] } | null {
  const base = normalizeOutbox(queue, UNBOUNDED_OUTBOX);
  const item = normalizeOutboxItem(raw);
  if (!item) return null;

  const existing = base.find((entry) => entry.id === item.id);
  if (existing) return { queue: base, item: existing, added: false, evicted: [] };

  const limited = applyOutboxLimit([...base, item], options.limit ?? OUTBOX_CAPACITY);
  return { queue: limited.items, item, added: true, evicted: limited.evicted };
}

/** 按 id 出队（纯函数）。 */
export function removeOutbox(queue: OutboxItem[], id: string): OutboxItem[] {
  return normalizeOutbox(queue, UNBOUNDED_OUTBOX).filter((item) => item.id !== id);
}

/** 把一项标成 `sending`（纯函数）。 */
export function markOutboxSending(queue: OutboxItem[], id: string): OutboxItem[] {
  return normalizeOutbox(queue, UNBOUNDED_OUTBOX).map((item) =>
    item.id === id ? { ...item, status: 'sending' as OutboxStatus } : item,
  );
}

/** 把 `sending` 放回 `pending`，不计尝试次数（纯函数）。 */
export function releaseOutbox(queue: OutboxItem[], id: string): OutboxItem[] {
  return normalizeOutbox(queue, UNBOUNDED_OUTBOX).map((item) =>
    item.id === id && item.status === 'sending' ? { ...item, status: 'pending' as OutboxStatus } : item,
  );
}

/**
 * 记一次发送失败（纯函数）：`attempts + 1`；达到上限则 `status='failed'`
 * （留给用户显式重试），否则回到 `pending` 等下一轮 flush。
 */
export function recordOutboxFailure(
  queue: OutboxItem[],
  id: string,
  error: string = '发送失败',
  maxAttempts: number = OUTBOX_MAX_ATTEMPTS,
): { queue: OutboxItem[]; item: OutboxItem | null; exhausted: boolean } {
  const cap =
    Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : OUTBOX_MAX_ATTEMPTS;
  let found: OutboxItem | null = null;
  let exhausted = false;

  const next = normalizeOutbox(queue, UNBOUNDED_OUTBOX).map((item) => {
    if (item.id !== id) return item;
    const attempts = item.attempts + 1;
    const isOut = attempts >= cap;
    const failedItem: OutboxItem = {
      ...item,
      attempts,
      status: isOut ? 'failed' : 'pending',
      error,
    };
    found = failedItem;
    exhausted = isOut;
    return failedItem;
  });

  return { queue: next, item: found, exhausted };
}

/** 直接标 `failed`（纯函数），不依赖上限。 */
export function markOutboxFailed(
  queue: OutboxItem[],
  id: string,
  error: string = '发送失败',
): OutboxItem[] {
  return normalizeOutbox(queue, UNBOUNDED_OUTBOX).map((item) =>
    item.id === id ? { ...item, status: 'failed' as OutboxStatus, error } : item,
  );
}

/** 用户手动重试（纯函数）：置回 `pending`，清零 attempts 与 error。 */
export function retryOutbox(queue: OutboxItem[], id: string): OutboxItem[] {
  return normalizeOutbox(queue, UNBOUNDED_OUTBOX).map((item) => {
    if (item.id !== id) return item;
    const next: OutboxItem = { ...item, status: 'pending', attempts: 0 };
    delete next.error;
    return next;
  });
}

/** 清掉所有失败项（用户主动放弃）（纯函数）。 */
export function clearFailedOutbox(queue: OutboxItem[]): OutboxItem[] {
  return normalizeOutbox(queue, UNBOUNDED_OUTBOX).filter((item) => item.status !== 'failed');
}

/** 队首待发（`pending`）项（纯函数）。 */
export function nextOutboxItem(queue: OutboxItem[]): OutboxItem | null {
  const clean = normalizeOutbox(queue, UNBOUNDED_OUTBOX);
  return clean.find((item) => item.status === 'pending') ?? null;
}

/** 待发（非 failed）条数（纯函数）。 */
export function outboxPendingCount(queue: OutboxItem[]): number {
  return normalizeOutbox(queue, UNBOUNDED_OUTBOX).filter((item) => item.status !== 'failed').length;
}

/**
 * 解析落盘文件：支持 `{v,items}` 与裸数组两种形状；
 * 损坏 JSON 不崩（如实告警后从空队列开始）；
 * **`sending` 一律降级为 `pending`** —— 崩溃/杀进程后的僵尸项必须能重新发出去。
 */
export function parseOutboxFile(raw: string | null): OutboxItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as OutboxFile)?.items)
        ? (parsed as OutboxFile).items
        : [];
    const cleaned: OutboxItem[] = [];
    for (const entry of list) {
      const item = normalizeOutboxItem(entry);
      if (!item) continue;
      cleaned.push(item.status === 'sending' ? { ...item, status: 'pending' } : item);
    }
    return cleaned;
  } catch {
    console.warn('[Outbox] 待发队列解析失败，已忽略损坏数据');
    return [];
  }
}

/**
 * 创建（或读回）一个落盘待发队列。
 *
 * @param storage `undefined` = 自动探测 localStorage；`null` = 纯内存（测试/SSR）。
 * @param capacity 容量上限，超出按 FIFO 淘汰最旧 pending。
 * @param maxAttempts 单项尝试上限。
 */
export function createOutboxQueue(
  storage: StorageLike | null | undefined = undefined,
  capacity: number = OUTBOX_CAPACITY,
  maxAttempts: number = OUTBOX_MAX_ATTEMPTS,
): OutboxQueue {
  const store = storage === undefined ? detectLedgerStorage() : storage;
  const limit =
    Number.isFinite(capacity) && capacity >= 0 ? Math.floor(capacity) : OUTBOX_CAPACITY;
  const cap =
    Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : OUTBOX_MAX_ATTEMPTS;

  let items: OutboxItem[] = [];
  if (store) {
    try {
      items = normalizeOutbox(parseOutboxFile(store.getItem(OUTBOX_KEY)), limit);
    } catch {
      // 隐私模式下 getItem 也可能抛：读不到就从空队列开始（不能因此崩掉连接层）
      items = [];
    }
  }

  const persist = (): void => {
    if (!store) return;
    const file: OutboxFile = { v: OUTBOX_VERSION, items };
    try {
      store.setItem(OUTBOX_KEY, JSON.stringify(file));
    } catch {
      // 配额/隐私模式写失败：本次运行仍以内存为准（用户的字不能被存储异常吃掉）
    }
  };

  return {
    list(): OutboxItem[] {
      return items.map((item) => ({ ...item, args: { ...item.args } }));
    },

    size(): number {
      return items.length;
    },

    pendingCount(): number {
      return items.filter((item) => item.status !== 'failed').length;
    },

    failedCount(): number {
      return items.filter((item) => item.status === 'failed').length;
    },

    nextPending(): OutboxItem | null {
      return items.find((item) => item.status === 'pending') ?? null;
    },

    enqueue(raw: unknown): OutboxEnqueueResult | null {
      const result = enqueueOutbox(items, raw, { limit });
      if (!result) return null;
      items = result.queue;
      persist();
      return { item: result.item, added: result.added, evicted: result.evicted };
    },

    markSending(id: string): OutboxItem | null {
      items = markOutboxSending(items, id);
      persist();
      return items.find((item) => item.id === id) ?? null;
    },

    release(id: string): void {
      items = releaseOutbox(items, id);
      persist();
    },

    remove(id: string): void {
      items = removeOutbox(items, id);
      persist();
    },

    recordFailure(id: string, error: string = '发送失败'): OutboxFailureResult {
      const result = recordOutboxFailure(items, id, error, cap);
      items = result.queue;
      persist();
      return { item: result.item, exhausted: result.exhausted };
    },

    markFailed(id: string, error: string = '发送失败'): void {
      items = markOutboxFailed(items, id, error);
      persist();
    },

    retry(id: string): void {
      items = retryOutbox(items, id);
      persist();
    },

    clear(): void {
      items = [];
      if (!store) return;
      try {
        if (typeof store.removeItem === 'function') store.removeItem(OUTBOX_KEY);
        else store.setItem(OUTBOX_KEY, JSON.stringify({ v: OUTBOX_VERSION, items: [] }));
      } catch {
        // 同上：清理失败不影响内存态
      }
    },

    clearFailed(): void {
      items = clearFailedOutbox(items);
      persist();
    },

    maxAttempts: cap,
  };
}
