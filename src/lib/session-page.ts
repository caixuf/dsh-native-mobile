/**
 * `session.page`（读会话记录）的请求构造与错误处理 —— 抽出来是为了**可测**。
 *
 * ## 这个文件装着两个真实事故（2026-10-14 真主机实测）
 *
 * 现象都是同一个：**会话能打开、聊天记录永远空白**。但根因是两层，缺一条都修不好：
 *
 * ### 1. `address` 必须带 `kind`
 *
 * 真主机要求：
 * ```
 * {kind:'session',  sessionId}   普通会话
 * {kind:'subagent', …}           子代理会话（必须带 durable parent）
 * ```
 * 只传 `{sessionId}` 会被边界校验直接拒：
 * `wire field "request" failed boundary validation`。
 *
 * 为什么长期没被发现：仓库里的 `check-all-endpoints.mjs` / `verify-rendering.mjs` /
 * `public-write-test.mjs` **一直**是带 `kind` 的 —— 脚本知道、App 不知道。
 * 所以这类形状必须有**共用构造器**，而不是两边各写一遍。
 *
 * ### 2. `throughSeq` 不能写死一个大值
 *
 * 主机对越界的 `throughSeq` 会**报错并顺带给出真实 cursor**：
 * ```
 * session page through seq 1000000 is past cursor 1653
 * ```
 * 旧代码把 `1000000` 写死 → 每次翻页必失败。正解就是主机给的那条路：
 * 先用大值探，从错误信息里读回 cursor 再取一次（仓库那个 45/45 的巡检脚本也这么做）。
 * 实测这一改能读出 **234 条**记录。
 */

/** `session.page` 的一条记录（真主机返回形状，见 docs/api-contract.md）。 */
export interface ChatPageRecord {
  seq?: number;
  event?: {
    type?: string;
    seq?: number;
    data?: {
      name?: string;
      callId?: string;
      arguments?: string;
      result?: string;
      isError?: boolean;
      message?: { content?: Array<{ text?: string }> };
      /**
       * ⚠️ 真主机上两种事件的载荷形状**不一样**：
       *   assistant/message → `{ message: { content: [...] } }`
       *   user/message      → `{ content: [...] }`（没有 message 包装）
       * 只读 `message.content` 会让用户自己发的指令渲染成**空气泡**。
       */
      content?: unknown;
    };
  };
}

export interface ChatPageResponse {
  records?: ChatPageRecord[];
}

/** 用来"探" cursor 的越界值：主机一定会拒绝，并在错误里告诉真实值。 */
export const CURSOR_PROBE = 1_000_000;

/**
 * 不是"对话气泡"的事件类型前缀。
 *
 * 真主机实测：`system/message` 记录里装着**整段系统提示词**（含内部工具说明），
 * 旧实现把所有记录都当气泡渲染 → 一个 21 条记录的新会话能刷出 16 张助手卡，
 * 其中 14 张是空卡或那段系统词，真正的对话被淹没。
 */
const NON_DIALOG_PREFIXES = ['system/', 'step/', 'llm/', 'turn/', 'request/'];

/** 工具事件：即使正文为空也要渲染（ChatScreen 靠 toolName/toolArgs 画卡片）。 */
export function isToolEvent(kind: string): boolean {
  return kind === 'tool/call' || kind === 'tool/result';
}

/** 该事件是否应该出现在聊天时间线里。 */
export function isDialogEvent(kind: string): boolean {
  if (!kind) return false;
  if (isToolEvent(kind)) return true;
  if (NON_DIALOG_PREFIXES.some((prefix) => kind.startsWith(prefix))) return false;
  // 只认消息类事件；不认识的类型宁可不渲染，也别把内部事件刷给用户看
  return kind.endsWith('/message');
}

/**
 * 从 `content` 数组里取**真正的正文**。
 *
 * 🔴 P0（2026-10-14 真机实测）：真主机的 assistant 消息可能是
 * `[{type:'reasoning',text:'…思考…'}, {type:'text',text:'真正的回答'}]`。
 * 旧实现写死 `content[0].text` —— 模型只要先输出思考段，
 * App 就把**模型私有推理当成回答显示**，而真正的正文永远看不到。
 * 实测同一脚本 6 轮里失败 1 轮（模型不是每轮都输出 reasoning），所以表现为**间歇性答非所问**。
 *
 * 这里改为：跳过 `reasoning`/`thinking`，把其余文本段全部拼接。
 */
export function collectMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.trim()) texts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const record = part as { type?: unknown; text?: unknown };
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'reasoning' || type === 'thinking') continue; // 私有推理不是回答
    if (typeof record.text !== 'string' || !record.text.trim()) continue;
    // 未标类型 / text / output_text / input_text 都算正文；其余（image、tool_use…）跳过
    if (type && type !== 'text' && type !== 'output_text' && type !== 'input_text') continue;
    texts.push(record.text);
  }
  return texts.join('\n\n').trim();
}

/**
 * 单独的"思考"段（如果有）。
 *
 * 不显示它，但也不是丢掉 —— 需要时可折叠展示。当前只把正文当回答，
 * 避免把私有推理误当答案。
 */
export function collectReasoningText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type !== 'reasoning' && record.type !== 'thinking') continue;
    if (typeof record.text === 'string' && record.text.trim()) texts.push(record.text);
  }
  return texts.join('\n\n').trim();
}

export interface SessionAddressSource {
  sessionId: string;
  isSubagent?: boolean;
  parentSessionId?: string | null;
}

/**
 * 由会话行构造 `session.page` 的 address。
 *
 * ⚠️ 子代理会话必须带 durable parent；不带会被主机拒
 * （`subagent Sessions require their durable parent address`）。
 * 判据只能用 `origin`/`isSubagent` —— `session.fork` 出来的普通会话同样带
 * `parentSessionId`，它按裸 sessionId 打开是正常的，用 parentSessionId 判据会误伤。
 */
export function sessionAddress(session: SessionAddressSource): Record<string, unknown> {
  if (session.isSubagent) {
    return {
      kind: 'subagent',
      sessionId: session.sessionId,
      parentSessionId: session.parentSessionId ?? undefined,
    };
  }
  return { kind: 'session', sessionId: session.sessionId };
}

/** `session.page` 的 args（真主机形参名是 `request`）。 */
export function pageRequest(
  address: Record<string, unknown>,
  throughSeq: number,
  maxMessages = 50,
): { request: { address: Record<string, unknown>; throughSeq: number; maxMessages: number } } {
  return { request: { address, throughSeq, maxMessages } };
}

/**
 * 从主机报错里读回真实 cursor。
 * @returns cursor 数值；不是这类错误就返回 null（调用方应原样抛出）。
 */
export function cursorFromError(message: unknown): number | null {
  if (typeof message !== 'string') return null;
  const match = /past cursor (\d+)/.exec(message);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 取一页会话记录：先探 cursor，失败则用主机给的真实 cursor 重试一次。
 *
 * @param call 注入的 RPC 调用（便于测试与复用；签名与 `DshConnection.call` 一致）
 */
export async function fetchChatPage(
  call: (method: string, args: Record<string, unknown>) => Promise<unknown>,
  session: SessionAddressSource,
): Promise<ChatPageResponse> {
  const address = sessionAddress(session);
  try {
    return (await call('session.page', pageRequest(address, CURSOR_PROBE))) as ChatPageResponse;
  } catch (err) {
    const cursor = cursorFromError((err as Error)?.message);
    if (cursor === null) throw err;
    return (await call('session.page', pageRequest(address, cursor))) as ChatPageResponse;
  }
}