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
const DEFAULT_DEMO_HOST: HostRecord = {
  id: 'demo-local-host',
  label: 'MacBook Pro (Demo 实例)',
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

  getActiveId(): string | null {
    const saved = localStorage.getItem(ACTIVE_HOST_KEY);
    if (saved && this.find(saved)) {
      return saved;
    }
    const all = this.all();
    const first = all[0]?.id || null;
    if (first) {
      localStorage.setItem(ACTIVE_HOST_KEY, first);
    }
    return first;
  },

  setActiveId(id: string | null): void {
    if (id) {
      localStorage.setItem(ACTIVE_HOST_KEY, id);
      this.touch(id);
    } else {
      localStorage.removeItem(ACTIVE_HOST_KEY);
    }
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
