/**
 * 草稿持久化 —— 零依赖纯逻辑 + 可注入 storage，Node 里可直接单测。
 *
 * 为什么单独一层：
 *  - `localStorage` 在隐私模式 / 配额满时会**抛异常**，直接调用会让整个聊天页白屏；
 *  - 需要"按会话隔离"（切会话不串字）和"恢复时给出可见提示"（静默恢复等于没恢复）。
 *
 * 行为约定（有测试断言）：
 *  1. 按 sessionId 隔离，互不影响；
 *  2. 纯空白文本视为清空草稿（不写空串，避免下次误报"已恢复"）；
 *  3. `loadDraft().restored` 只在确有内容时为 true（UI 据此显示提示）；
 *  4. 读/写异常一律降级到内存存储，绝不向调用方抛错；
 *  5. 单条草稿有长度上限，防止一次超长粘贴把存储打爆。
 */

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DRAFT_PREFIX = 'dsh_chat_draft_v1';
export const DRAFT_MAX_CHARS = 8000;

export interface DraftLoadResult {
  text: string;
  /** true = 确实从存储里恢复出了非空草稿，UI 应给出可见提示。 */
  restored: boolean;
}

/** 内存兜底存储：接口刻意对齐 `localStorage`（含 length/key(i)），方便直接替换。 */
export interface MemoryDraftStorage extends DraftStorage {
  readonly length: number;
  key(index: number): string | null;
}

/** 内存兜底存储（Node 测试 / localStorage 不可用时使用）。 */
export function createMemoryStorage(seed?: Record<string, string>): MemoryDraftStorage {
  const map = new Map<string, string>(seed ? Object.entries(seed) : []);
  return {
    get length() {
      return map.size;
    },
    key: (index) => (index >= 0 && index < map.size ? Array.from(map.keys())[index] : null),
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

let memoryFallback: DraftStorage | null = null;
let cachedStorage: DraftStorage | null = null;

function getMemoryFallback(): DraftStorage {
  if (!memoryFallback) memoryFallback = createMemoryStorage();
  return memoryFallback;
}

function isUsableStorage(candidate: unknown): candidate is DraftStorage {
  if (!candidate || typeof candidate !== 'object') return false;
  const store = candidate as Record<string, unknown>;
  return (
    typeof store.getItem === 'function' &&
    typeof store.setItem === 'function' &&
    typeof store.removeItem === 'function'
  );
}

/**
 * 取当前可用的存储：优先 `localStorage`（并**探测可写**，隐私模式会在写时抛），
 * 否则退回内存实现 —— 退化了不静默：控制台有 warn。
 */
export function resolveStorage(): DraftStorage {
  if (cachedStorage) return cachedStorage;
  try {
    const globalStore = (globalThis as Record<string, unknown>).localStorage;
    if (isUsableStorage(globalStore)) {
      const probeKey = `${DRAFT_PREFIX}:__probe__`;
      globalStore.setItem(probeKey, '1');
      globalStore.removeItem(probeKey);
      cachedStorage = globalStore;
      return globalStore;
    }
  } catch (error) {
    console.warn('[draft] localStorage 不可写，草稿改用内存存储（退出即失效）：', error);
  }
  cachedStorage = getMemoryFallback();
  return cachedStorage;
}

/** 存储键：按会话隔离。 */
export function draftKey(sessionId: string): string {
  const id = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : 'default';
  return `${DRAFT_PREFIX}:${id}`;
}

/** 保存草稿；空/纯空白 = 清空。返回是否真正落到存储上（false = 已降级到内存）。 */
export function saveDraft(
  sessionId: string,
  text: string,
  storage: DraftStorage = resolveStorage(),
): boolean {
  const key = draftKey(sessionId);
  const payload = typeof text === 'string' && text.trim() !== '' ? text.slice(0, DRAFT_MAX_CHARS) : null;

  try {
    if (payload === null) storage.removeItem(key);
    else storage.setItem(key, payload);
    return true;
  } catch (error) {
    console.warn('[draft] 草稿写入失败，降级到内存存储：', error);
    const fallback = getMemoryFallback();
    try {
      if (payload === null) fallback.removeItem(key);
      else fallback.setItem(key, payload);
    } catch {
      // 内存实现不会抛；这里只是兜底，真到了这一步也无能为力
    }
    return false;
  }
}

/** 读取草稿；任何异常都返回空而不是抛出。 */
export function loadDraft(sessionId: string, storage: DraftStorage = resolveStorage()): DraftLoadResult {
  try {
    const text = storage.getItem(draftKey(sessionId));
    if (typeof text === 'string' && text.trim() !== '') {
      return { text, restored: true };
    }
  } catch (error) {
    console.warn('[draft] 草稿读取失败：', error);
  }
  return { text: '', restored: false };
}

/** 打字时的落盘间隔。太短仍会卡住 WebView 的同步 setItem，太长则切走可能丢最后几个字。 */
export const DRAFT_SAVE_DELAY_MS = 300;

export interface DraftClock {
  schedule(fn: () => void, delayMs: number): number;
  cancel(id: number): void;
}

const defaultDraftClock: DraftClock = {
  schedule(fn, delayMs) {
    return setTimeout(fn, delayMs) as unknown as number;
  },
  cancel(id) {
    clearTimeout(id);
  },
};

/**
 * 输入框草稿写入器。
 *
 * 每个按键都同步 `localStorage.setItem` 会让 WebView 输入顿一下。
 * `schedule` 合并成一次写入；`flush` 立刻落盘并作废还没跑的定时器，
 * 避免旧内容在发送成功或切会话之后把草稿写回去。
 */
export function createDraftScheduler(
  save: (sessionId: string, text: string) => boolean = (sessionId, text) => saveDraft(sessionId, text),
  clock: DraftClock = defaultDraftClock,
) {
  let timer: number | null = null;
  let generation = 0;
  let pending: { sessionId: string; text: string } | null = null;

  const cancel = () => {
    generation += 1;
    pending = null;
    if (timer !== null) {
      clock.cancel(timer);
      timer = null;
    }
  };

  return {
    schedule(sessionId: string, text: string, delayMs = DRAFT_SAVE_DELAY_MS) {
      const token = ++generation;
      pending = { sessionId, text };
      if (timer !== null) clock.cancel(timer);
      timer = clock.schedule(() => {
        if (token !== generation) return;
        timer = null;
        const job = pending;
        pending = null;
        if (job) save(job.sessionId, job.text);
      }, delayMs);
    },
    /** 立刻写入这一份文本，并作废排队中的旧写入。 */
    flush(sessionId: string, text: string) {
      cancel();
      return save(sessionId, text);
    },
    /**
     * 只丢掉这一会话还没落盘的写入。
     * 发送成功时用它，避免把刚发出去的字写回草稿；
     * 另一会话正在排队的草稿不动。
     */
    drop(sessionId: string) {
      if (pending && pending.sessionId !== sessionId) return;
      cancel();
    },
    cancel,
  };
}

/** 清空草稿（发送成功后调用）。 */
export function clearDraft(sessionId: string, storage: DraftStorage = resolveStorage()): void {
  try {
    storage.removeItem(draftKey(sessionId));
  } catch (error) {
    console.warn('[draft] 草稿清除失败：', error);
  }
}

/** 在会话列表上列出所有有草稿的会话 id（供"有未发送草稿"标记使用）。 */
export function listDraftSessionIds(storage: DraftStorage = resolveStorage()): string[] {
  const anyStore = storage as unknown as { length?: number; key?: (index: number) => string | null };
  if (typeof anyStore.length !== 'number' || typeof anyStore.key !== 'function') return [];
  const ids: string[] = [];
  try {
    for (let i = 0; i < anyStore.length; i += 1) {
      const key = anyStore.key(i);
      if (typeof key === 'string' && key.startsWith(`${DRAFT_PREFIX}:`)) {
        ids.push(key.slice(DRAFT_PREFIX.length + 1));
      }
    }
  } catch (error) {
    console.warn('[draft] 草稿列表读取失败：', error);
  }
  return ids;
}

// ── 折叠展开状态（按消息 key 记住；切走会话再回来不丢）──────────────────────
//
// 只存"展开过的 message key"列表：
//   - 默认折叠是**大多数**（超长消息几乎都是 runtime context，没人想一直看），
//     记录例外比记录全集小得多；
//   - 有上限，避免长会话把 localStorage 塞满（超限丢最旧的）。

export const EXPANDED_PREFIX = 'dsh_chat_expanded_v1';
export const EXPANDED_MAX_KEYS = 200;

/** 存储键：按会话隔离。 */
export function expandedKey(sessionId: string): string {
  const id = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : 'default';
  return `${EXPANDED_PREFIX}:${id}`;
}

/** 读取该会话里"被手动展开过"的消息 key（顺序 = 记录顺序，末尾最新）。 */
export function loadExpandedKeys(
  sessionId: string,
  storage: DraftStorage = resolveStorage(),
): string[] {
  try {
    const raw = storage.getItem(expandedKey(sessionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((key): key is string => typeof key === 'string' && key !== '')
      .slice(-EXPANDED_MAX_KEYS);
  } catch (error) {
    console.warn('[draft] 展开状态读取失败（按未展开处理）：', error);
    return [];
  }
}

/** 保存展开状态；空集合 = 删除键（不留垃圾）。返回是否成功落盘。 */
export function saveExpandedKeys(
  sessionId: string,
  keys: Iterable<string>,
  storage: DraftStorage = resolveStorage(),
): boolean {
  try {
    const list: string[] = [];
    for (const key of keys) {
      if (typeof key === 'string' && key !== '') list.push(key);
    }
    if (list.length === 0) storage.removeItem(expandedKey(sessionId));
    else storage.setItem(expandedKey(sessionId), JSON.stringify(list.slice(-EXPANDED_MAX_KEYS)));
    return true;
  } catch (error) {
    console.warn('[draft] 展开状态写入失败（本次会话内仍然有效）：', error);
    return false;
  }
}