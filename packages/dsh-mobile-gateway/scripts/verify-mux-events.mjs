#!/usr/bin/env node
/**
 * @file scripts/verify-mux-events.mjs
 * @description 端到端验证「事件流 + 审批应答」——需要**真实主机**（DSH 已重启）。
 *
 * 这是本项目最后一块拼图。此前所有相关结论都只是**静态取证**
 * （从 app.asar 读源码 + 对着桩宿主跑 e2e），从未与真实 `typertGateway` 对接过。
 * 本脚本补上这一环：
 *
 *   1. 登录拿设备令牌（login 响应会广告 `stream:{mux, eventEndpoint}`）
 *   2. 连 `/mobile-gateway/remote.mux`，open `$events` 逻辑流 → 应收到 `ready`（带 clientId）
 *   3. 制造一次**真实 turn**（发消息），观察是否推出 `emit` / `waterfall` 帧
 *   4. 若有 `waterfall`（审批/提问），用 `$events/result` 应答，验证结算
 *
 * 用法：
 *   node scripts/verify-mux-events.mjs [baseUrl] <user> <password>
 */

const argv = process.argv.slice(2);
const base = (argv[0] ?? 'http://127.0.0.1:19387').replace(/\/+$/, '');
const username = argv[1] ?? 'dsh';
const password = argv[2] ?? process.env.DSH_PW;

if (!password) {
  console.error('用法: node scripts/verify-mux-events.mjs [baseUrl] <user> <password>');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (ok, name, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(46)} ${detail}`);
};

console.log('='.repeat(74));
console.log(`事件流端到端验证（真实主机）   目标: ${base}`);
console.log('='.repeat(74));

// ---- 1. 登录 --------------------------------------------------------------
const login = await (
  await fetch(`${base}/mobile-gateway/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'mux-verify', platform: 'android' }),
  })
).json();
const token = login.token;
check(!!token, '登录拿到令牌', token ? `len=${token.length}` : JSON.stringify(login).slice(0, 110));
if (!token) process.exit(1);
check(
  login.stream?.mux === '/mobile-gateway/remote.mux' && login.stream?.eventEndpoint === '$events',
  'login 广告的 stream 字段正确',
  JSON.stringify(login.stream),
);

// ---- RPC 助手 -------------------------------------------------------------
let seq = 0;
async function rpc(method, args) {
  const rpcId = `v${++seq}-${Date.now()}`;
  const res = await fetch(`${base}/mobile-gateway/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  return json.result;
}

// ---- 2. 连 mux 并开 $events ----------------------------------------------
const wsUrl = base.replace(/^http/, 'ws') + '/mobile-gateway/remote.mux';
const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });

const frames = [];
let clientId = null;
let waterfallFrame = null;
const waiters = [];

function onFrame(value) {
  frames.push(value);
  if (value.type === 'ready') clientId = value.clientId;
  if (value.type === 'waterfall' && !waterfallFrame) waterfallFrame = value;
  for (const w of [...waiters]) w();
}

const opened = new Promise((resolve) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'open', streamId: 'verify-1', endpoint: '$events', payload: { args: {} } }));
    resolve(true);
  };
  ws.onerror = () => resolve(false);
  ws.onmessage = (e) => {
    let outer;
    try { outer = JSON.parse(String(e.data)); } catch { return; }
    if (outer.type === 'item' && outer.value) onFrame(outer.value);
    if (outer.type === 'error') console.log('      mux error 帧:', JSON.stringify(outer.error).slice(0, 160));
  };
});

/** 等到某个条件成立或超时。 */
async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => {
      waiters.push(r);
      setTimeout(r, 250);
    });
  }
  return false;
}

console.log('\n[1] mux + $events');
const isOpen = await opened;
check(isOpen, 'remote.mux 升级成功', wsUrl);

const gotReady = await waitFor(() => clientId !== null, 8_000);
check(gotReady, '$events 推出 ready 帧（带 clientId）', clientId ? `clientId=${clientId}` : '未收到');
check(
  frames.find((f) => f.type === 'ready')?.host?.home !== undefined,
  'ready 帧带 host.home',
  JSON.stringify(frames.find((f) => f.type === 'ready')?.host ?? {}),
);

// ---- 3. 制造真实 turn，观察是否推出事件 -----------------------------------
console.log('\n[2] 制造真实 turn（发一条消息）');
const created = await rpc('session/create', { request: {} });
const sid = created?.value?.sessionId;
check(!!sid, '新建会话拿到 sessionId', sid ?? JSON.stringify(created).slice(0, 120));

if (sid) {
  const before = frames.length;
  const prompted = await rpc('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: '只回复两个字：收到' }],
    },
  });
  check(prompted?.ok === true, 'session/prompt 成功', prompted?.ok ? '' : JSON.stringify(prompted?.error)?.slice(0, 120));

  // 真实 turn 需要时间；事件应在期间推来
  const gotEvents = await waitFor(
    () => frames.slice(before).some((f) => f.type === 'emit' || f.type === 'waterfall'),
    25_000,
  );
  const kinds = {};
  for (const f of frames) kinds[f.type] = (kinds[f.type] ?? 0) + 1;
  check(gotEvents, 'turn 期间推出 emit/waterfall 帧', JSON.stringify(kinds));

  const emits = frames.filter((f) => f.type === 'emit');
  if (emits.length) {
    const names = [...new Set(emits.map((f) => f.event))];
    console.log(`      emit 事件名: ${names.slice(0, 8).join(', ')}`);
    check(names.length > 0, 'emit 帧带可识别的事件名', `${names.length} 种`);
  }
}

// ---- 4. waterfall（审批/提问）与应答 --------------------------------------
console.log('\n[3] waterfall 与 $events/result 应答');
const waterfalls = frames.filter((f) => f.type === 'waterfall');
if (!waterfalls.length) {
  console.log('      （本次 turn 未产生 waterfall —— 审批/提问是按需触发的，属正常）');
  console.log('      结论：端点存在性与结算逻辑**未能在本次覆盖**，需触发一次真实审批');
} else {
  const wf = waterfalls[0];
  check(!!wf.eventId, 'waterfall 帧带 eventId', wf.eventId);
  check(!!wf.event, 'waterfall 帧带 event 名', wf.event);

  // 用 clientId + eventId 应答
  const r = await rpc('$events/result', {
    clientId,
    eventId: wf.eventId,
    outcome: { kind: 'rejected', error: { name: 'Error', message: 'verify-mux-events 自动拒绝' } },
  });
  check(r?.ok === true, '$events/result 被主机接受（结算成功）',
    r?.ok ? '' : JSON.stringify(r?.error)?.slice(0, 160));
}

// ---- 汇总 -----------------------------------------------------------------
const tally = {};
for (const f of frames) tally[f.type] = (tally[f.type] ?? 0) + 1;
console.log(`\n收到帧类型统计: ${JSON.stringify(tally)}`);
console.log('\n' + '='.repeat(74));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(74));
try { ws.close(); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
