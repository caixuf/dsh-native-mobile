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
  cursorFromError,
  fetchChatPage,
  pageRequest,
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