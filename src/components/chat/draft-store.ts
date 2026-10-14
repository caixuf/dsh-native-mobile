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