/**
 * 回归测试：`DshConnection` 必须**以正确的接收者**调用 `fetch`。
 *
 * ## 背景（真实事故，2026-10-14 真机实测）
 *
 * 有人把 fetch 抽成了 `this.fetchImpl`，写成：
 *
 * ```ts
 * private get fetchImpl() { return this.deps.fetch ?? fetch; }
 * ```
 *
 * 于是调用点变成 `this.fetchImpl(...)`，`this` 成了 DshConnection。
 * 浏览器里 fetch 是 `window` 的方法，接收者不对就抛：
 *
 * ```
 * Failed to execute 'fetch' on 'Window': Illegal invocation
 * ```
 *
 * 症状是**整条网页 RPC 全废**：会话列表恒空、顶部只显示"降级: 主机未响应…"，
 * 而原生中继照常工作（所以"审批通知"看起来还是好的）—— 极难归因。
 *
 * ## 为什么必须在**这里**测
 *
 * 原有单测全都注入假 `fetch`，假函数不检查接收者，**永远抓不到这个 bug**。
 * 所以本测试把 `globalThis.fetch` 换成一个「接收者不对就抛」的严格实现，
 * 精确复刻浏览器的行为。
 *
 * 运行：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs \
 *        scripts/test-connection-fetch-binding.mjs
 */

import { readFileSync } from 'node:fs';
import { DshConnection } from '../src/services/connection.ts';

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

const realFetch = globalThis.fetch;

/** 复刻浏览器行为：接收者不是 globalThis 就抛 Illegal invocation。 */
function installStrictFetch() {
  const calls = [];
  globalThis.fetch = function strictFetch(...args) {
    // 浏览器行为：fetch 是 window 的方法，`this` 不是 window（含 undefined）就拒绝执行
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    calls.push({ url: String(args[0]), init: args[1] });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ result: { ok: true, value: { items: [{ sessionId: 's-1' }] } } }),
    });
  };
  return calls;
}

await checkAsync('call() 在没有注入 fetch 时也能工作（接收者必须正确）', async () => {
  const calls = installStrictFetch();
  try {
    const conn = new DshConnection('http://127.0.0.1:19387', 'token-1');
    const value = await conn.call('session/list', { _request: {} });
    eq(calls.length, 1, '应当恰好发出一次请求');
    eq(calls[0].url, 'http://127.0.0.1:19387/mobile-gateway/api/session/list');
    eq(calls[0].init.headers.Authorization, 'Bearer token-1');
    eq(value.items.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await checkAsync('respond() 同样不能丢接收者', async () => {
  const calls = installStrictFetch();
  try {
    const conn = new DshConnection('http://127.0.0.1:19387', 'token-1');
    // respond 需要事件流握手后的 clientId；运行时是普通字段
    conn.eventClientId = 'client-1';
    const ok = await conn.respond('ev-1', { kind: 'result', value: 'allowed-once' });
    eq(ok, true);
    eq(calls.length, 1);
    eq(calls[0].url, 'http://127.0.0.1:19387/mobile-gateway/api/$events/result');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await checkAsync('注入 deps.fetch 时优先用它（测试替身仍然可用）', async () => {
  const calls = installStrictFetch();
  let injectedCalls = 0;
  try {
    const conn = new DshConnection('http://127.0.0.1:19387', 'token-1', '', {
      fetch: async () => {
        injectedCalls += 1;
        return { ok: true, status: 200, json: async () => ({ result: { ok: true, value: {} } }) };
      },
    });
    await conn.call('session/list', {});
    eq(injectedCalls, 1, '应当用注入的实现');
    eq(calls.length, 0, '不应该碰到全局 fetch');
  } finally {
    globalThis.fetch = realFetch;
  }
});

/** 扫描**代码**、排除注释：注释里引用反例是很正常的写法，不该误报。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function findBareFetchFallback(text) {
  return [...stripComments(text).matchAll(/this\.deps\.fetch\s*\?\?\s*fetch\b/g)].length;
}

check('扫描器自检：抓得到真代码里的裸 fetch、不误报注释', () => {
  eq(findBareFetchFallback('return this.deps.fetch ?? fetch;'), 1, '真代码必须被抓到');
  eq(
    findBareFetchFallback('// 反例：return this.deps.fetch ?? fetch;\nreturn 1;'),
    0,
    '注释里的反例不该误报',
  );
});

check('源码里不得出现"裸 fetch"回退（回归护栏）', () => {
  // 这条断言防止有人把 bind 改回去。比运行时测试更早报警。
  const source = readFileSync(new URL('../src/services/connection.ts', import.meta.url), 'utf8');
  const offenders = findBareFetchFallback(source);
  eq(
    offenders,
    0,
    'connection.ts 的**代码**里又出现了 `this.deps.fetch ?? fetch` —— ' +
      '这会在浏览器里抛 Illegal invocation（注释里写反例不算）',
  );
});

console.log('');
console.log('  fetch 接收者绑定回归测试');
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