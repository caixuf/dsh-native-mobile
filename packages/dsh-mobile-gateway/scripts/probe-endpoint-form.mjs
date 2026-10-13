#!/usr/bin/env node
/**
 * 判定真实主机接受的 endpoint 形式：点号 `session.list` 还是斜杠 `session/list`。
 *
 * 依据（从 app.asar 抠出的 @deepseek-ai/dsh-api-gateway/lib/index.js）：
 *   function endpointOf(namespace, method) { return `${namespace}/${method}`; }
 *   claimsEndpoint(endpoint) { return this.srcClaims.has(endpoint); }
 *   // connection 的 endpointFromPath 要求 pathname 以 `${channel}/` 开头，
 *   // 且各段非空、匹配 /^[A-Za-z0-9_$.-]+$/
 *
 * 用法：node scripts/probe-endpoint-form.mjs [base]
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:19387').replace(/\/+$/, '');

// 先配对拿 token
const mintRes = await fetch(`${base}/mobile-gateway/manage/api/mint`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
const code = (await mintRes.json())?.pairing?.display;
if (!code) {
  console.error('拿不到配对码');
  process.exit(1);
}
const pairRes = await fetch(`${base}/mobile-gateway/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, deviceName: 'probe', platform: 'android' }),
});
const token = (await pairRes.json())?.token;
if (!token) {
  console.error('拿不到 token');
  process.exit(1);
}

/** 直接打 /api/<path>，看主机的原始响应。 */
async function raw(path) {
  const res = await fetch(`${base}/mobile-gateway/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: path, payload: {} }),
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 200) };
}

console.log('\n探测真实主机接受的 endpoint 形式：\n');
for (const candidate of [
  'host.describe',
  'host/describe',
  'session.list',
  'session/list',
  'session.page',
  'session/page',
]) {
  const r = await raw(candidate);
  const verdict = r.status === 404 && r.body.trim() === 'not found' ? '❌ 未被认领（404 not found）' : '✅ 被认领';
  console.log(`  ${candidate.padEnd(18)} HTTP ${String(r.status).padEnd(4)} ${verdict}`);
  console.log(`      ${r.body.replace(/\s+/g, ' ')}`);
}
