/**
 * 过程状态 —— 把「正在干什么」从事件流里推出来。
 *
 * 🔴 为什么需要它：GUI 里能看到「已完成分析 / 正在分析请求 / 深度搜索中，用时 1分56秒」，
 * 而 App 此前把 `step/*`、`turn/*`、`request/*` 全部过滤掉 —— 只剩工具卡，
 * 用户看不出**进度到哪一步、卡了多久、用的哪个模型**。
 *
 * 事件词表来自 2026-10-15 真主机抓包（`session/follow` 一次 3 步任务的全部 32 条）：
 *
 *   agent/inbox/spliced  { target, start, inserted, removedCount }
 *   turn/start           { turn }
 *   step/start|end       { turn, step }                      ← 步骤边界（GUI 的"第 N 步"）
 *   request/context      { provider, model, contextWindow }  ← 用的是哪个模型
 *   request/header       { header, reason }                  ← 内容很大，不进状态
 *   assistant/message    { turn, step, message, usage, stream }
 *   tool/call            { turn, step, callId, name, arguments }
 *   tool/result          { turn, step, message, meta }
 *   turn/end             { turn, reason }
 *
 * 纯函数、无副作用：App 从 follow 流每收到一条事件就 reduce 一次，界面只读结果。
 */

/** 过程阶段。 */
import { toolActionLabel } from './tool-labels';

export type ActivityPhase =
  | 'idle' // 没有正在跑的轮次
  | 'thinking' // 模型在推理（assistant/message 里有 reasoning，或 request/context 刚到）
  | 'tool' // 正在等某个工具返回
  | 'step' // 步骤之间（步已开、模型还没吐东西）
  | 'finalizing'; // turn/end 之前收尾

export interface ActivityState {
  phase: ActivityPhase;
  /** 当前轮次号（turn/start 的 data.turn）。 */
  turn: number | null;
  /** 当前步骤号（step/start 的 data.step）。 */
  step: number | null;
  /** 本轮已完成的步骤数（step/end 计数）。 */
  stepsDone: number;
  /** 正在等结果的工具名（tool/call 的 data.name）。 */
  toolName: string | null;
  /** 该工具从调用到结果的毫秒数（拿到结果时算好）。 */
  toolMs: number | null;
  /** 本次调用开始的时间戳（真实时间，用于"已等待"）。 */
  toolStartedAt: number | null;
  /** 本轮开始的时间戳。 */
  turnStartedAt: number | null;
  /** 上一条 assistant 消息的 token 用量（有 usage 时才有）。 */
  usage: { inputTokens?: number; outputTokens?: number } | null;
  /**
   * 本轮累计 token（多次 assistant/message 累加）。
   * `assistant/message` 的 usage 每次只带**该次**用量，单看最后一次会严重低估。
   */
  tokensIn: number;
  tokensOut: number;
  /** 本轮工具调用次数。 */
  toolCalls: number;
  /** 本轮所有工具耗时之和（毫秒）。 */
  toolTotalMs: number;
  /** 正在用的模型（request/context）。 */
  provider: string | null;
  model: string | null;
  /** 本轮最新的思考摘要（reasoning 开头），最多 ~120 字。 */
  thinking: string | null;
}

export function emptyActivity(): ActivityState {
  return {
    phase: 'idle',
    turn: null,
    step: null,
    stepsDone: 0,
    toolName: null,
    toolMs: null,
    toolStartedAt: null,
    turnStartedAt: null,
    usage: null,
    tokensIn: 0,
    tokensOut: 0,
    toolCalls: 0,
    toolTotalMs: 0,
    provider: null,
    model: null,
    thinking: null,
  };
}

/** 只关心这些前缀——其余事件不影响"在干什么"。 */
export function isProcessEvent(kind: string): boolean {
  return (
    kind === 'turn/start' ||
    kind === 'turn/end' ||
    kind === 'step/start' ||
    kind === 'step/end' ||
    kind === 'tool/call' ||
    kind === 'tool/result' ||
    kind === 'request/context' ||
    kind === 'assistant/message'
  );
}

function nowMs(time: unknown): number | null {
  return typeof time === 'number' && Number.isFinite(time) && time > 0 ? time : null;
}

function shorten(text: string, max = 120): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 用一条事件推进过程状态（不可变，返回新对象）。
 *
 * @param prev 之前的状态
 * @param event `{ type, seq, time, data }`（与 follow 流同形）
 * @param nowMsNow 当前时刻；缺省用事件自带的 time
 */
export function applyActivityEvent(prev: ActivityState, event: unknown, nowMsNow?: number): ActivityState {
  const ev = event as { type?: string; time?: number; data?: Record<string, unknown> } | null;
  if (!ev || !ev.type) return prev;
  const data = (ev.data || {}) as Record<string, never>;
  const at = nowMsNow ?? nowMs(ev.time) ?? Date.now();
  const next: ActivityState = { ...prev };

  switch (ev.type) {
    case 'turn/start':
      next.phase = 'step';
      next.turn = typeof data.turn === 'number' ? data.turn : prev.turn;
      next.step = null;
      next.stepsDone = 0;
      next.toolName = null;
      next.toolMs = null;
      next.toolStartedAt = null;
      next.turnStartedAt = at;
      next.usage = null;
      next.tokensIn = 0;
      next.tokensOut = 0;
      next.toolCalls = 0;
      next.toolTotalMs = 0;
      next.thinking = null;
      return next;

    case 'turn/end':
      next.phase = 'idle';
      next.toolName = null;
      next.thinking = null;
      return next;

    case 'step/start':
      next.phase = 'step';
      next.step = typeof data.step === 'number' ? data.step : prev.step;
      next.toolName = null;
      next.toolMs = null;
      return next;

    case 'step/end':
      next.stepsDone += 1;
      next.phase = 'thinking';
      return next;

    case 'request/context': {
      if (typeof data.provider === 'string') next.provider = data.provider;
      if (typeof data.model === 'string') next.model = data.model;
      return next;
    }

    case 'tool/call':
      next.phase = 'tool';
      next.toolName = typeof data.name === 'string' ? data.name : null;
      next.toolStartedAt = at;
      next.toolMs = null;
      next.toolCalls += 1;
      return next;

    case 'tool/result': {
      // data.message.isError 存在与否不影响阶段，只影响是否算成功
      next.phase = 'thinking';
      next.toolMs = prev.toolStartedAt ? Math.max(0, at - prev.toolStartedAt) : null;
      if (next.toolMs !== null) next.toolTotalMs += next.toolMs;
      next.toolStartedAt = null;
      return next;
    }

    case 'assistant/message': {
      const message = (data.message || {}) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const content = Array.isArray(message.content) ? message.content : [];
      const reasoning = content.find((p) => p && (p.type === 'reasoning' || p.type === 'thinking'));
      const text = content.find((p) => p && p.type === 'text');
      if (reasoning && typeof reasoning.text === 'string' && reasoning.text.trim()) {
        next.thinking = shorten(reasoning.text);
        // 纯 reasoning → 模型在思考（GUI 的"分析中"）。turn/start/step/start 默认把阶段
        // 置成 step，所以这里必须**显式**改回 thinking，否则界面显示"第 N 步"而看不到在思考。
        next.phase = 'thinking';
      } else if (text && typeof text.text === 'string' && text.text.trim()) {
        next.thinking = shorten(text.text);
      }
      // 出现了正文 → 已经不在"想"，而在"答"
      if (text && typeof text.text === 'string' && text.text.trim()) next.phase = 'step';
      const usage = (data.usage || null) as { inputTokens?: number; outputTokens?: number } | null;
      if (usage && (usage.inputTokens || usage.outputTokens)) {
        next.usage = usage;
        next.tokensIn += usage.inputTokens || 0;
        next.tokensOut += usage.outputTokens || 0;
      }
      return next;
    }

    default:
      return prev;
  }
}

/** 从一批事件重建状态（快照 + 增量都走这里）。 */
export function buildActivity(events: ReadonlyArray<unknown>, nowMsNow?: number): ActivityState {
  let state = emptyActivity();
  for (const ev of events) {
    if (!isProcessEvent(String((ev as { type?: string })?.type || ''))) continue;
    state = applyActivityEvent(state, ev, nowMsNow);
  }
  return state;
}

/** 毫秒 → `1分56秒` / `12秒`。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0秒';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes <= 0) return `${seconds}秒`;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}小时${minutes % 60}分`;
  }
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}

/** 这一轮已经跑了多久（毫秒）；没有轮次返回 0。 */
export function elapsedMs(state: ActivityState, nowMsNow: number): number {
  if (!state.turnStartedAt) return 0;
  return Math.max(0, nowMsNow - state.turnStartedAt);
}

/**
 * 过程条的**状态短语**（单一语义，不含步数与耗时）。
 *
 * 对齐 GUI 的措辞：分析中 / 执行命令 / 第 N 步 / 收尾中。
 *
 * 🔴 2026-10-19 实测修正：旧实现把「第 N 步」+「已完成 M 步」+「用时 X」全塞进
 * 这一个字符串，真机量出的结果是一枚 **306px 宽**的徽章
 * （`执行命令 · 第 55 步 · 已完成 2 步 · 用时 2秒 · 0秒`），把头部右侧动作区
 * 顶出屏幕 127px。而且：
 *   - `第 55 步`（步号）与 `已完成 2 步`（本轮完成数）是两套口径，并排即冲突；
 *   - `用时 2秒`（工具耗时）与界面另加的轮次耗时 `0秒` 是同一件事说两遍。
 * 所以这里**只输出状态短语**，步数与耗时由调用方组合一次。
 */
export function phaseLabel(state: ActivityState, _nowMsNow?: number): string {
  if (state.phase === 'idle') return '';
  switch (state.phase) {
    case 'thinking':
      return state.thinking ? `分析中 · ${state.thinking}` : '分析中';
    case 'tool':
      // 说人话（"执行命令"），不要甩英文工具名（"正在调用 pwsh"）——对齐 GUI 的「执行了命令」
      return state.toolName ? toolActionLabel(state.toolName, 'running') : '正在调用工具';
    case 'step':
      return state.step ? `第 ${state.step} 步` : '准备中';
    case 'finalizing':
      return '收尾中';
    default:
      return '';
  }
}

/**
 * 运行中头部那一行的完整文案：`执行命令 · 第 55 步 · 2分42秒`。
 *
 * 组合规则（每条都对应一个被实测证实的坑）：
 *   1. 状态短语已含「第 N 步」时**不再重复**步号；
 *   2. **耗时只在末尾出现一次**（旧版会把工具耗时和轮次耗时各显示一遍）；
 *   3. 耗时为 0（刚开始/没有起点）时**整段省略**，不显示 `0秒` 这种噪音；
 *   4. 思考摘要可能很长 → 截到 `最长 36 字`，避免把布局撑开。
 */
export function activityHeadline(state: ActivityState, nowMsNow: number): string {
  if (state.phase === 'idle') return '';
  let head = phaseLabel(state, nowMsNow);
  if (!head) return '';
  // 思考摘要在手机头部只留一小段，完整内容在时间线里
  if (state.phase === 'thinking') {
    const prefix = '分析中 · ';
    if (head.startsWith(prefix)) {
      const note = head.slice(prefix.length);
      head = note.length > 36 ? `${prefix}${note.slice(0, 36)}…` : head;
    }
  }

  const parts = [head];
  if (state.step && state.phase !== 'step') parts.push(`第 ${state.step} 步`);

  const elapsed = elapsedMs(state, nowMsNow);
  if (elapsed > 0) parts.push(formatDuration(elapsed));
  return parts.join(' · ');
}

/** "用什么模型在跑"（有值才显示）。 */
export function modelLabel(state: ActivityState): string {
  if (!state.model) return '';
  return state.provider ? `${state.provider}/${state.model}` : state.model;
}

/** token 数 → `1.2k` / `12.4k` / `1.2M`。 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * 一轮跑完后的总结（一行）。
 * 例：`3 步 · 2 次工具调用 · 用时 42秒 · 输出 1.2k tokens`
 *
 * 空状态（没跑过 / 数据不足）返回空串 —— 不要显示"0 步 0 秒"这种噪音。
 */
export function turnSummary(state: ActivityState, nowMsNow: number): string {
  if (state.phase !== 'idle' || !state.turnStartedAt) return '';
  const parts: string[] = [];
  if (state.stepsDone > 0) parts.push(`${state.stepsDone} 步`);
  if (state.toolCalls > 0) {
    parts.push(`${state.toolCalls} 次工具调用`);
    if (state.toolTotalMs > 0) parts.push(`工具 ${formatDuration(state.toolTotalMs)}`);
  }
  const elapsed = elapsedMs(state, nowMsNow);
  if (elapsed > 0) parts.push(`用时 ${formatDuration(elapsed)}`);
  const out = formatTokens(state.tokensOut);
  if (out) parts.push(`输出 ${out} tokens`);
  return parts.join(' · ');
}

/**
 * `step/start` 应该插一条**步骤分隔线**到时间线 —— 这就是 GUI 里"第 N 步"的来源。
 * 非步骤事件返回 null。
 */
export function stepMarkerLine(
  event: unknown,
): { key: string; role: 'assistant'; text: string; kind: 'step/start' } | null {
  const ev = event as { type?: string; seq?: number; data?: { step?: unknown } } | null;
  if (!ev || ev.type !== 'step/start') return null;
  const step = typeof ev?.data?.step === 'number' ? ev.data.step : 1;
  return {
    key: `step-${ev.seq ?? step}`,
    role: 'assistant',
    text: `第 ${step} 步`,
    kind: 'step/start',
  };
}
