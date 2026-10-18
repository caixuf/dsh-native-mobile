/**
 * 待发消息队列 —— **纯函数**，零依赖，可在 Node 里直接单测
 * （`scripts/test-message-queue.mjs`，见 `npm run test:message-queue`）。
 *
 * 背景（`docs/v0.2-handover.md` §3）：
 *  - 任务在跑时用户仍应能输入；按发送即**入队**，而不是干等（原 Kotlin
 *    `Composer(enabled = !state.running)` 的根因）。
 *  - 发送失败**不能丢用户的字**：失败项留在队列里（`markFailed`），
 *    由用户显式重试或删除。
 *
 * 设计约定（都有对应测试断言）：
 *  1. 入队 == 追加到队尾，**先进先出**；
 *  2. **同 id 幂等**：重复入队同一个 id 是 no-op（返回 added:false，队列不变）；
 *  3. **重复文本不去重**：两条不同 id 的相同文本都必须保留（用户确实想发两遍）；
 *  4. 上限淘汰从**最旧**开始，但**失败项优先保留** —— 只有全是失败项时才淘汰失败项
 *     （"失败项保留"是硬要求，不能被上限静默吃掉）；
 *  5. 出队后序号必须**重排**成连续的 1..n（UI 直接读 `seq`，不要自己数）；
 *  6. 所有函数不可变：不修改入参，只返回新数组/新对象。
 */

export type QueueItemStatus = 'pending' | 'failed';

export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: number;
  /** 附带的图片（运行中入队出队时不丢弃） */
  image?: { data: string; mediaType: string };
  /** 缺省视为 'pending'（App 只传 id/text/createdAt 时同样可用）。 */
  status?: QueueItemStatus;
  /** 最近一次失败原因，仅 status==='failed' 时有意义。 */
  error?: string;
  /** 累计尝试次数（重试只增不清）。 */
  attempts?: number;
}

/** 带序号的队列项（UI 展示用；序号从 1 开始、出队后自动重排）。 */
export interface SequencedQueuedMessage extends QueuedMessage {
  seq: number;
}

export interface EnqueueResult {
  queue: QueuedMessage[];
  /** 实际入库的那一项（同 id 幂等命中时返回已存在的那一项）。 */
  item: QueuedMessage;
  added: boolean;
  /** 因超上限被淘汰的项（按淘汰顺序），供 UI 提示"队列已满，最早的已丢弃"。 */
  evicted: QueuedMessage[];
}

export interface TakeNextResult {
  item: QueuedMessage | null;
  queue: QueuedMessage[];
}

export interface QueueOptions {
  limit?: number;
}

/** 默认上限：移动端一屏能扫完，且避免无限堆积。 */
export const DEFAULT_QUEUE_LIMIT = 20;

/** 单条文本上限（防止一条超长粘贴把 localStorage / UI 拖死）。 */
export const MAX_ITEM_TEXT = 8000;

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

// ── 基础清洗 ────────────────────────────────────────────────────────────────

/** 把任意输入收敛成合法队列项；非法（空 id / 纯空白文本且无图片）返回 null。 */
export function normalizeItem(raw: unknown): QueuedMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const id = typeof source.id === 'string' ? source.id.trim() : '';
  const rawText = typeof source.text === 'string' ? source.text : '';
  const rawImage = source.image as { data?: unknown; mediaType?: unknown } | undefined;
  const image =
    rawImage && typeof rawImage.data === 'string' && typeof rawImage.mediaType === 'string'
      ? { data: rawImage.data, mediaType: rawImage.mediaType }
      : undefined;

  if (!id || (rawText.trim() === '' && !image)) return null;

  const createdAt =
    typeof source.createdAt === 'number' && Number.isFinite(source.createdAt) ? source.createdAt : 0;

  const item: QueuedMessage = {
    id,
    text: rawText.slice(0, MAX_ITEM_TEXT),
    createdAt,
    status: source.status === 'failed' ? 'failed' : 'pending',
    ...(image ? { image } : {}),
  };

  if (typeof source.error === 'string' && source.error) item.error = source.error;
  if (typeof source.attempts === 'number' && Number.isFinite(source.attempts) && source.attempts > 0) {
    item.attempts = Math.floor(source.attempts);
  }

  return item;
}

/** 同 id 只保留**第一次**出现的那一项（后续重复项丢弃，保证幂等）。 */
export function dedupeById(items: QueuedMessage[]): QueuedMessage[] {
  const seen = new Set<string>();
  const out: QueuedMessage[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * 超上限时淘汰最旧的项，但**失败项优先保留**。
 * 返回新数组，不改入参。
 */
export function applyLimit(
  queue: QueuedMessage[],
  limit: number = DEFAULT_QUEUE_LIMIT,
): { queue: QueuedMessage[]; evicted: QueuedMessage[] } {
  const max = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_QUEUE_LIMIT;
  if (queue.length <= max) return { queue: queue.slice(), evicted: [] };

  let overflow = queue.length - max;
  const kept: QueuedMessage[] = [];
  const evicted: QueuedMessage[] = [];

  // 第一轮：只淘汰最旧的 pending（失败项先保住）
  for (const item of queue) {
    if (overflow > 0 && item.status !== 'failed') {
      evicted.push(item);
      overflow -= 1;
      continue;
    }
    kept.push(item);
  }

  // 第二轮：全是失败项、仍超限时，只能按最旧淘汰
  if (overflow > 0) {
    const keptFailed: QueuedMessage[] = [];
    for (const item of kept) {
      if (overflow > 0) {
        evicted.push(item);
        overflow -= 1;
        continue;
      }
      keptFailed.push(item);
    }
    return { queue: keptFailed, evicted };
  }

  return { queue: kept, evicted };
}

/** 清洗 + 去重 + 截断；用于把外部（props / localStorage）来的数据收敛成合法队列。 */
export function normalizeQueue(input: unknown, limit: number = DEFAULT_QUEUE_LIMIT): QueuedMessage[] {
  const list = Array.isArray(input) ? input : [];
  const cleaned: QueuedMessage[] = [];
  for (const raw of list) {
    const item = normalizeItem(raw);
    if (item) cleaned.push(item);
  }
  return applyLimit(dedupeById(cleaned), limit).queue;
}

// ── 入队 / 出队 ─────────────────────────────────────────────────────────────

/**
 * 入队。同 id 幂等：命中已存在项时原样返回（`added:false`，队列内容不变）。
 * 纯空白文本或空 id 会抛错 —— 静默丢弃用户输入正是我们要防的事故。
 */
export function enqueue(
  queue: QueuedMessage[],
  raw: unknown,
  options: QueueOptions = {},
): EnqueueResult {
  const base = normalizeQueue(queue, UNBOUNDED);
  const item = normalizeItem(raw);
  if (!item) throw new TypeError('enqueue: 队列项必须形如 { id, text } 且 text 非纯空白');

  const existing = base.find((entry) => entry.id === item.id);
  if (existing) {
    // 幂等：重复入队同一个 id 不改变队列（也不覆盖已有文本/状态）
    return { queue: base, item: existing, added: false, evicted: [] };
  }

  const limited = applyLimit([...base, item], options.limit ?? DEFAULT_QUEUE_LIMIT);
  return { queue: limited.queue, item, added: true, evicted: limited.evicted };
}

/** 按 id 出队；不存在时返回等值副本（仍然不修改入参）。 */
export function removeQueued(queue: QueuedMessage[], id: string): QueuedMessage[] {
  return normalizeQueue(queue, UNBOUNDED).filter((item) => item.id !== id);
}

/** 取队首**可发送**（status !== 'failed'）的一项并出队；失败项被跳过、留在队里。 */
export function takeNext(queue: QueuedMessage[]): TakeNextResult {
  const clean = normalizeQueue(queue, UNBOUNDED);
  const index = clean.findIndex((item) => item.status !== 'failed');
  if (index < 0) return { item: null, queue: clean };
  return {
    item: clean[index],
    queue: [...clean.slice(0, index), ...clean.slice(index + 1)],
  };
}

// ── 状态流转（失败绝不丢原文）───────────────────────────────────────────────

/** 标记失败：**保留 text**，附上错误原因并累加尝试次数。 */
export function markFailed(
  queue: QueuedMessage[],
  id: string,
  error: string = '发送失败',
): QueuedMessage[] {
  return normalizeQueue(queue, UNBOUNDED).map((item) => {
    if (item.id !== id) return item;
    const next: QueuedMessage = {
      ...item,
      status: 'failed',
      error,
      attempts: (item.attempts ?? 0) + 1,
    };
    return next;
  });
}

/** 重试：把失败项改回 pending（text 从没动过），清掉错误信息。 */
export function retryQueued(queue: QueuedMessage[], id: string): QueuedMessage[] {
  return normalizeQueue(queue, UNBOUNDED).map((item) => {
    if (item.id !== id) return item;
    const next: QueuedMessage = { ...item, status: 'pending' };
    delete next.error;
    return next;
  });
}

/** 清掉所有失败项（用户主动放弃）。 */
export function clearFailed(queue: QueuedMessage[]): QueuedMessage[] {
  return normalizeQueue(queue, UNBOUNDED).filter((item) => item.status !== 'failed');
}

// ── 展示 / 重排 ─────────────────────────────────────────────────────────────

/** 序号从 `start` 开始连续编号；出队（removeQueued / takeNext）后调用即得到重排结果。 */
export function resequence(queue: QueuedMessage[], start: number = 1): SequencedQueuedMessage[] {
  const base = Number.isFinite(start) ? Math.floor(start) : 1;
  return normalizeQueue(queue, UNBOUNDED).map((item, index) => ({ ...item, seq: base + index }));
}

/** 上下移动一项（delta 为 -1/+1 等），越界时夹紧到边界，不抛错。 */
export function moveQueued(queue: QueuedMessage[], id: string, delta: number): QueuedMessage[] {
  const clean = normalizeQueue(queue, UNBOUNDED);
  const from = clean.findIndex((item) => item.id === id);
  if (from < 0) return clean;
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const to = Math.min(clean.length - 1, Math.max(0, from + step));
  if (to === from) return clean;
  const next = clean.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** 待发（非失败）条数 —— 用于"队列就绪，任务结束后自动发"的提示。 */
export function pendingCount(queue: QueuedMessage[]): number {
  return normalizeQueue(queue, UNBOUNDED).filter((item) => item.status !== 'failed').length;
}

/** 失败条数。 */
export function failedCount(queue: QueuedMessage[]): number {
  return normalizeQueue(queue, UNBOUNDED).filter((item) => item.status === 'failed').length;
}

/**
 * 生成队列 id（确定性，便于测试）：
 * `q-<时间戳>-<序号>`；同 (now, seq) 必然同 id，配合"同 id 幂等"用于防重复点击。
 */
export function createQueueId(now: number, seq: number, prefix: string = 'q'): string {
  const ts = Number.isFinite(now) ? Math.floor(now) : 0;
  const n = Number.isFinite(seq) ? Math.floor(seq) : 0;
  return `${prefix}-${ts}-${n}`;
}

// ── 超长消息折叠（聊天可读性）────────────────────────────────────────────────
//
// 真机实测：打开一个 agent 会话时，一条 1.2 万字的用户消息（runtime context）
// 整块渲染，屏幕瞬间被淹没。折叠逻辑必须是**纯函数**，UI 只负责渲染。
//
// 阈值口径（都是"超过才折叠"）：
//   - 字数 > 600（按 **码点** 计，避免把 emoji/代理对从中间切开）
//   - 或行数 > 12
// 折叠后展示前 6 行、且最多 600 字（两条上限取更短的那个）。

/** 触发折叠的字数上限。 */
export const COLLAPSE_CHAR_THRESHOLD = 600;
/** 触发折叠的行数上限。 */
export const COLLAPSE_LINE_THRESHOLD = 12;
/** 折叠态展示的行数。 */
export const COLLAPSE_PREVIEW_LINES = 6;
/** 折叠态最多展示的字符数（防止"一行 600 字"把预览也撑爆）。 */
export const COLLAPSE_PREVIEW_CHARS = 600;

export interface CollapseThresholds {
  charThreshold?: number;
  lineThreshold?: number;
}

export interface CollapseOptions extends CollapseThresholds {
  maxLines?: number;
  maxChars?: number;
}

export interface CollapsePreview {
  /** 是否需要折叠。false 时 `preview === 规范化后的原文`。 */
  collapsed: boolean;
  /** 折叠态应渲染的预览文本（已把 CRLF 归一为 LF）。 */
  preview: string;
  hiddenChars: number;
  hiddenLines: number;
  totalChars: number;
  totalLines: number;
  /** 折叠后仍可见的行数（预览实际行数，≤ maxLines）。 */
  previewLines: number;
}

/** 按**码点**计字数：`'👍'.length === 2` 但这里算 1，切预览时不会切出半个 emoji。 */
export function countChars(text: string | null | undefined): number {
  if (typeof text !== 'string' || text === '') return 0;
  return Array.from(text).length;
}

/** 行数：空串算 0 行；`a\nb` 算 2 行；CRLF 归一后统计。 */
export function countLines(text: string | null | undefined): number {
  if (typeof text !== 'string' || text === '') return 0;
  return text.replace(/\r\n?/g, '\n').split('\n').length;
}

/** 单条正文是否需要折叠（字数超限或行数超限）。 */
export function shouldCollapse(
  text: string | null | undefined,
  options: CollapseThresholds = {},
): boolean {
  const charThreshold = options.charThreshold ?? COLLAPSE_CHAR_THRESHOLD;
  const lineThreshold = options.lineThreshold ?? COLLAPSE_LINE_THRESHOLD;
  const total = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
  return countChars(total) > charThreshold || countLines(total) > lineThreshold;
}

/**
 * 计算折叠预览。**不修改入参**，任何输入（null/undefined/空串/超长）都返回结构化结果。
 */
export function collapsePreview(
  text: string | null | undefined,
  options: CollapseOptions = {},
): CollapsePreview {
  const normalized = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
  const totalChars = countChars(normalized);
  const totalLines = countLines(normalized);
  const collapsed = shouldCollapse(normalized, options);

  if (!collapsed) {
    return {
      collapsed: false,
      preview: normalized,
      hiddenChars: 0,
      hiddenLines: 0,
      totalChars,
      totalLines,
      previewLines: totalLines,
    };
  }

  const maxLines = Math.max(1, Math.floor(options.maxLines ?? COLLAPSE_PREVIEW_LINES));
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? COLLAPSE_PREVIEW_CHARS));

  let preview = normalized.split('\n').slice(0, maxLines).join('\n');
  if (countChars(preview) > maxChars) {
    preview = Array.from(preview).slice(0, maxChars).join('');
  }

  const previewChars = countChars(preview);
  const previewLines = countLines(preview);

  return {
    collapsed: true,
    preview,
    hiddenChars: Math.max(0, totalChars - previewChars),
    hiddenLines: Math.max(0, totalLines - previewLines),
    totalChars,
    totalLines,
    previewLines,
  };
}

/**
 * 折叠按钮文案：始终带上**总字数**（用户要据此判断"值不值得展开"）。
 * 非折叠态返回空串（调用方据此不渲染按钮）。
 */
export function expandLabel(result: CollapsePreview): string {
  if (!result.collapsed) return '';
  const chars = `共 ${result.totalChars} 字`;
  if (result.hiddenLines > 0) return `展开全部（${chars} / ${result.totalLines} 行）`;
  return `展开全部（${chars}）`;
}