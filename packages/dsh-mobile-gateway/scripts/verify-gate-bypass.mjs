#!/usr/bin/env node
/**
 * 验证 verifier 报告的绕过：`./` 与 `../` 路径段能否绕过特权闸门。
 *
 * 机理：闸门看的是**归一化前**的字符串，而 `new Request()` 构造上游 URL 时会归一化。
 * 于是 `./settings.describe` 通过闸门，到了上游却变成 `settings.describe`。
 *
 * 用法：node scripts/verify-gate-bypass.mjs [base]
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:19387').replace(/\/+$/, '');

const mint = await (await fetch(`${base}/mobile-gateway/manage/api/mint`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})).json();
const pair = await (await fetch(`${base}/mobile-gateway/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: mint?.pairing?.display, deviceName: 'bypass', platform: 'android' }),
})).json();
const token = pair?.token;
if (!token) {
  console.error('拿不到 token');
  process.exit(2);
}

/** 直接拼 URL，不经过任何客户端归一化 —— 模拟攻击者。 */
async function probe(rawPath) {
  const res = await fetch(`${base}${rawPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'x', payload: { args: {} } }),
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 140).replace(/\s+/g, ' ') };
}

const targets = [
  ['基准（应被拦）', '/mobile-gateway/api/settings.describe'],
  ['./ 绕过尝试', '/mobile-gateway/api/./settings.describe'],
  ['x/../ 绕过尝试', '/mobile-gateway/api/x/../settings.describe'],
  ['// 绕过尝试', '/mobile-gateway/api//settings.describe'],
  ['%2e/ 编码绕过', '/mobile-gateway/api/%2e/settings.describe'],
  ['credentials 基准', '/mobile-gateway/api/credentials.set'],
  ['credentials ./ 绕过', '/mobile-gateway/api/./credentials.set'],
];

console.log('\n特权闸门绕过探测（403 = 被拦，其他 = 可能绕过）：\n');
let vulnerable = 0;
for (const [label, path] of targets) {
  const r = await probe(path);
  const blocked = r.status === 403;
  if (!blocked) vulnerable += 1;
  console.log(`  ${blocked ? '✅ 拦住' : '🔴 绕过!'} ${label.padEnd(22)} HTTP ${String(r.status).padEnd(4)} ${r.body}`);
}

console.log(`\n${vulnerable === 0 ? '未发现绕过' : `发现 ${vulnerable} 处可能绕过`}`);
process.exit(vulnerable === 0 ? 0 : 1);
