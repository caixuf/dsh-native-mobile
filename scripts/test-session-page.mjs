/**
 * `session.page` 契约测试 —— 钉死两个造成「聊天记录永远空白」的真实事故。
 *
 * 运行：
 *   node --experimental-strip-types scripts/test-session-page.mjs
 *
 * 两个事故都是**真主机实测**（2026-10-14）：
 *   1. address 少 `kind` → `wire field "request" failed boundary validation`
 *   2. throughSeq 写死 1000000 → `session page through seq 1000000 is past cursor 1653`
 * 两条都会让"能打开会话但一条记录都没有"，而且**不报错到用户眼前**（只进 console）。
 */

import {
  CURSOR_PROBE,
  collectMessageText,
  collectReasoningText,
  cursorFromError,
  eventToLine,
  eventsToLines,
  fetchChatPage,
  isDialogEvent,
  isToolEvent,
  pageRequest,
  recordsToLines,
  sessionAddress,
} from '../src/lib/session-page.ts';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? 'not equal'}\n    expected: ${e}\n    actual:   ${a}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg ?? 'expected truthy');
}

// ── §1 address 形状 ────────────────────────────────────────────────────────

check('普通会话的 address 必须带 kind=session', () => {
  eq(sessionAddress({ sessionId: 's-1' }), { kind: 'session', sessionId: 's-1' });
});

check('缺 kind 的历史形状会被这条测试拦住（回归护栏）', () => {
  const address = sessionAddress({ sessionId: 's-1' });
  ok('kind' in address, 'address 少了 kind —— 真主机会报 boundary validation，聊天记录全空');
});

check('子代理会话带 kind=subagent 且带 durable parent', () => {
  eq(
    sessionAddress({ sessionId: 'sub-1', isSubagent: true, parentSessionId: 'p-1' }),
    { kind: 'subagent', sessionId: 'sub-1', parentSessionId: 'p-1' },
  );
});

check('fork 出来的普通会话（有 parent 但没有 isSubagent）仍按普通会话打开', () => {
  // 实测教训：判据只能用 origin/isSubagent，用 parentSessionId 会误伤 fork 的普通会话
  eq(
    sessionAddress({ sessionId: 'fork-1', isSubagent: false, parentSessionId: 'p-9' }),
    { kind: 'session', sessionId: 'fork-1' },
  );
});

check('request 形参名与 maxMessages 默认值', () => {
  const args = pageRequest({ kind: 'session', sessionId: 's' }, 1653);
  eq(Object.keys(args), ['request']);
  eq(args.request.throughSeq, 1653);
  eq(args.request.maxMessages, 50);
});

// ── §2 cursor 解析 ─────────────────────────────────────────────────────────

check('从真主机的原文错误里读出 cursor', () => {
  // 这是**逐字**的真实报文，不要改写
  eq(cursorFromError('session page through seq 1000000 is past cursor 1653'), 1653);
});

check('cursor 解析对其它错误返回 null（不能瞎猜成 0）', () => {
  eq(cursorFromError('wire field "request" failed boundary validation'), null);
  eq(cursorFromError('session/agent-busy'), null);
  eq(cursorFromError(''), null);
  eq(cursorFromError(undefined), null);
  eq(cursorFromError(12345), null);
});

check('cursor=0 也是合法值（空会话）', () => {
  eq(cursorFromError('session page through seq 10 is past cursor 0'), 0);
});

// ── §3 取页流程（注入假 RPC，不碰网络）──────────────────────────────────────

await checkAsync('先用探测值，成功就直接返回（不浪费第二次调用）', async () => {
  const calls = [];
  const result = await fetchChatPage(async (method, args) => {
    calls.push({ method, args });
    return { records: [{ seq: 1, event: { type: 'assistant/message' } }] };
  }, { sessionId: 's-1' });

  eq(calls.length, 1, '不该有第二次调用');
  eq(calls[0].method, 'session.page');
  eq(calls[0].args.request.throughSeq, CURSOR_PROBE);
  eq(calls[0].args.request.address, { kind: 'session', sessionId: 's-1' });
  eq(result.records.length, 1);
});

await checkAsync('越界时用主机给的 cursor 重试并拿到记录', async () => {
  const calls = [];
  const result = await fetchChatPage(async (method, args) => {
    calls.push(args.request.throughSeq);
    if (args.request.throughSeq === CURSOR_PROBE) {
      throw new Error('session page through seq 1000000 is past cursor 1653');
    }
    return { records: [{ seq: 1653, event: { type: 'tool/result' } }] };
  }, { sessionId: 's-2' });

  eq(calls, [CURSOR_PROBE, 1653], '第二次必须用主机自报的 cursor');
  eq(result.records.length, 1);
});

await checkAsync('两次都失败时把原始错误抛出去（不许静默返回空列表）', async () => {
  let threw = null;
  try {
    await fetchChatPage(async () => {
      throw new Error('session/agent-busy');
    }, { sessionId: 's-3' });
  } catch (err) {
    threw = err.message;
  }
  ok(threw !== null, '不该吞掉错误 —— 静默返回空列表正是"聊天永远空白"的成因');
  eq(threw, 'session/agent-busy');
});

await checkAsync('重试次数上限为 2（不允许多次重试把主机打爆）', async () => {
  let calls = 0;
  try {
    await fetchChatPage(async () => {
      calls += 1;
      throw new Error('session page through seq 1 is past cursor 0');
    }, { sessionId: 's-4' });
  } catch {
    /* 预期抛错 */
  }
  eq(calls, 2);
});

// ── §4 正文提取与事件过滤（P0：reasoning 被当成回答 / 系统提示词被当气泡）──────

check('P0：模型先输出 reasoning 时，必须取到真正的正文', () => {
  // 这是**真主机实测的原文载荷**，不要改写
  const content = [
    { type: 'reasoning', text: 'The user asks to reply exactly with a token. Just reply.' },
    { type: 'text', text: 'E2E-REPLY-7719' },
  ];
  eq(collectMessageText(content), 'E2E-REPLY-7719', '取 content[0].text 会把私有推理当回答');
  eq(collectReasoningText(content), 'The user asks to reply exactly with a token. Just reply.');
});

check('P0：多个 text 段全部拼接（不只取第一段）', () => {
  eq(
    collectMessageText([
      { type: 'text', text: '第一段' },
      { type: 'reasoning', text: '思考' },
      { type: 'text', text: '第二段' },
    ]),
    '第一段\n\n第二段',
  );
});

check('正文提取的兼容形状', () => {
  eq(collectMessageText('裸字符串'), '裸字符串', 'content 直接是字符串');
  eq(collectMessageText([{ text: '未标类型也算正文' }]), '未标类型也算正文');
  eq(collectMessageText([{ type: 'output_text', text: 'output' }]), 'output');
  eq(collectMessageText([{ type: 'image', url: 'x' }]), '', '图片段没有正文');
  eq(collectMessageText([{ type: 'text', text: '   ' }]), '', '空白段不算');
  eq(collectMessageText(null), '');
  eq(collectMessageText(undefined), '');
  eq(collectMessageText(123), '');
});

check('P0：user/message 的正文在 data.content（没有 message 包装）', () => {
  // 真主机实测形状：user 事件是 {content:[{type:'text',text:'…'}]}，
  // 而 assistant 事件是 {message:{content:[…]}}。只读 message.content 会让
  // **用户自己发的指令渲染成空气泡**（验证者实测 5 个气泡文本全空）。
  const userEvent = { content: [{ type: 'text', text: 'Reply with exactly: E2E-PING-OK' }] };
  const assistantEvent = {
    message: { content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: 'E2E-PING-OK' }] },
  };
  eq(collectMessageText(userEvent.content), 'Reply with exactly: E2E-PING-OK');
  eq(
    collectMessageText(assistantEvent.message.content),
    'E2E-PING-OK',
    'assistant 必须跳过 reasoning 取正文',
  );
  // App 里的取值顺序：先 message.content，再回落 content
  const pick = (data) => collectMessageText(data?.message?.content ?? data?.content);
  eq(pick(userEvent), 'Reply with exactly: E2E-PING-OK', 'user 走顶层 content');
  eq(pick(assistantEvent), 'E2E-PING-OK', 'assistant 走 message.content');
  eq(pick({}), '');
});

check('P0：只有 reasoning 时正文为空（宁可空，也不能把推理当回答）', () => {
  eq(collectMessageText([{ type: 'reasoning', text: '只有思考' }]), '');
});

check('P0：system/message 不得渲染成对话气泡（整段系统提示词）', () => {
  eq(isDialogEvent('system/message'), false, '系统提示词不该出现在聊天时间线');
  eq(isDialogEvent('user/message'), true);
  eq(isDialogEvent('assistant/message'), true);
  eq(isDialogEvent('tool/call'), true);
  eq(isDialogEvent('tool/result'), true);
});

check('内部事件类型一律不渲染', () => {
  for (const kind of ['step/start', 'step/end', 'llm/retry', 'llm/retry-started', 'turn/end', 'request/created']) {
    eq(isDialogEvent(kind), false, `${kind} 不该渲染`);
  }
  eq(isDialogEvent(''), false);
  eq(isDialogEvent('some/future-thing'), false, '不认识的类型宁可不渲染');
});

check('工具事件判定', () => {
  eq(isToolEvent('tool/call'), true);
  eq(isToolEvent('tool/result'), true);
  eq(isToolEvent('assistant/message'), false);
});

// ── §5 实时流（session/follow）与历史翻页共用同一套映射 ─────────────────────

check('follow 快照里的裸事件能映射成聊天行', () => {
  // 真主机 session/follow 的 snapshot.records 是**裸事件**（没有 {event:...} 包装）
  const records = [
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '跑一下 node -v' }] } },
    { type: 'tool/call', seq: 5, data: { name: 'pwsh', callId: 'c1', arguments: '{"command":"node -v"}' } },
    { type: 'tool/result', seq: 6, data: { callId: 'c1', result: 'v24.21.0' } },
    { type: 'assistant/message', seq: 9, data: { message: { content: [{ type: 'text', text: 'v24.21.0' }] } } },
  ];
  const lines = eventsToLines(records);
  eq(lines.length, 4, '四条都该渲染');
  eq(lines[0].role, 'user');
  eq(lines[0].text, '跑一下 node -v');
  eq(lines[1].kind, 'tool/call');
  eq(lines[1].toolName, 'pwsh');
  eq(lines[2].toolResult, 'v24.21.0');
  eq(lines[3].text, 'v24.21.0');
  eq(lines.map((l) => l.key), ['line-2', 'line-5', 'line-6', 'line-9'], 'key 必须按 seq 稳定（去重要靠它）');
});

check('follow 的 event 帧与快照映射完全一致', () => {
  const raw = {
    type: 'assistant/message',
    seq: 42,
    data: { message: { content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '答案' }] } },
  };
  const fromEvent = eventToLine(raw);
  const fromSnapshot = eventsToLines([raw])[0];
  eq(fromEvent.text, '答案', 'reasoning 必须跳过');
  eq(fromEvent.key, 'line-42');
  eq(JSON.stringify(fromEvent), JSON.stringify(fromSnapshot), '两条路必须产出完全相同的一行');
});

check('session/page 的 records（{seq,event}）映射与快照一致', () => {
  const wrapped = [{ seq: 7, event: { type: 'tool/result', seq: 7, data: { result: 'ok' } } }];
  const raw = [{ type: 'tool/result', seq: 7, data: { result: 'ok' } }];
  eq(JSON.stringify(recordsToLines(wrapped)), JSON.stringify(eventsToLines(raw)));
});

check('实时流同样过滤系统提示词与空事件', () => {
  const lines = eventsToLines([
    { type: 'system/message', seq: 1, data: { message: { content: [{ type: 'text', text: '整段系统提示词' }] } } },
    { type: 'step/start', seq: 2, data: {} },
    { type: 'assistant/message', seq: 3, data: { message: { content: [] } } },
    { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '真正的回答' }] } } },
  ]);
  eq(lines.length, 1, '只有真正的回答该留下');
  eq(lines[0].text, '真正的回答');
});

check('空/畸形输入不炸', () => {
  eq(eventsToLines(null), []);
  eq(eventsToLines(undefined), []);
  eq(recordsToLines([]), []);
  eq(eventToLine(null), null);
  eq(eventsToLines([{}]).length, 0);
});

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log('');
console.log('  session.page 契约测试（聊天记录读取）');
console.log('  ' + '─'.repeat(50));
if (failures.length === 0) {
  console.log(`  ✓ ${passed} passed, 0 failed`);
  console.log('');
  process.exit(0);
} else {
  console.log(`  ✗ ${passed} passed, ${failures.length} failed`);
  for (const f of failures) {
    console.log('');
    console.log(`  ${f.name}`);
    console.log(`    ${f.message}`);
  }
  console.log('');
  process.exit(1);
}