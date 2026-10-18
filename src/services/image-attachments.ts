/**
 * 会话图片附件的字节加载与缓存。
 *
 * ## 为什么需要它
 *
 * 🔴 真机实测（2026-10-17）：主机返回的图片**不是 URL**，而是附件引用
 * `{ type:'image', attachment:{ attachmentId, mediaType, bytes, ... } }`。
 * 想显示它必须再发一次 `session/attachment` 把 base64 取回来。
 *
 * 在接通这条链路之前，App 里所有媒体 UI（全屏画廊、保存到手机、分享）
 * 都是"对着空气生效"的 —— 因为根本没有图数据。
 *
 * ## 设计要点
 *
 * 1. **按需加载、只取一次**：同一 attachmentId 复用 `Promise`，避免同图并发重复请求
 *    （一条消息里同一张图可能出现多次）。
 * 2. **失败要能重试**：失败结果**不缓存**，否则一次网络抖动会让这张图永久打不开。
 * 3. **上限保护**：手机内存有限，超上限丢最旧的；且只缓存成功结果。
 * 4. **可测**：不依赖 DOM，注入 fetch 函数即可在 JVM/Node 单测里跑。
 */

/** 加载结果：成功给出 data URL（可直接喂 `<img src>`），失败给出原因。 */
export type ImageLoadState =
  | { status: 'loading' }
  | { status: 'ready'; dataUrl: string; mediaType: string }
  | { status: 'error'; message: string };

/** 默认缓存条数上限 —— 一条会话里几十张图足够，再多说明该走懒加载重取。 */
export const DEFAULT_MAX_ENTRIES = 32;

/** 主机侧图片只可能是这四种（取自 app.asar 的 ImageMediaType zod schema）。 */
const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * 把 base64 拼成 data URL。
 *
 * mediaType 不在白名单时**兜底成 image/png**：宁可显示不出也不要拼出
 * 一个能让浏览器按 text/html 解析的 data URL（那是 XSS 面）。
 */
export function toDataUrl(base64: string, mediaType: string): string {
  const safeType = ALLOWED_MEDIA_TYPES.has(mediaType) ? mediaType : 'image/png';
  return `data:${safeType};base64,${base64}`;
}

export interface ImageAttachmentSource {
  attachmentId: string;
  mediaType: string;
}

export interface ImageLoaderOptions {
  /** 注入的 RPC 调用；签名与 `DshConnection.call` 一致。 */
  call: (method: string, args: Record<string, unknown>) => Promise<unknown>;
  /** 取 base64（从 `session/attachment` 的返回里解出）。 */
  extractBase64: (response: unknown) => string | null;
  /** 构造请求 args。 */
  buildRequest: (sessionId: string, attachmentId: string) => Record<string, unknown>;
  maxEntries?: number;
}

/**
 * 附件字节加载器。
 *
 * 每个会话一个实例即可；`get()` 返回的是**同一份 Promise**（同一张图并发只发一次请求）。
 */
export class ImageAttachmentLoader {
  readonly #call: ImageLoaderOptions['call'];
  readonly #extract: ImageLoaderOptions['extractBase64'];
  readonly #build: ImageLoaderOptions['buildRequest'];
  readonly #max: number;
  /** 成功的 data URL 缓存（LRU：Map 保持插入序，超出时删最旧）。 */
  readonly #cache = new Map<string, string>();
  /** 在途请求：**key 必须含 sessionId**，否则跨会话同 id 会串图。 */
  readonly #inflight = new Map<string, Promise<string>>();

  constructor(opts: ImageLoaderOptions) {
    this.#call = opts.call;
    this.#extract = opts.extractBase64;
    this.#build = opts.buildRequest;
    this.#max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** 取图（有缓存直接返回）。失败时 reject，且**不写缓存**，允许重试。 */
  public load(sessionId: string, ref: ImageAttachmentSource): Promise<string> {
    if (!sessionId || !ref?.attachmentId) {
      return Promise.reject(new Error('缺少 sessionId 或 attachmentId'));
    }
    const key = `${sessionId}::${ref.attachmentId}`;

    const cached = this.#cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const existing = this.#inflight.get(key);
    if (existing !== undefined) return existing;

    const task = (async () => {
      const res = await this.#call('session/attachment', this.#build(sessionId, ref.attachmentId));
      const base64 = this.#extract(res);
      if (!base64) throw new Error('主机未返回图片数据');
      const dataUrl = toDataUrl(base64, ref.mediaType);
      this.#remember(key, dataUrl);
      return dataUrl;
    })();

    this.#inflight.set(key, task);
    // 无论成败都要清在途标记；失败的**不进缓存**，下次可重试
    task.finally(() => {
      this.#inflight.delete(key);
    }).catch(() => {
      /* 吞掉 finally 链上的 rejection，真正的错误由调用方 catch */
    });

    return task;
  }

  /** 只读缓存（不触发加载）；用于同步渲染首帧。 */
  public peek(sessionId: string, attachmentId: string): string | null {
    return this.#cache.get(`${sessionId}::${attachmentId}`) ?? null;
  }

  /** 已成功缓存的条数（诊断/测试用）。 */
  public get size(): number {
    return this.#cache.size;
  }

  /** 在途请求数（诊断/测试用）。 */
  public get pending(): number {
    return this.#inflight.size;
  }

  #remember(key: string, dataUrl: string): void {
    this.#cache.delete(key); // 重新插入以刷新 LRU 位置
    this.#cache.set(key, dataUrl);
    while (this.#cache.size > this.#max) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}
