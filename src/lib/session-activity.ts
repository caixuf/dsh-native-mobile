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
      return next;

    case 'tool/result': {
      // data.message.isError 存在与否不影响阶段，只影响是否算成功
      next.phase = 'thinking';
      next.toolMs = prev.toolStartedAt ? Math.max(0, at - prev.toolStartedAt) : null;
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
      if (usage && (usage.inputTokens || usage.outputTokens)) next.usage = usage;
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
 * 过程条的文案。对齐 GUI 的措辞：分析中 / 调用工具 / 第 N 步 / 深度搜索中，用时 …
 */
export function phaseLabel(state: ActivityState, nowMsNow: number): string {
  if (state.phase === 'idle') return '';
  const parts: string[] = [];
  switch (state.phase) {
    case 'thinking':
      parts.push(state.thinking ? `分析中 · ${state.thinking}` : '分析中');
      break;
    case 'tool':
      parts.push(state.toolName ? `正在调用 ${state.toolName}` : '正在调用工具');
      break;
    case 'step':
      parts.push(state.step ? `第 ${state.step} 步` : '准备中');
      break;
    case 'finalizing':
      parts.push('收尾中');
      break;
    default:
      break;
  }
  if (state.step && state.phase !== 'step') parts.push(`第 ${state.step} 步`);
  if (state.stepsDone > 0) parts.push(`已完成 ${state.stepsDone} 步`);
  if (state.toolName && state.phase === 'tool' && state.toolStartedAt) {
    parts.push(`用时 ${formatDuration(nowMsNow - state.toolStartedAt)}`);
  }
  return parts.join(' · ');
}

/** "用什么模型在跑"（有值才显示）。 */
export function modelLabel(state: ActivityState): string {
  if (!state.model) return '';
  return state.provider ? `${state.provider}/${state.model}` : state.model;
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
