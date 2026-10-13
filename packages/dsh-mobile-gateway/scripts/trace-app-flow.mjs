#!/usr/bin/env node
/**
 * 手工走一遍 App 的完整链路，打印每一步的**原始响应**，用于定位失败点。
 * 与 act-as-app.mjs 的区别：这里不做断言，只如实打印，便于看真实报错。
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:19387').replace(/\/+$/, '');

function show(label, obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  console.log(`\n--- ${label} ---`);
  console.log(text.length > 900 ? text.slice(0, 900) + '…' : text);
}

// 1. 铸码
const mintRes = await fetch(`${base}/mobile-gateway/manage/api/mint`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
const mint = await mintRes.json();
show('mint', mint);
const code = mint?.pairing?.display;
if (!code) {
  console.log('没有拿到配对码，停止');
  process.exit(1);
}

// 2. 配对
const pairRes = await fetch(`${base}/mobile-gateway/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, deviceName: 'probe', platform: 'android' }),
});
const pairText = await pairRes.text();
show(`pair (HTTP ${pairRes.status})`, pairText);
let token = null;
try {
  token = JSON.parse(pairText)?.token ?? null;
} catch {
  /* 忽略 */
}
if (!token) {
  console.log('没有拿到 token，停止');
  process.exit(1);
}

// 3. host.describe —— 打印原始响应
for (const method of ['host.describe', 'session.list']) {
  const rpcId = `r${Date.now()}`;
  const res = await fetch(`${base}/mobile-gateway/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: {} }),
  });
  const text = await res.text();
  show(`${method} (HTTP ${res.status}, rpcId=${rpcId})`, text);
}

// 4. 下行流：打印关闭码与原因
const { WebSocket } = await import('ws');
for (const [label, path] of [['mux', '/mobile-gateway/events.mux'], ['host', '/mobile-gateway/events.host']]) {
  const result = await new Promise((resolve) => {
    const frames = [];
    const ws = new WebSocket(base.replace(/^http/, 'ws') + path, {
      headers: { authorization: `Bearer ${token}` },
    });
    const done = (why) => {
      try { ws.close(); } catch { /* 忽略 */ }
      resolve({ why, frames });
    };
    ws.on('open', () => setTimeout(() => done('timeout-4s'), 4000));
    ws.on('message', (d) => {
      frames.push(String(d));
      if (frames.length >= 2) done('got-frames');
    });
    ws.on('error', (e) => done(`error:${e.message}`));
    ws.on('close', (code, reason) => done(`closed:${code} ${reason?.toString() ?? ''}`));
  });
  show(`${label} 流（${result.why}）`, result.frames.length ? result.frames : '(无帧)');
}
