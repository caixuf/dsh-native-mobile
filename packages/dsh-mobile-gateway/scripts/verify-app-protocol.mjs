#!/usr/bin/env node
/**
 * 用与修正后 Kotlin 端**逐字一致**的协议逻辑，打真实网关验证。
 *
 * 对照点（都是真实主机实测出来的）：
 *   endpoint 斜杠形式     session/list
 *   payload { args: … }   args 键 = 服务端形参名
 *   session/list → _request ；其余 → request
 *   throughSeq 不能超 cursor（超了回 "past cursor N"，用 N 重试）
 *
 * 用法：node scripts/verify-app-protocol.mjs [base]
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:19387').replace(/\/+$/, '');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

// ---- 与 Kotlin 端同构的实现 ----------------------------------------------
const DEFAULT_THROUGHPUT_SEQ = 1_000_000;

/** Envelopes.toEndpoint */
function toEndpoint(dotted) {
  const i = dotted.indexOf('.');
  return i < 0 ? dotted : `${dotted.slice(0, i)}/${dotted.slice(i + 1)}`;
}

/** Envelopes.clientRequest */
function clientRequest(rpcId, method, args) {
  return {
    type: 'client-request',
    rpcId,
    method: toEndpoint(method),
    payload: { args },
  };
}

let token = null;
let cursor = 0;

/** DshConnection.call */
async function call(method, args, timeoutMs = 30000) {
  const endpoint = toEndpoint(method);
  const rpcId = `r${Math.floor(Math.random() * 1e9)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/mobile-gateway/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(clientRequest(rpcId, method, args)),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return { ok: false, error: `响应不是 JSON: ${text.slice(0, 120)}` };
    }
    if (frame.rpcId !== rpcId) return { ok: false, error: `rpcId 不匹配` };
    const result = frame.result;
    if (result?.ok === true) return { ok: true, value: result.value };
    return { ok: false, error: `${result?.error?.code}: ${result?.error?.message}` };
  } catch (e) {
    return { ok: false, error: String(e.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/** ChatViewModel.fetchPage 的 cursor 自适应 */
async function fetchPage(sessionId, maxMessages) {
  const guess = cursor > 0 ? cursor : DEFAULT_THROUGHPUT_SEQ;
  const makeArgs = (throughSeq) => ({
    request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages },
  });
  let r = await call('session.page', makeArgs(guess));
  if (!r.ok) {
    const m = /past cursor (\d+)/.exec(r.error ?? '');
    if (m) {
      cursor = Number(m[1]);
      r = await call('session.page', makeArgs(cursor));
    }
  }
  return r;
}

// ---- 开始验证 -------------------------------------------------------------
console.log(`\n目标：${base}\n`);

// 配对
const mint = await (await fetch(`${base}/mobile-gateway/manage/api/mint`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})).json();
const pair = await (await fetch(`${base}/mobile-gateway/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: mint?.pairing?.display, deviceName: 'verify-app', platform: 'android' }),
})).json();
token = pair?.token;
check('配对拿到设备令牌', !!token);

console.log('\n[1] 就绪探测（App 现在用 session/list 做握手）');
const probe = await call('session.list', { _request: {} });
check('session.list 成功（握手可用）', probe.ok, probe.error);

console.log('\n[2] 会话列表');
const items = probe.value?.items;
check('返回 items 数组', Array.isArray(items), typeof items);
if (Array.isArray(items)) {
  console.log(`       会话数=${items.length}`);
  const first = items[0];
  if (first) {
    const title = first.projections?.values?.title ?? '(无标题)';
    console.log(`       首个: ${first.sessionId}`);
    console.log(`       title=${String(title).slice(0, 40)}  running=${first.running}`);
  }
}

console.log('\n[3] 会话内容（cursor 自适应）');
const sid = items?.[0]?.sessionId;
if (sid) {
  const paged = await fetchPage(sid, 20);
  check('session.page 成功', paged.ok, paged.error);
  const records = paged.value?.records;
  check('返回 records 数组', Array.isArray(records), typeof records);
  if (Array.isArray(records)) {
    console.log(`       记录数=${records.length}  cursor=${cursor}`);
    const kinds = [...new Set(records.map((r) => r.event?.type).filter(Boolean))];
    console.log(`       事件类型: ${kinds.slice(0, 8).join(', ')}`);
    // 验证 App 的 JsonRender 能否从真实事件里抽出文本
    const withText = records.filter((r) => {
      const d = r.event?.data;
      return d && typeof d === 'object' && (d.text || d.content || d.message);
    });
    console.log(`       含可渲染文本的记录: ${withText.length}/${records.length}`);
    if (withText[0]) {
      const d = withText[0].event.data;
      const sample = d.text ?? (Array.isArray(d.content) ? d.content[0]?.text : null) ?? d.message;
      console.log(`       样例: ${String(sample).slice(0, 80)}`);
    }
  }
} else {
  check('有会话可翻页', false, '没有会话');
}

console.log('\n[4] 特权方法仍被网关拦住');
for (const m of ['settings.describe', 'credentials.set', 'host.pickDirectory']) {
  const r = await call(m, {});
  // 被网关拦时返回 HTTP 403，call() 会把它折成 "HTTP 403"。
  // 注意：不能用「args 校验失败」当通过 —— 那说明请求已经到达了主机。
  const blocked = !r.ok && !/arguments-invalid|boundary validation/.test(r.error ?? '');
  check(`${m} 被网关拦在主机之前`, blocked, r.error || '(竟然成功了)');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
