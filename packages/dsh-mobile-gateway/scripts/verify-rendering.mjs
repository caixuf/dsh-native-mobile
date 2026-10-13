#!/usr/bin/env node
/**
 * 用 Node 精确复刻修正后的 Kotlin 渲染逻辑，跑真实数据验证。
 *
 * 对照对象：
 *   - render/JsonRender.kt  的 str/long/typeOf/roleOf/textOf
 *   - ui/ChatViewModel.kt  的 toLine（含事件类型白名单与 tool/call 特例）
 *
 * 这能在没有 Android 设备的情况下验证「用户在 App 里会看到什么」。
 *
 * 用法：node scripts/verify-rendering.mjs [base]
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:19387').replace(/\/+$/, '');

// ---- 复刻 Kotlin 端 -------------------------------------------------------
const TEXT_KEYS = ['text', 'value', 'body', 'summary', 'preview', 'title'];

function str(obj, ...keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return null;
}
function long(obj, ...keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number') return v;
  }
  return null;
}
function typeOf(entry) {
  return str(entry, 'type', 'kind', 'event') ?? 'event';
}
function roleOf(entry) {
  const data = entry.data;
  const message = data?.message;
  const raw = str(data, 'role') ?? str(message, 'role') ?? roleFromType(typeOf(entry));
  const r = String(raw).toLowerCase();
  if (/user|human|prompt/.test(r)) return 'user';
  if (/assistant|model|ai/.test(r)) return 'assistant';
  if (/system/.test(r)) return 'system';
  if (/tool/.test(r)) return 'tool';
  return raw;
}
function roleFromType(kind) {
  if (kind === 'user/message') return 'user';
  if (kind === 'assistant/message') return 'assistant';
  if (kind === 'system/message') return 'system';
  if (kind === 'tool/call' || kind === 'tool/result') return 'tool';
  return 'unknown';
}
/** contentToText：按 content 数组抽正文，避免 [object Object] */
function contentToText(content) {
  if (content === null || content === undefined) return null;
  let parts;
  if (Array.isArray(content)) {
    parts = content.map((el) => {
      if (el && typeof el === 'object' && !Array.isArray(el)) {
        const t = str(el, 'text', 'value');
        if (t) return t;
        const type = str(el, 'type');
        if (type === 'image' || type === 'image_url') return '[图片]';
        // 内嵌工具调用：实测 type 是 tool-call（连字符），不是 tool_use
        if (type === 'tool-call' || type === 'tool_use' || type === 'tool') {
          const name = str(el, 'name', 'tool') ?? '工具';
          const args = el.arguments ?? el.input;
          return args == null ? `调用 ${name}` : `调用 ${name} · ${compact(args, 160)}`;
        }
        return null;
      }
      return textOf(el);
    }).filter(Boolean);
  } else if (content && typeof content === 'object') {
    parts = [str(content, 'text', 'value') ?? textOf(content)].filter(Boolean);
  } else {
    parts = [textOf(content)].filter(Boolean);
  }
  return parts.length ? parts.join('\n') : null;
}
function compact(el, limit = 240) {
  const raw = JSON.stringify(el).replace(/\s+/g, ' ');
  return raw.length <= limit ? raw : raw.slice(0, limit) + '…';
}
function textOf(el) {
  if (el === null || el === undefined) return null;
  if (typeof el === 'string') return el.trim() ? el : null;
  if (typeof el === 'number' || typeof el === 'boolean') return null;
  if (Array.isArray(el)) {
    const parts = el.map(textOf).filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  const type = str(el, 'type');
  if (type === 'text' || type === 'output_text' || type === 'reasoning_text') {
    return str(el, ...TEXT_KEYS);
  }
  if (type === 'tool_use' || type === 'tool' || type === 'tool-call') {
    const name = str(el, 'name', 'tool') ?? '工具';
    const args = el.arguments ?? el.input;
    return args == null ? `调用 ${name}` : `调用 ${name} · ${compact(args, 160)}`;
  }
  if (type === 'image' || type === 'image_url') return '[图片]';
  const direct = str(el, ...TEXT_KEYS);
  if (direct) return direct;
  const nested = el.content ?? el.message ?? el.data;
  if (nested) return textOf(nested);
  return compact(el, 400);
}

/** ChatViewModel.toLine —— 含事件白名单与 tool/call 特例 */
const RENDERABLE = new Set([
  'user/message', 'assistant/message', 'system/message', 'tool/call', 'tool/result',
]);
function toLine(entry, index) {
  if (!entry) return null;
  const seq = long(entry, 'seq') ?? index;
  const kind = typeOf(entry);
  if (!RENDERABLE.has(kind)) return null;
  const role = roleOf(entry);
  const data = entry.data;
  let text;
  if (kind === 'tool/call') {
    const name = str(data, 'name') ?? '工具';
    const args = data?.arguments;
    text = args == null ? `调用 ${name}` : `调用 ${name} · ${compact(args, 200)}`;
  } else {
    // 优先按 content 数组抽正文（tool/result 的正文在 data.message.content[]）
    const content = data?.message?.content ?? data?.content;
    text = contentToText(content) ?? textOf(data) ?? textOf(entry.message) ?? textOf(entry.content);
    if (!text) return null;
  }
  return { key: `${seq}-${kind}-${index}`, role, kind, text };
}

// ---- 拉真实数据 -----------------------------------------------------------
const mint = await (await fetch(`${base}/mobile-gateway/manage/api/mint`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
})).json();
const pair = await (await fetch(`${base}/mobile-gateway/pair`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: mint?.pairing?.display, deviceName: 'render', platform: 'android' }),
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

const list = await call('session/list', { _request: {} });
const sid = list.value.items.find((i) => i.running)?.sessionId ?? list.value.items[0].sessionId;

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

const records = (paged.value.records ?? []).map((r) => r.event);
const lines = records.map((e, i) => toLine(e, i)).filter(Boolean);

console.log(`\n会话 ${sid.slice(0, 24)}…`);
console.log(`记录 ${records.length} 条 → 渲染成 ${lines.length} 行气泡`);
console.log(`过滤掉 ${records.length - lines.length} 条过程事件（step/start 等）\n`);

// 按角色统计
const byRole = {};
for (const l of lines) byRole[l.role] = (byRole[l.role] ?? 0) + 1;
console.log(`角色分布: ${JSON.stringify(byRole)}`);

const byKind = {};
for (const l of lines) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
console.log(`类型分布: ${JSON.stringify(byKind)}\n`);

// 抽样展示：每种角色取 1 条
console.log('=== 抽样（用户在 App 里会看到的样子）===\n');
const seen = new Set();
for (const l of lines) {
  const tag = `${l.role}/${l.kind}`;
  if (seen.has(tag)) continue;
  seen.add(tag);
  const side = l.role === 'user' ? '右侧' : l.role === 'assistant' ? '左侧' : '系统';
  console.log(`  [${side}] ${l.kind}`);
  console.log(`    ${l.text.slice(0, 200).replace(/\n/g, '\n    ')}`);
  console.log('');
}

// ---- 断言 ---------------------------------------------------------------
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

console.log('=== 断言 ===');
check('至少渲染出一些气泡', lines.length > 0, `lines=${lines.length}`);
check('过滤掉了过程事件', lines.length < records.length, `${lines.length} vs ${records.length}`);
check('有用户消息（右侧）', lines.some((l) => l.role === 'user'));
check('有 AI 消息（左侧）', lines.some((l) => l.role === 'assistant'));
check('没有 unknown 角色', !lines.some((l) => l.role === 'unknown'), lines.filter((l) => l.role === 'unknown').map((l) => l.kind).join(','));
check('文本都不为空', lines.every((l) => l.text.trim().length > 0));

// 🔴 渲染器缺陷检测：**不能**直接查文本里有没有 "[object Object]" ——
// 会话内容本身可能包含这四个字（本轮就踩了：历史消息里正好有这句调试输出，
// 于是断言恒红，而渲染器其实没问题）。
// 正确判据：走到 compact() 兜底说明抽取失败，而 compact 的特征是「整条 data 被
// JSON.stringify 后截断」—— 即文本以 `{"` 开头且包含 `"turn":`。
const fellBackToCompact = lines.filter((l) => /^\s*\{".*"turn":/.test(l.text));
check('没有落到 compact() 兜底（抽取真的成功了）', fellBackToCompact.length === 0,
  fellBackToCompact.slice(0, 2).map((l) => `${l.kind}: ${l.text.slice(0, 80)}`).join(' | '));

// 内嵌 tool-call 也应被渲染出来，而不是被丢弃
const withToolCall = lines.filter((l) => l.text.includes('调用 '));
check('工具调用被渲染成可读文本', withToolCall.length > 0, `count=${withToolCall.length}`);

// 会话列表字段
const it = list.value.items[0];
const values = it.projections?.values ?? {};
check('标题来自 projections.values.title', typeof values.title === 'string' && values.title.length > 0, String(values.title));
check('updatedAt 是数字', typeof it.updatedAt === 'number');
check('running 是布尔', typeof it.running === 'boolean');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
