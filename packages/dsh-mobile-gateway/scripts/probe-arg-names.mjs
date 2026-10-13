#!/usr/bin/env node
/**
 * 用「故意传错参数」的方式，让真实主机**自己报出**它期望的形参名。
 *
 * 主机的错误信息形如：
 *   args fields do not match the descriptor: missing "_request"; unexpected "x"
 * 这比读源码更权威——它直接反映当前运行实例的 descriptor。
 *
 * 用法：node scripts/probe-arg-names.mjs [base]
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
  body: JSON.stringify({ code: mint?.pairing?.display, deviceName: 'probe', platform: 'android' }),
})).json();
const token = pair?.token;
if (!token) {
  console.error('拿不到 token');
  process.exit(1);
}

/** 传一个必然不存在的键，逼主机报出它真正期望的形参名。 */
async function askNames(endpoint) {
  const res = await fetch(`${base}/mobile-gateway/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'r1',
      method: endpoint,
      payload: { args: { __probe__: 1 } },
    }),
  });
  const text = await res.text();
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j?.result?.error?.message ?? text;
    if (j?.result?.ok === true) return { endpoint, ok: true, names: '(无需参数，直接成功)' };
  } catch {
    /* 保留原文 */
  }
  // 从错误信息里抠出形参名：missing "a", "b"; unexpected "c"
  const missing = [...msg.matchAll(/missing\s+((?:"[^"]+"(?:,\s*)?)+)/g)]
    .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  return { endpoint, ok: false, names: missing.join(', ') || `(未能解析) ${msg.slice(0, 160)}` };
}

const endpoints = [
  'session/list',
  'session/page',
  'session/create',
  'session/prompt',
  'session/cancel',
  'session/search',
  'session/rename',
  'session/fork',
  'session/models',
  'session/selectModel',
  'host/describe',
  'workspace/list',
];

console.log('\n让真实主机自报形参名：\n');
for (const e of endpoints) {
  const r = await askNames(e);
  const mark = r.ok ? '✅' : '  ';
  console.log(`  ${mark} ${e.padEnd(22)} ${r.names}`);
}
