#!/usr/bin/env node
/**
 * @file scripts/public-write-test.mjs
 * @description 公网写路径实测：登录 → 建会话 → 发消息 → 读回 → 取消。
 *
 * 为什么单独写这个：模拟器 UI 自动化在**中文输入法**上不稳（`adb shell input text`
 * 传中文直接 NPE，键盘弹出还会遮住发送按钮），而写路径的正确性只取决于**协议**。
 * 这里用与 App 完全相同的信封、endpoint、args 形状打同一个公网网关，
 * 把「协议对不对」与「UI 点得到点不到」两件事分开验证。
 *
 * 用法：
 *   node scripts/public-write-test.mjs <baseUrl> <username> <password>
 *   例：node scripts/public-write-test.mjs https://203.0.113.10:2444 dsh XXXXXXXX
 */

const base = (process.argv[2] ?? 'https://203.0.113.10:2444').replace(/\/+$/, '');
const username = process.argv[3] ?? 'dsh';
const password = process.argv[4];

if (!password) {
  console.error('用法: node scripts/public-write-test.mjs <baseUrl> <user> <password>');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(ok, name, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(48)} ${detail}`);
}

async function post(path, body, token) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留原始文本 */ }
  return { status: res.status, text, json };
}

/** 与 App 的 Envelopes.clientRequest 逐字同构。 */
function clientRequest(rpcId, method, args) {
  return { type: 'client-request', rpcId, method, payload: { args } };
}

let rpcSeq = 0;
async function rpc(method, args, token) {
  rpcSeq += 1;
  const rpcId = `pw${rpcSeq}-${Date.now()}`;
  const r = await post(`/mobile-gateway/api/${method}`, clientRequest(rpcId, method, args), token);
  const result = r.json?.result;
  return {
    status: r.status,
    rpcId,
    ok: result?.ok === true,
    value: result?.value,
    error: result?.error,
    raw: r.text,
  };
}

console.log('='.repeat(72));
console.log(`公网写路径实测   目标: ${base}`);
console.log('='.repeat(72));

// ---- 1. 登录 --------------------------------------------------------------
console.log('\n[1] 登录（与 App 同一入口）');
const login = await post('/mobile-gateway/login', {
  username, password, deviceName: 'public-write-test', platform: 'android',
});
check(login.status === 200, 'POST /mobile-gateway/login → 200', `HTTP ${login.status}`);
const token = login.json?.token;
check(!!token, '拿到设备令牌', token ? `len=${token.length}` : login.text.slice(0, 100));
if (!token) {
  console.log('\n无法继续：没有令牌。');
  process.exit(1);
}

// ---- 2. 读路径（先确认基线可用）-------------------------------------------
console.log('\n[2] 读路径基线');
const list = await rpc('session/list', { _request: {} }, token);
check(list.ok, 'session/list → result.ok', list.ok ? '' : JSON.stringify(list.error)?.slice(0, 120));
const items = list.value?.items ?? [];
check(Array.isArray(items) && items.length > 0, '返回会话数组', `${items.length} 个`);

// ---- 3. 新建会话 ----------------------------------------------------------
console.log('\n[3] 写路径：新建会话');
const created = await rpc('session/create', { request: {} }, token);
check(created.ok, 'session/create → result.ok', created.ok ? '' : JSON.stringify(created.error)?.slice(0, 160));
const sid = created.value?.sessionId ?? created.value?.id ?? created.value?.session?.sessionId;
check(!!sid, '拿到新 sessionId', sid ?? JSON.stringify(created.value)?.slice(0, 160));

if (!sid) {
  console.log('\n无法继续：没拿到 sessionId。');
  process.exit(1);
}

// ---- 4. 发消息（写路径核心）-----------------------------------------------
console.log('\n[4] 写路径：发消息（App 的真实 args 形状）');
const promptArgs = {
  request: {
    requestId: crypto.randomUUID(),
    sessionId: sid,
    mode: 'queue',
    content: [{ type: 'text', text: 'E2E 公网写路径测试：请只回复 OK 两个字。' }],
  },
};
const prompted = await rpc('session/prompt', promptArgs, token);
check(prompted.ok, 'session/prompt → result.ok', prompted.ok ? '' : JSON.stringify(prompted.error)?.slice(0, 200));

// 负例：缺 requestId 必须被主机拒（证明这个字段确实必填，不是我们多写）
const missingId = await rpc('session/prompt', {
  request: { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: 'x' }] },
}, token);
check(!missingId.ok, '缺 requestId → 被主机拒绝（证明必填）',
  missingId.ok ? '竟然成功了，说明 requestId 其实可选' : String(missingId.error?.message ?? '').slice(0, 90));

// ---- 5. 读回（session/page）-----------------------------------------------
console.log('\n[5] 读回：session/page');
let page = await rpc('session/page', {
  request: { address: { kind: 'session', sessionId: sid }, throughSeq: 1_000_000, maxMessages: 30 },
}, token);
let cursorMsg = page.error?.message ?? '';
let cursor = Number(/past cursor (\d+)/.exec(cursorMsg)?.[1]);
if (Number.isFinite(cursor) && cursor > 0) {
  check(true, '主机自报 cursor', cursorMsg.slice(0, 60));
  page = await rpc('session/page', {
    request: { address: { kind: 'session', sessionId: sid }, throughSeq: cursor, maxMessages: 30 },
  }, token);
}
check(page.ok, 'session/page → result.ok', page.ok ? '' : JSON.stringify(page.error)?.slice(0, 160));
const records = page.value?.records ?? [];
check(Array.isArray(records), '返回 records 数组', `${records.length} 条`);
const types = [...new Set(records.map((r) => r?.event?.type).filter(Boolean))];
console.log(`      事件类型: ${types.slice(0, 8).join(', ') || '(空)'}`);
const sawUser = records.some((r) => r?.event?.type === 'user/message');
check(sawUser, '读回包含刚发的 user/message', sawUser ? '' : `类型=${types.join(',')}`);

// ---- 6. 搜索 / 取消 -------------------------------------------------------
console.log('\n[6] 其余写路径');
const search = await rpc('session/search', { request: { query: '测试' } }, token);
check(search.ok, 'session/search → result.ok', search.ok ? '' : JSON.stringify(search.error)?.slice(0, 120));
const cancel = await rpc('session/cancel', { request: { sessionId: sid } }, token);
check(cancel.ok, 'session/cancel → result.ok', cancel.ok ? '' : JSON.stringify(cancel.error)?.slice(0, 120));

// ---- 7. 特权闸门仍然生效 --------------------------------------------------
console.log('\n[7] 特权闸门（公网上必须仍被拒）');
for (const m of ['settings/describe', 'credentials/set', 'pluginManager/install']) {
  const r = await rpc(m, {}, token);
  check(!r.ok, `${m} → 被拒`, String(r.error?.code ?? '').slice(0, 40));
}

console.log('\n' + '='.repeat(72));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
