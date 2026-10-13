#!/usr/bin/env node
/**
 * 探测真实主机接受的 **payload 形状**。
 *
 * 线索：用 `session/list` 时主机回
 *   {"code":"gateway/internal","message":"Remote payload must contain exactly one plain-object args field"}
 * 说明 payload 不是裸 `{}`，而要包成 `{ args: {...} }`。
 *
 * 用法：node scripts/probe-payload-shape.mjs [base]
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:19387').replace(/\/+$/, '');

const mint = await (await fetch(`${base}/mobile-gateway/manage/api/mint`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})).json();
const code = mint?.pairing?.display;
const pair = await (await fetch(`${base}/mobile-gateway/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, deviceName: 'probe', platform: 'android' }),
})).json();
const token = pair?.token;
if (!token) {
  console.error('拿不到 token');
  process.exit(1);
}

async function call(endpoint, payload) {
  const res = await fetch(`${base}/mobile-gateway/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: endpoint, payload }),
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 400) };
}

const cases = [
  ['session/list', {}],
  ['session/list', { args: {} }],
  ['session/list', { args: { request: {} } }],
  ['session/list', { args: { _request: {} } }],
  ['host/describe', { args: {} }],
  ['session/page', { args: { address: { kind: 'session', sessionId: 'x' }, throughSeq: 1 } }],
];

console.log('\n探测 payload 形状：\n');
for (const [endpoint, payload] of cases) {
  const r = await call(endpoint, payload);
  console.log(`  ${endpoint}  payload=${JSON.stringify(payload)}`);
  console.log(`    HTTP ${r.status}  ${r.body.replace(/\s+/g, ' ')}`);
  console.log('');
}
