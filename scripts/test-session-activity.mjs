/**
 * 过程状态（session-activity）单元测试。
 *
 * 事件样本是 2026-10-15 在**真主机**上抓的一次 3 步任务的原始载荷
 * （`session/follow`，共 32 条），不是手编的形状。
 *
 *   node --experimental-strip-types scripts/test-session-activity.mjs
 */
import {
  applyActivityEvent,
  buildActivity,
  elapsedMs,
  emptyActivity,
  formatDuration,
  formatTokens,
  isProcessEvent,
  modelLabel,
  phaseLabel,
  stepMarkerLine,
  turnSummary,
} from '../src/lib/session-activity.ts';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err?.message || String(err) });
    console.log(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n      expected: ${b}\n      actual:   ${a}`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || '期望为真');
}

// ── 真主机抓包样本（原始载荷，保留真实时间戳）───────────────────────────────
const T0 = 1_767_000_000_000; // 基准时间
const EVENTS = [
  { type: 'agent/inbox/spliced', seq: 1, time: T0 + 1762, data: { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text: '分三步做完…' }] }], removedCount: 0 } },
  { type: 'turn/start', seq: 2, time: T0 + 1767, data: { turn: 1 } },
  { type: 'step/start', seq: 3, time: T0 + 1940, data: { turn: 1, step: 1 } },
  { type: 'system/message', seq: 4, time: T0 + 1943, data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are an AI agent…' }] } } },
  { type: 'request/context', seq: 5, time: T0 + 1946, data: { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview', contextWindow: 1048576 } },
  { type: 'assistant/message', seq: 6, time: T0 + 5785, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Simple task. Let me do the three steps.' }] }, usage: { inputTokens: 12000, outputTokens: 320 }, stream: {} } },
  { type: 'tool/call', seq: 7, time: T0 + 5785, data: { turn: 1, step: 1, callId: 'call_1', name: 'pwsh', arguments: '{"command":"node -v"}' } },
  { type: 'tool/result', seq: 8, time: T0 + 7498, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'v24.18.1\r\n' }], isError: false } } },
  { type: 'step/end', seq: 9, time: T0 + 7499, data: { turn: 1, step: 1 } },
  { type: 'step/start', seq: 10, time: T0 + 14000, data: { turn: 1, step: 2 } },
  { type: 'tool/call', seq: 11, time: T0 + 14100, data: { turn: 1, step: 2, callId: 'call_2', name: 'read', arguments: '{}' } },
  { type: 'tool/result', seq: 12, time: T0 + 14888, data: { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'call_2', content: [{ type: 'text', text: 'ok' }], isError: false } } },
  { type: 'step/end', seq: 13, time: T0 + 14903, data: { turn: 1, step: 2 } },
  { type: 'assistant/message', seq: 14, time: T0 + 16863, data: { turn: 1, step: 3, message: { role: 'assistant', content: [{ type: 'text', text: '三步都完成了：v24.18.1。' }] }, usage: { inputTokens: 13000, outputTokens: 900 } } },
  { type: 'turn/end', seq: 15, time: T0 + 18134, data: { turn: 1, reason: { kind: 'completed' } } },
];

console.log('\n  过程状态（session/follow 事件词表）单元测试');
console.log('  ──────────────────────────────────────────────────');

check('只认过程相关事件；对话/系统/内部请求事件不进状态', () => {
  ok(isProcessEvent('turn/start') && isProcessEvent('step/end'), 'turn/step 必须是过程事件');
  ok(isProcessEvent('tool/call') && isProcessEvent('tool/result'), 'tool 必须是过程事件');
  ok(isProcessEvent('request/context') && isProcessEvent('assistant/message'));
  ok(!isProcessEvent('user/message'), '用户消息不是"过程"');
  ok(!isProcessEvent('system/message'), '系统消息不是"过程"');
  ok(!isProcessEvent('agent/inbox/spliced'), 'inbox 拼接不是"过程"');
  ok(!isProcessEvent('request/header'), 'request/header 内容巨大，不该进状态');
});

check('跑完一次 3 步任务后：阶段归 idle、走过 2 个完整步骤、模型已知', () => {
  const s = buildActivity(EVENTS);
  eq(s.phase, 'idle', 'turn/end 之后必须回到 idle');
  eq(s.turn, 1);
  eq(s.stepsDone, 2, '两个 step/end → 完成 2 步');
  eq(s.provider, 'minimax-cn');
  eq(s.model, 'MiniMax-M3.1-Flash-Preview');
  eq(modelLabel(s), 'minimax-cn/MiniMax-M3.1-Flash-Preview');
  ok(s.turnStartedAt, '轮次开始时间要记下来（用于"已用时"）');
  eq(s.toolName, null, '跑完不能残留工具名');
});

check('工具耗时 = tool/result 时刻 − tool/call 时刻（真样本 1713ms）', () => {
  let s = emptyActivity();
  s = applyActivityEvent(s, EVENTS[6]); // tool/call @5785
  eq(s.phase, 'tool');
  eq(s.toolName, 'pwsh');
  eq(s.toolMs, null, '还在等结果时不该有耗时');
  s = applyActivityEvent(s, EVENTS[7]); // tool/result @7498
  eq(s.toolMs, 7498 - 5785, 'pwsh 这次跑了 1713ms');
  eq(s.phase, 'thinking', '拿到结果就回到"分析中"');
});

check('有 reasoning 时显示思考摘要，且截断到 120 字', () => {
  const s = buildActivity(EVENTS.slice(0, 6)); // 到 assistant/message(reasoning)
  eq(s.phase, 'thinking');
  ok(s.thinking && s.thinking.includes('Simple task'), `思考摘要=${s.thinking}`);

  const long = 'x'.repeat(400);
  const s2 = applyActivityEvent(emptyActivity(), {
    type: 'assistant/message',
    time: T0,
    data: { message: { content: [{ type: 'reasoning', text: long }] } },
  });
  ok((s2.thinking || '').length <= 121, `截断后长度=${(s2.thinking || '').length}`);
  ok((s2.thinking || '').endsWith('…'), '截断要有省略号');
});

check('出现正文就算"在答"，不再显示分析中', () => {
  const s = buildActivity(EVENTS.slice(0, 14));
  ok(!phaseLabel(s, T0 + 17000).includes('分析中'), `最后一条是正文，文案=${phaseLabel(s, T0 + 17000)}`);
});

check('文案对齐 GUI 措辞：分析中 / 正在调用 pwsh / 第 2 步 / 已完成 1 步 / 用时', () => {
  // 停在 tool/call 上
  let s = buildActivity(EVENTS.slice(0, 7));
  const label = phaseLabel(s, T0 + 10000);
  ok(label.includes('执行命令'), `tool 阶段要说人话，实际=${label}`);
  ok(!label.includes('pwsh'), `过程条不该甩英文工具名：${label}`);
  ok(label.includes('第 1 步'), `应带步骤号：${label}`);
  ok(label.includes('用时'), `应带耗时：${label}`);
  // 走到第 2 步开头
  s = buildActivity(EVENTS.slice(0, 10));
  const label2 = phaseLabel(s, T0 + 14000);
  ok(label2.includes('第 2 步'), `step 阶段文案=${label2}`);
  ok(label2.includes('已完成 1 步'), `应带已完成步数：${label2}`);
  // 纯 thinking
  const s3 = applyActivityEvent(buildActivity(EVENTS.slice(0, 6)), {
    type: 'step/end',
    time: T0 + 8000,
    data: { turn: 1, step: 1 },
  });
  ok(phaseLabel(s3, T0 + 9000).startsWith('分析中'), `thinking 文案=${phaseLabel(s3, T0 + 9000)}`);
  // 未知工具也要说人话，不能把原始 id 当文案
  const unknownTool = applyActivityEvent(buildActivity(EVENTS.slice(0, 7)), {
    type: 'tool/call',
    time: T0 + 9000,
    data: { name: 'brand_new_plugin_tool' },
  });
  ok(
    phaseLabel(unknownTool, T0 + 9000).includes('调用 brand_new_plugin_tool'),
    `未知工具应优雅降级：${phaseLabel(unknownTool, T0 + 9000)}`,
  );
  eq(phaseLabel(emptyActivity(), T0), '', '没有轮次就不该有文案');
});

check('耗时格式化：秒 / 分秒 / 小时', () => {
  eq(formatDuration(900), '1秒');
  eq(formatDuration(0), '0秒');
  eq(formatDuration(116_000), '1分56秒');
  eq(formatDuration(3_661_000), '1小时1分');
  eq(formatDuration(-5), '0秒');
  eq(formatDuration(NaN), '0秒');
});

check('本轮已用时随时间增长', () => {
  const s = buildActivity(EVENTS.slice(0, 3)); // 到 turn/start
  const base = s.turnStartedAt || 0;
  eq(elapsedMs(s, base + 5000), 5000);
  eq(elapsedMs(s, base), 0);
  eq(elapsedMs(emptyActivity(), T0), 0, '没有轮次 → 0');
});

check('step/start 产出"第 N 步"分隔线，其它事件不产出', () => {
  const line = stepMarkerLine(EVENTS[2]);
  ok(line, 'step/start 必须产出分隔线');
  eq(line?.kind, 'step/start');
  eq(line?.text, '第 1 步');
  eq(stepMarkerLine(EVENTS[3]), null, 'system/message 不产出');
  eq(stepMarkerLine(EVENTS[6]), null, 'tool/call 不产出');
  eq(stepMarkerLine(null), null);
});

check('快照 + 增量重放结果一致（顺序无关地能收敛）', () => {
  const full = buildActivity(EVENTS);
  const half = buildActivity(EVENTS.slice(0, 9));
  const rest = EVENTS.slice(9).reduce((acc, ev) => applyActivityEvent(acc, ev), half);
  eq(rest.phase, full.phase, '分段重放应与整体一致');
  eq(rest.stepsDone, full.stepsDone, `分段重放 stepsDone=${rest.stepsDone} vs ${full.stepsDone}`);
});

check('一轮累计 token / 工具次数 / 工具总耗时（不能只看最后一次 usage）', () => {
  const s = buildActivity(EVENTS);
  // 真样本：两条 assistant/message 分别带 usage 12000/320 与 13000/900
  eq(s.tokensOut, 320 + 900, '输出 token 要累加');
  eq(s.tokensIn, 12000 + 13000, '输入 token 要累加');
  eq(s.toolCalls, 2, '两次 tool/call');
  eq(s.toolTotalMs, (7498 - 5785) + (14888 - 14100), '工具总耗时 = 各次之和');
});

check('新一轮开始时累计值清零（不能把上一轮的数带过来）', () => {
  eq(buildActivity(EVENTS).tokensOut, 1220, '先确认上一轮确实有量');
  const second = buildActivity([...EVENTS, { type: 'turn/start', seq: 20, time: T0 + 20000, data: { turn: 2 } }]);
  eq(second.tokensOut, 0, '新 turn/start 要清零');
  eq(second.toolCalls, 0);
  eq(second.toolTotalMs, 0);
  eq(second.stepsDone, 0);
});

check('跑完后给出一行总结；数据不足时安静返回空串', () => {
  const sum = turnSummary(buildActivity(EVENTS), T0 + 18134);
  ok(sum.includes('2 步'), `总结应含步数：${sum}`);
  ok(sum.includes('2 次工具调用'), `总结应含工具次数：${sum}`);
  ok(sum.includes('用时'), `总结应含用时：${sum}`);
  ok(/输出 1\.2k tokens/.test(sum), `总结应含输出 token：${sum}`);
  ok(/工具 2秒|工具 3秒/.test(sum), `总结应含工具总耗时：${sum}`);

  eq(turnSummary(emptyActivity(), T0), '', '没跑过就不该有总结');
  eq(turnSummary(buildActivity(EVENTS.slice(0, 4)), T0 + 2000), '', '还在跑时不显示总结');
});

check('token 数量格式化', () => {
  eq(formatTokens(0), '');
  eq(formatTokens(-5), '');
  eq(formatTokens(900), '900');
  eq(formatTokens(1200), '1.2k');
  eq(formatTokens(12345), '12.3k');
  eq(formatTokens(1_200_000), '1.2M');
  eq(formatTokens(NaN), '');
});

check('畸形/未知事件不炸且不改状态', () => {
  const s = emptyActivity();
  eq(applyActivityEvent(s, null), s);
  eq(applyActivityEvent(s, {}), s);
  eq(applyActivityEvent(s, { type: 'unknown/thing', data: { x: 1 } }), s);
  const noData = applyActivityEvent(s, { type: 'tool/call', time: 1, data: undefined });
  eq(noData.phase, 'tool', '缺 name 也要进 tool 阶段');
  eq(noData.toolName, null);
  eq(buildActivity([]).phase, 'idle');
  eq(buildActivity([null, undefined, {}]).phase, 'idle');
});

console.log('  ──────────────────────────────────────────────────');
console.log(`  ${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);