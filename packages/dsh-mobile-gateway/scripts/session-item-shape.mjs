#!/usr/bin/env node
/** 精确提取 session/list 单条 item 的关键字段（避免全量 JSON 刷屏）。 */
const base = 'http://127.0.0.1:19387';

const mint = await (await fetch(`${base}/mobile-gateway/manage/api/mint`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})).json();
const pair = await (await fetch(`${base}/mobile-gateway/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: mint?.pairing?.display, deviceName: 'shape', platform: 'android' }),
})).json();
const token = pair?.token;

const res = await fetch(`${base}/mobile-gateway/api/session/list`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: { _request: {} } } }),
});
const items = (await res.json())?.result?.value?.items ?? [];
const it = items[0];

console.log(`\n共 ${items.length} 条会话`);
console.log(`\n=== 单条 item 的顶层键 ===\n  ${Object.keys(it).join(', ')}`);

console.log(`\n=== 关键字段值 ===`);
console.log(`  sessionId : ${it.sessionId}`);
console.log(`  updatedAt : ${it.updatedAt}`);
console.log(`  running   : ${it.running}`);
console.log(`  blank     : ${it.blank}`);
console.log(`  agentAvailable: ${it.agentAvailable}`);
console.log(`  cwd       : ${it.cwd}`);

console.log(`\n=== projections 结构 ===`);
const proj = it.projections ?? {};
console.log(`  顶层键: ${Object.keys(proj).join(', ')}`);
const vals = proj.values ?? {};
console.log(`  values 键: ${Object.keys(vals).join(', ')}`);
console.log(`\n  values.title = ${JSON.stringify(vals.title)}`);
console.log(`  values.goal  = ${JSON.stringify(vals.goal)?.slice(0, 120)}`);
console.log(`  asOfSeq      = ${proj.asOfSeq}`);

console.log(`\n=== 其它可能的标题字段 ===`);
for (const k of ['title', 'lastPromptAt', 'sessionListMetadata']) {
  if (it[k] !== undefined) console.log(`  item.${k} = ${JSON.stringify(it[k])?.slice(0, 120)}`);
}
console.log(`\n  sessionListMetadata = ${JSON.stringify(it.sessionListMetadata)}`);
console.log(`  modelSelection = ${JSON.stringify(it.modelSelection)?.slice(0, 160)}`);
