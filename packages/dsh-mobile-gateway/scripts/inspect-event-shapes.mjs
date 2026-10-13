#!/usr/bin/env node
/**
 * 抓取真实事件的 data 形状，验证 App 的 JsonRender 能否正确渲染。
 *
 * 背景：verify-app-protocol.mjs 显示「含可渲染文本 36/94」，样例输出
 * `[object Object]` —— 说明 App 的启发式抽取对部分事件类型不对。
 * 这直接影响用户在 App 里看到什么。
 *
 * 用法：node scripts/inspect-event-shapes.mjs [base]
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
  body: JSON.stringify({ code: mint?.pairing?.display, deviceName: 'inspect', platform: 'android' }),
})).json();
const token = pair?.token;

async function call(endpoint, args) {
  const res = await fetch(`${base}/mobile-gateway/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: endpoint, payload: { args } }),
  });
  return (await res.json())?.result;
}

// 拿会话列表，挑一个 running 的
const list = await call('session/list', { _request: {} });
const sid = list.value.items.find((i) => i.running)?.sessionId ?? list.value.items[0]?.sessionId;
if (!sid) {
  console.error('没有会话');
  process.exit(1);
}

// 翻页（先用小 throughSeq 试探 cursor）
let paged = await call('session/page', {
  request: { address: { kind: 'session', sessionId: sid }, throughSeq: 100000, maxMessages: 60 },
});
if (!paged.ok) {
  const m = /past cursor (\d+)/.exec(paged.error?.message ?? '');
  if (m) {
    paged = await call('session/page', {
      request: { address: { kind: 'session', sessionId: sid }, throughSeq: Number(m[1]), maxMessages: 60 },
    });
  }
}
if (!paged.ok) {
  console.error('翻页失败:', paged.error);
  process.exit(1);
}

const records = paged.value.records ?? [];
console.log(`\n会话 ${sid}\n共 ${records.length} 条记录\n`);

// 按事件类型分组，每组打印第一条的完整形状
const byType = new Map();
for (const r of records) {
  const t = r.event?.type ?? '(无 type)';
  if (!byType.has(t)) byType.set(t, []);
  byType.get(t).push(r.event);
}

for (const [type, events] of [...byType].sort()) {
  const e = events[0];
  console.log(`=== ${type}  (${events.length} 条) ===`);
  console.log(`  seq=${e.seq}`);
  console.log(`  data 顶层键: ${Object.keys(e.data ?? {}).join(', ') || '(空)'}`);
  // 打印 data 的紧凑形状
  const shape = {};
  for (const [k, v] of Object.entries(e.data ?? {})) {
    if (v === null) shape[k] = 'null';
    else if (Array.isArray(v)) shape[k] = `array[${v.length}]`;
    else if (typeof v === 'object') shape[k] = `{${Object.keys(v).slice(0, 5).join(',')}}`;
    else if (typeof v === 'string') shape[k] = v.length > 60 ? `string(${v.length}) "${v.slice(0, 60)}…"` : `"${v}"`;
    else shape[k] = `${typeof v} ${v}`;
  }
  console.log(`  data 形状: ${JSON.stringify(shape)}`);
  console.log('');
}

// ---- 模拟 App 的 JsonRender，看能否抽出文本 ------------------------------
console.log('=== 模拟 App 的 JsonRender.textOf() ===\n');
function textOf(el) {
  if (!el || typeof el !== 'object') return null;
  if (Array.isArray(el)) return el.map(textOf).filter(Boolean).join('\n') || null;
  const type = el.type;
  if (type === 'text' || type === 'output_text' || type === 'reasoning_text') return el.text ?? null;
  if (type === 'tool_use' || type === 'tool' || type === 'tool-call') return null;
  if (type === 'image' || type === 'image_url') return '[图片]';
  const direct = el.text ?? el.value ?? el.body ?? el.summary ?? el.preview ?? el.title;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const nested = el.content ?? el.message ?? el.data;
  if (nested) return textOf(nested);
  return null;
}

let ok = 0;
let bad = 0;
for (const r of records) {
  const t = r.event?.type;
  if (!['assistant/message', 'tool/call', 'tool/result'].includes(t)) continue;
  const got = textOf(r.event?.data);
  const isObj = got === '[object Object]' || /^\[object /.test(got ?? '');
  if (isObj) bad += 1;
  else ok += 1;
  if (bad <= 3 && isObj) {
    console.log(`  ❌ ${t}: ${String(got).slice(0, 80)}`);
    console.log(`     data=${JSON.stringify(r.event.data).slice(0, 300)}`);
  }
}
console.log(`\n  可正常渲染 ${ok} 条 / 渲染异常 ${bad} 条`);
if (bad > 0) console.log('  → JsonRender 需要按上面打印的真实形状修正');
