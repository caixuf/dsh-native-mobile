#!/usr/bin/env node
/**
 * @file scripts/verify-subagent-classifier.mjs
 * @description 独立复核「子代理会话判据」到底该用什么字段。
 *
 * 背景：有两个互相冲突的说法，必须用**运行中主机的实测**裁决，不能靠推断：
 *
 *   A. 「非 `session-` 前缀 = 打不开」（最初的说法，基于 id 形状）
 *   B. 「`origin == "subagent"` 才是判据；带 `parentSessionId` 也可能是能打开的
 *       fork 会话」（另一个 teammate 的实测结论）
 *
 * 判据错了的代价是真实的：要么把能打开的会话误藏（用户找不到自己的会话），
 * 要么把打不开的会话留在主列表（用户点进去全是错误页）。
 *
 * 本脚本对**每一条**会话真的发一次 `session/page`，按返回结果给三张表：
 *   - id 前缀 vs 能否打开
 *   - origin vs 能否打开
 *   - parentSessionId 有无 vs 能否打开
 * 并打印**反例**（判据预测错的那几条），因为反例才是决定判据的东西。
 *
 * 用法：
 *   node scripts/verify-subagent-classifier.mjs [baseUrl] <username> <password>
 */

const argv = process.argv.slice(2);
const base = (argv[0] ?? 'https://203.0.113.10:2444').replace(/\/+$/, '');
const username = argv[1] ?? 'dsh';
const password = argv[2] ?? process.env.DSH_MOBILE_PASSWORD;

if (!password) {
  console.error('用法: node scripts/verify-subagent-classifier.mjs [baseUrl] <user> <password>');
  process.exit(2);
}

const login = await (
  await fetch(base + '/mobile-gateway/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'classifier-verify', platform: 'android' }),
  })
).json();
const token = login.token;
if (!token) {
  console.error('登录失败:', JSON.stringify(login).slice(0, 160));
  process.exit(1);
}

async function rpc(method, args) {
  const res = await fetch(`${base}/mobile-gateway/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `c${Math.random().toString(36).slice(2)}`,
      method,
      payload: { args },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  return (await res.json()).result;
}

/** 用真实 cursor 打开一页；返回 {openable, reason}。 */
async function canOpen(sessionId) {
  let page = await rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: 1_000_000, maxMessages: 5 },
  });
  const msg = page?.error?.message ?? '';
  const cursor = /past cursor (\d+)/.exec(msg)?.[1];
  if (cursor) {
    page = await rpc('session/page', {
      request: { address: { kind: 'session', sessionId }, throughSeq: Number(cursor), maxMessages: 5 },
    });
  }
  if (page?.ok === true) return { openable: true, reason: '' };
  return { openable: false, reason: String(page?.error?.message ?? '未知').slice(0, 90) };
}

const list = await rpc('session/list', { _request: {} });
const items = list?.value?.items ?? [];
console.log('='.repeat(76));
console.log(`子代理判据复核   目标: ${base}`);
console.log(`会话总数: ${items.length}`);
console.log('='.repeat(76));

const rows = [];
for (const [i, item] of items.entries()) {
  const sessionId = item.sessionId;
  const origin = item.origin ?? null;
  const parent = item.parentSessionId ?? null;
  const prefixed = sessionId.startsWith('session-');
  const r = await canOpen(sessionId);
  rows.push({ sessionId, origin, parent, prefixed, ...r });
  process.stdout.write(`\r  逐条实测 session/page … ${i + 1}/${items.length}`);
}
console.log('\n');

const tally = (label, fn) => {
  const groups = new Map();
  for (const r of rows) {
    const k = fn(r);
    const g = groups.get(k) ?? { total: 0, openable: 0, unopenable: 0 };
    g.total += 1;
    if (r.openable) g.openable += 1;
    else g.unopenable += 1;
    groups.set(k, g);
  }
  console.log(`\n■ ${label}`);
  for (const [k, g] of [...groups.entries()].sort()) {
    console.log(`   ${String(k).padEnd(28)} 共 ${String(g.total).padStart(3)}  可打开 ${String(g.openable).padStart(3)}  打不开 ${String(g.unopenable).padStart(3)}`);
  }
  return groups;
};

tally('判据 A：id 是否带 `session-` 前缀', (r) => (r.prefixed ? 'session- 前缀' : '非 session- 前缀'));
tally('判据 B：origin 字段', (r) => `origin=${r.origin === null ? '(无)' : r.origin}`);
tally('判据 C：是否有 parentSessionId', (r) => (r.parent ? '有 parentSessionId' : '无 parentSessionId'));

// ---- 反例才是决定判据的东西 ----------------------------------------------
console.log('\n' + '='.repeat(76));
console.log('反例（判据预测错的那几条）');
console.log('='.repeat(76));

const falseHide = rows.filter((r) => r.parent !== null && r.origin === null && r.openable);
console.log(`\n[A] 「origin==subagent || parent!=null」会**误藏**的（有 parent、无 origin、但能打开）：${falseHide.length}`);
for (const r of falseHide) console.log(`    ${r.sessionId}  origin=${r.origin}  → 能打开`);

const falseShow = rows.filter((r) => r.origin !== 'subagent' && !r.openable);
console.log(`\n[B] 「只认 origin==subagent」会**漏藏**的（非 subagent、但打不开）：${falseShow.length}`);
for (const r of falseShow.slice(0, 12)) console.log(`    ${r.sessionId}  origin=${r.origin}  → ${r.reason}`);

const prefixWrong = rows.filter((r) => !r.prefixed && r.openable);
console.log(`\n[C] 「非 session- 前缀 = 打不开」会**误藏**的：${prefixWrong.length}`);

console.log('\n' + '='.repeat(76));
console.log('结论建议');
console.log('='.repeat(76));
const originPerfect = falseShow.length === 0;
console.log(`  只认 origin=="subagent"：误藏 ${falseHide.length} 条、漏藏 ${falseShow.length} 条 → ${originPerfect ? '✅ 判据精确' : '⚠️ 仍有误差'}`);
console.log(`  用 parent!=null 兜底：会误藏 ${falseHide.length} 条能打开的会话 → ${falseHide.length ? '❌ 不要用' : '无差异'}`);
console.log(`  用 id 前缀：会误藏 ${prefixWrong.length} 条能打开的会话 → ${prefixWrong.length ? '❌ 不要用' : '无差异'}`);

const subCount = rows.filter((r) => r.origin === 'subagent').length;
const unopenable = rows.filter((r) => !r.openable).length;
console.log(`\n  实测：origin=="subagent" ${subCount} 条；实际打不开 ${unopenable} 条`);
process.exit(0);
