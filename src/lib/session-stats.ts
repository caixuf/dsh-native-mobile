/**
 * 会话统计 —— 对齐桌面版底部状态栏的算法。
 *
 * 🔴 数据源已用真主机实测钉死（2026-10-15）：
 *   `session/projections`，args 是**扁平**的 `{ request: { sessionId } }`
 *   （`{ request: { address: {...} } }` 会被边界校验拒；
 *     `{ address: {...} }` 会被拒为 `missing "request"`）。
 *   ⚠️ `session/list` 的 projections **只有** title/sessionListMetadata，
 *     统计数字不在列表里 —— 之前一直以为有，是错的。
 *
 * 返回结构（实测原文）：
 *   {
 *     asOfSeq, values: {
 *       sessionStats:     { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens },
 *       tokenUsage:       { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
 *       contextPressure:  { pressureTokens, projectedTokens, contextWindow },
 *       contextBreakdown: { systemTokens, toolsTokens, messageTokens },
 *     }
 *   }
 *
 * 算法抄自桌面版 `packages/client/ui-chat/src/client/chat/StatsPills.tsx`：
 *   tok/s      = decodeTokens / (decodeMs / 1000)
 *   计费输入   = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
 *   缓存命中率 = cacheReadTokens / 计费输入
 *   上下文占用 = pressureTokens / contextWindow
 */

export interface SessionStatsProjection {
  turns?: number;
  steps?: number;
  llmMs?: number;
  toolMs?: number;
  ttftMs?: number;
  ttftSteps?: number;
  decodeMs?: number;
  decodeTokens?: number;
}

export interface TokenUsageProjection {
  uncachedInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ContextPressureProjection {
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow?: number;
}

export interface ContextBreakdownProjection {
  systemTokens?: number;
  toolsTokens?: number;
  messageTokens?: number;
}

export interface SessionProjections {
  sessionStats?: SessionStatsProjection | null;
  tokenUsage?: TokenUsageProjection | null;
  contextPressure?: ContextPressureProjection | null;
  contextBreakdown?: ContextBreakdownProjection | null;
}

/** 从 `{asOfSeq, values}` 或直接的 `values` 里取出各投影（两种形状都容错）。 */
export function pickProjections(raw: unknown): SessionProjections {
  if (!raw || typeof raw !== 'object') return {};
  const bag = raw as { values?: Record<string, unknown> };
  const values = (bag.values && typeof bag.values === 'object' ? bag.values : raw) as Record<string, unknown>;
  const out: SessionProjections = {};
  if (values.sessionStats && typeof values.sessionStats === 'object') out.sessionStats = values.sessionStats as SessionStatsProjection;
  if (values.tokenUsage && typeof values.tokenUsage === 'object') out.tokenUsage = values.tokenUsage as TokenUsageProjection;
  if (values.contextPressure && typeof values.contextPressure === 'object') out.contextPressure = values.contextPressure as ContextPressureProjection;
  if (values.contextBreakdown && typeof values.contextBreakdown === 'object') out.contextBreakdown = values.contextBreakdown as ContextBreakdownProjection;
  return out;
}

// ── 格式化（抄桌面版 token-format.ts 的口径）────────────────────────────────

/** 紧凑 token 数：517 / 12.2K / 517K / 1.2M。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const scaled = (v: number): string => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

/** 每秒 token：`292 t/s`；没有解码时长就返回 null（**不能显示 0 冒充**）。 */
export function formatTokensPerSecond(stats: SessionStatsProjection | null | undefined): string | null {
  const tokens = stats?.decodeTokens ?? 0;
  const ms = stats?.decodeMs ?? 0;
  if (!Number.isFinite(tokens) || !Number.isFinite(ms) || tokens <= 0 || ms <= 0) return null;
  const tps = tokens / (ms / 1_000);
  if (!Number.isFinite(tps) || tps <= 0) return null;
  // 单位用 `t/s` 而不是 `tok/s`：360dp 手机上每个字符都要算预算（省 2 字符 ≈ 12px）
  return `${tps >= 100 ? Math.round(tps) : Math.round(tps * 10) / 10} t/s`;
}

/** 计费输入 = 三个互斥的 prompt 侧桶之和（桌面版 billedInputTokens）。 */
export function billedInputTokens(usage: TokenUsageProjection | null | undefined): number {
  if (!usage) return 0;
  return (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
}

/**
 * 缓存命中率（%）。分母为 0 → null（**不显示 0%**）。
 * 桌面版还有一套"部分命中不四舍五入成 100%"的细则；手机上取一位小数即可，
 * 但**满命中仍返回 100**，未命中返回 null 由调用方隐藏。
 */
export function formatCacheHitPercent(usage: TokenUsageProjection | null | undefined): string | null {
  if (!usage) return null;
  const promptTokens = billedInputTokens(usage);
  if (promptTokens <= 0) return null;
  const cacheRead = usage.cacheReadTokens || 0;
  const percent = (cacheRead / promptTokens) * 100;
  if (percent <= 0) return null;
  if (percent >= 100) return '100';
  return String(Math.round(percent * 10) / 10);
}

/** 会话累计 token 总量 = 计费输入 + 输出。 */
export function totalTokens(usage: TokenUsageProjection | null | undefined): number {
  if (!usage) return 0;
  return billedInputTokens(usage) + (usage.outputTokens || 0);
}

/** 上下文占用百分比；contextWindow 缺失或为 0 → null（不能猜）。 */
export function formatContextPercent(pressure: ContextPressureProjection | null | undefined): string | null {
  if (!pressure) return null;
  const used = pressure.pressureTokens ?? pressure.projectedTokens ?? 0;
  const window = pressure.contextWindow ?? 0;
  if (window <= 0 || used <= 0) return null;
  const percent = (used / window) * 100;
  if (percent <= 0) return null;
  if (percent >= 100) return '100';
  return String(Math.round(percent * 10) / 10);
}

/** 平均首字延迟（毫秒）；没有样本 → null。 */
export function averageTtftMs(stats: SessionStatsProjection | null | undefined): number | null {
  const steps = stats?.ttftSteps ?? 0;
  const ms = stats?.ttftMs ?? 0;
  if (steps <= 0 || ms <= 0) return null;
  return Math.round(ms / steps);
}

/** 毫秒 → `45.2s` / `2m42s`（对齐桌面版口径：60s 以下一位小数）。 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = ms / 1_000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/** 状态栏三个读数。任一数据缺失就置 null，**由调用方决定隐藏，绝不显示 0**。 */
export interface SessionReadouts {
  activity: string | null; // "2 轮 · 累计 201 步 · 229 tok/s"
  usage: string | null; // "17.3M tok"
  context: string | null; // "上下文 15.9%"
  detail: Array<{ label: string; value: string }>;
}

/**
 * 三个读数（供顶部状态栏一行显示）。
 *
 * 🔴 2026-10-19 真机实测的两个问题：
 *   ① **口径冲突**（用户反馈"头部信息互相冲突"）：
 *      头部运行行显示「第 32 步」（**本轮内**当前步号），
 *      统计栏显示「1 轮 30 步」（**全会话累计**步数），
 *      都叫"步"却对不上（32 > 30）→ 累计值必须显式标注「累计」。
 *   ② **被截断**：412px 视口下统计条可视宽 312px，旧文案 341px，
 *      最后一段「上下文 15.9%」直接看不到（只剩渐隐遮罩）。
 *      所以这里把每一段都压到最短，保证一行放得下：
 *        `2 轮 · 累计 271 步` / `238 tok/s` / `30.3M tok` / `上下文 20.6%`
 *
 * 明确取舍：**宁可少显示一个次要指标，也不让关键指标被裁掉**。
 * 缓存命中率已从主行撤下（明细里有），token 总量保留（它回答"这轮花了多少"）。
 */
export function buildReadouts(p: SessionProjections): SessionReadouts {
  const stats = p.sessionStats || null;
  const usage = p.tokenUsage || null;

  const speed = formatTokensPerSecond(stats);
  const activityParts: string[] = [];
  if (stats) {
    const turns = stats.turns ?? 0;
    const steps = stats.steps ?? 0;
    if (turns > 0 || steps > 0) {
      // 「累计」二字是关键：与头部的「第 N 步」（本轮当前步）区分开，
      // 否则两个都叫"步"的数字并排出现就是矛盾。
      //
      // 🔴 360dp 是常见手机宽度（用户真机 540px/1.5dpr = 360dp），
      //    实测在这里可视宽只有 264px，旧文案（含 tok/s、tok、上下文前缀）
      //    还差 16px 放不下。因此：
      //      · `238 tok/s` → `238 t/s`（速度单位，省 2 字符）
      //      · 轮/步合起来用最紧凑的写法 `2轮 · 累计294步`
      const turnPart = turns > 0 ? `${turns}轮` : '';
      const stepPart = steps > 0 ? `累计${steps}步` : '';
      const joined = [turnPart, stepPart].filter(Boolean).join(' · ');
      if (joined) activityParts.push(joined);
    }
    if (speed) activityParts.push(speed);
  }
  const activity = activityParts.length ? activityParts.join(' · ') : null;

  const total = totalTokens(usage);
  // `30.3M tok` → `30.3M`：单位已由「明细」与上下文段的 % 暗示，
  // 省下 4 个字符正是让「上下文」不被裁掉的关键（实测旧版裁掉 29px）。
  const usageText = total > 0 ? formatTokens(total) : null;

  // `上下文 20.6%` → `20.6%`：段位靠最右，位置本身即语境；
  // 完整写法在「明细」里仍然保留为「上下文 x / y」。
  const contextPercent = formatContextPercent(p.contextPressure || null);
  const context = contextPercent ? `${contextPercent}%` : null;

  const detail: Array<{ label: string; value: string }> = [];
  if (stats) {
    if (stats.llmMs) detail.push({ label: '模型耗时', value: formatMs(stats.llmMs) });
    if (stats.toolMs) detail.push({ label: '工具耗时', value: formatMs(stats.toolMs) });
    const ttft = averageTtftMs(stats);
    if (ttft !== null) detail.push({ label: '首字延迟', value: formatMs(ttft) });
    if (speed) detail.push({ label: '输出速度', value: speed });
  }
  if (usage) {
    const hit = formatCacheHitPercent(usage);
    if (hit) detail.push({ label: '缓存命中', value: `${hit}%` });
    if (usage.uncachedInputTokens) detail.push({ label: '未命中输入', value: `${formatTokens(usage.uncachedInputTokens)}` });
    if (usage.cacheReadTokens) detail.push({ label: '缓存读取', value: `${formatTokens(usage.cacheReadTokens)}` });
    if (usage.cacheWriteTokens) detail.push({ label: '缓存写入', value: `${formatTokens(usage.cacheWriteTokens)}` });
    if (usage.outputTokens) detail.push({ label: '输出', value: `${formatTokens(usage.outputTokens)}` });
  }
  if (p.contextBreakdown) {
    const b = p.contextBreakdown;
    if (b.systemTokens) detail.push({ label: '系统提示', value: `${formatTokens(b.systemTokens)}` });
    if (b.toolsTokens) detail.push({ label: '工具定义', value: `${formatTokens(b.toolsTokens)}` });
    if (b.messageTokens) detail.push({ label: '历史消息', value: `${formatTokens(b.messageTokens)}` });
  }
  const ctx = p.contextPressure || null;
  if (ctx && ctx.pressureTokens && ctx.contextWindow) {
    detail.push({ label: '上下文', value: `${formatTokens(ctx.pressureTokens)} / ${formatTokens(ctx.contextWindow)}` });
  }

  return { activity, usage: usageText, context, detail };
}
