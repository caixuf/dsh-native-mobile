/**
 * 审批 / 提问应答的**协议契约测试**。
 *
 * ## 迁移说明（2026-10-14）
 *
 * 这组断言原本是 Android Kotlin 时代的 `ApprovalContractTest.kt`（11 条），
 * 随 `c3c0bf9` 删除 Kotlin 代码库而**一起消失了** ——
 * 也就是「陷阱还在，护栏没了」。本文件把它迁回当前栈（Web/Electron/Android-WebView 共用一套 `src/`），
 * 并针对 JS 这一侧的真实失败模式做了扩充。
 *
 * ## 为什么这个文件值得存在
 *
 * 主机的审批词表只有**四个裸字符串**：
 *
 *     allowed-once | rejected | cancelled | unavailable
 *
 * **词表外的值不报错、不崩、日志干净 —— 而是被静默归一化成 `unavailable`。**
 * 而 `unavailable` 的语义是「没有审批通道」，落到工具层就是**拒绝**。
 *
 * 于是写错一个值（发 `{approved:true}` 对象、或写成 `"allow"`、或在组件里手写字符串）
 * 的现象是「**用户点了允许，工具却被拒绝**」—— 没有任何报错，排查成本极高。
 *
 * 覆盖率 = 三件事，缺一不可：
 *   ①  构造器产出的值在词表内、且是**裸字符串**             → §A
 *   ②  应答真的以正确 URL / 信封 / 鉴权头发出，且失败会返回 false → §B
 *   ③  **全仓库只有 `envelopes.ts` 能写这些字面量**（源码扫描）   → §C
 *       —— 没有 ③，组件里再手写一遍就等于绕过 ①，「单一事实来源」形同虚设。
 *
 * 运行：
 *
 *     node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs \
 *          scripts/test-approval-contract.mjs
 *
 * （`--import` 的解析 hook 见 scripts/ts-resolve-hook.mjs：源码内部用打包器风格的
 * 无扩展名导入，Node 原生解析不了，这是本组测试过去无法存在的原因之一。）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Envelopes } from '../src/services/envelopes.ts';
import { DshConnection, EVENT_RESULT_ENDPOINT } from '../src/services/connection.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(HERE, '..', 'src');

/** 主机词表（逐字，来自 DSH 宿主端的审批 outcome 枚举）。 */
const HOST_VOCABULARY = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];

// ── 极简断言（与 test-markdown.mjs / test-incremental.mjs 同风格，零依赖）─────

let passed = 0;
const failures = [];

function check(group, name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ group, name, message: err.message });
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? 'not equal'}\n    expected: ${e}\n    actual:   ${a}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg ?? 'expected truthy');
}

// ── §A 构造器契约（迁移自 ApprovalContractTest.kt 的 11 条）──────────────────

check('A', 'approve 用裸字符串 allowed-once', () => {
  const value = Envelopes.approvalOutcome(true).value;
  // 必须是**裸字符串**，不能是对象 —— 发对象会被静默归一化成 unavailable
  eq(typeof value, 'string', 'value 必须是裸字符串（不能是对象/布尔）');
  eq(value, 'allowed-once');
});

check('A', 'reject 用裸字符串 rejected', () => {
  const value = Envelopes.approvalOutcome(false).value;
  eq(typeof value, 'string', 'value 必须是裸字符串');
  eq(value, 'rejected');
});

check('A', '两个方向产出的值都落在主机词表内', () => {
  const produced = [Envelopes.approvalOutcome(true).value, Envelopes.approvalOutcome(false).value];
  for (const v of produced) {
    ok(
      HOST_VOCABULARY.includes(v),
      `产出的值 '${v}' 不在主机词表 ${JSON.stringify(HOST_VOCABULARY)} 内 —— 它会被静默归一化成 unavailable（= 拒绝）`,
    );
  }
});

check('A', '允许与拒绝必须产出不同的值（否则按钮形同虚设）', () => {
  const a = Envelopes.approvalOutcome(true).value;
  const r = Envelopes.approvalOutcome(false).value;
  ok(a !== r, `允许与拒绝产出了相同的值 '${a}'`);
});

check('A', 'outcome 携带 kind = result', () => {
  // kind 必须是 "result" —— 主机按它区分「这是应答」还是「这是拒绝」
  eq(Envelopes.approvalOutcome(true).kind, 'result');
  eq(Envelopes.approvalOutcome(false).kind, 'result');
});

check('A', '审批 value 不得是 {approved:true} 形状的对象（历史 bug）', () => {
  const value = Envelopes.approvalOutcome(true).value;
  ok(
    value === null || typeof value !== 'object',
    'value 不能是对象 —— 早期发 {approved:true} 导致被归一化成 unavailable',
  );
});

check('A', '提问应答用 id + selected 数组', () => {
  const value = Envelopes.questionOutcome('q-1', ['选项A']).value;
  ok(Array.isArray(value.answers), 'value 必须有 answers 数组');
  eq(value.answers.length, 1);
  const first = value.answers[0];
  eq(first.id, 'q-1', 'id 必须是**问题** id，不是选项 id');
  ok(Array.isArray(first.selected), 'answers[0] 必须有 selected 数组');
  eq(first.selected, ['选项A'], 'selected 里放的是选项 label');
});

check('A', '提问应答支持多选且保序', () => {
  const value = Envelopes.questionOutcome('q-2', ['A', 'B', 'C']).value;
  eq(value.answers[0].selected, ['A', 'B', 'C'], '多选必须全部保序写入');
});

check('A', '空选择的提问应答形状仍合法', () => {
  // 用户可能一个都不选就提交 —— 形状仍必须合法，不能崩也不能变形
  const value = Envelopes.questionOutcome('q-3', []).value;
  eq(value.answers[0].selected, []);
  eq(value.answers[0].id, 'q-3');
});

check('A', '提问 kind 是 result', () => {
  eq(Envelopes.questionOutcome('q', ['x']).kind, 'result');
});

check('A', 'rejected() 的 error.name 非空且为 Error', () => {
  // rejected() 用于 waterfall 拒绝：{name, message}，name 必须非空，
  // 否则主机还原 Error 会失败
  const rej = Envelopes.rejected('用户拒绝');
  eq(rej.kind, 'rejected');
  ok(rej.error && typeof rej.error === 'object', '必须有 error 对象');
  ok(typeof rej.error.name === 'string' && rej.error.name.trim() !== '', 'name 必须非空');
  eq(rej.error.name, 'Error');
  eq(rej.error.message, '用户拒绝');
});

check('A', 'toEndpoint 只把**第一个**点号换成斜杠', () => {
  // 真实协议用斜杠（session/list），但应答端点本身就叫 $events/result，不能再被改写
  eq(Envelopes.toEndpoint('session.list'), 'session/list');
  eq(Envelopes.toEndpoint('$events/result'), '$events/result', '$events/result 不得被改写');
  eq(Envelopes.toEndpoint('$events'), '$events');
});

// ── §B 传输契约：应答真的以正确形状发出，且失败不静默 ────────────────────────

const BASE = 'http://127.0.0.1:19387';
const TOKEN = 'tok-contract-test';

/** 用假 fetch 抓取一次 respond() 的实际请求。 */
async function captureRespond({ clientId = 'client-1', eventId = 'ev-7', outcome, response }) {
  const conn = new DshConnection(BASE, TOKEN);
  conn.eventClientId = clientId; // 运行时是普通字段（TS 的 private 只是编译期）

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };

  try {
    const result = await conn.respond(eventId, outcome);
    return { result, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const OK_200 = { ok: true, status: 200 };

const approved = await captureRespond({
  outcome: Envelopes.approvalOutcome(true),
  response: OK_200,
});

check('B', '应答发往 /mobile-gateway/api/$events/result', () => {
  eq(approved.calls.length, 1, '应当只发一次请求');
  eq(approved.calls[0].url, `${BASE}/mobile-gateway/api/$events/result`);
  eq(EVENT_RESULT_ENDPOINT, '$events/result', '应答端点常量不得漂移');
});

check('B', '应答是 POST + JSON + Bearer 鉴权头', () => {
  const { init } = approved.calls[0];
  eq(init.method, 'POST');
  eq(init.headers['Content-Type'], 'application/json');
  eq(init.headers.Authorization, `Bearer ${TOKEN}`, 'HTTP 侧必须走鉴权头，不能把令牌塞进 query');
});

check('B', '信封形状：client-request + $events/result + args{clientId,eventId,outcome}', () => {
  const body = JSON.parse(approved.calls[0].init.body);
  eq(body.type, 'client-request');
  eq(body.method, '$events/result', '方法名带斜杠，不是 $events.result');
  ok(typeof body.rpcId === 'string' && body.rpcId !== '', 'rpcId 必须非空');
  eq(Object.keys(body.payload.args).sort(), ['clientId', 'eventId', 'outcome']);
  eq(body.payload.args.clientId, 'client-1');
  eq(body.payload.args.eventId, 'ev-7');
});

check('B', 'outcome 经 JSON 序列化后 value 仍是裸字符串（不是对象）', () => {
  const raw = approved.calls[0].init.body;
  const roundTripped = JSON.parse(raw);
  const value = roundTripped.payload.args.outcome.value;
  eq(typeof value, 'string', '序列化后 value 退化成对象 = 必然被归一化成 unavailable');
  eq(value, 'allowed-once');
  ok(HOST_VOCABULARY.includes(value), `序列化后的值 '${value}' 必须仍在主机词表内`);
  // 反向断言：不能悄悄多出 approved:true 之类的字段
  eq(Object.keys(roundTripped.payload.args.outcome).sort(), ['kind', 'value']);
});

const rejected = await captureRespond({
  outcome: Envelopes.approvalOutcome(false),
  response: OK_200,
});
check('B', '拒绝方向在链路上同样保持词表内的裸字符串', () => {
  const body = JSON.parse(rejected.calls[0].init.body);
  const value = body.payload.args.outcome.value;
  eq(typeof value, 'string');
  eq(value, 'rejected');
  ok(HOST_VOCABULARY.includes(value));
});

for (const status of [401, 403, 500]) {
  const r = await captureRespond({
    outcome: Envelopes.approvalOutcome(true),
    response: { ok: false, status },
  });
  check('B', `HTTP ${status} 必须返回 false（不得谎报成功）`, () => {
    eq(r.result, false, `HTTP ${status} 时 respond() 返回了 ${r.result} —— 会让用户以为已批准`);
  });
}

const noClient = await captureRespond({
  clientId: null,
  outcome: Envelopes.approvalOutcome(true),
  response: OK_200,
});

check('B', '事件流未握手（无 clientId）时不发请求、直接返回 false', () => {
  eq(noClient.result, false);
  eq(noClient.calls.length, 0, '没有 clientId 时不应发出请求（主机无法归属该应答）');
});

const networkDown = await captureRespond({
  outcome: Envelopes.approvalOutcome(true),
  response: new Error('ECONNREFUSED'),
});

check('B', '网络异常被吞成 false，不抛出（调用方必须检查返回值）', () => {
  eq(networkDown.result, false);
});

check('B', 'respond() 成功时返回 true', () => {
  eq(approved.result, true);
});

// ── §C 单一事实来源：全仓库只有 envelopes.ts 能写字面量 ──────────────────────

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** 精确匹配「整段字面量就是词表里的某个词」，这样注释里的 `a | b` 描述不会误报。 */
const LITERAL_RE = new RegExp(`(['"\`])(${HOST_VOCABULARY.join('|')})\\1`, 'g');

/**
 * 扫描**代码**、排除注释。
 *
 * 为什么不扫注释：解释协议词表的注释本来就该写 `unavailable` 这几个词，
 * 逼着注释绕开自己的词表只会让文档更差。护栏要管的是**代码里手写字面量**。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/\/\/[^\n]*/g, ''); // 行注释（'http://x' 会被一并截断，对本扫描无影响）
}

function findOffVocabularyLiterals(text) {
  const offenders = [];
  const code = stripComments(text);
  for (const m of code.matchAll(LITERAL_RE)) {
    const line = code.slice(0, m.index).split('\n').length;
    offenders.push(`line ${line} → ${m[0]}`);
  }
  return offenders;
}

check('C', '扫描器自检：抓得到代码里的字面量、不误报注释', () => {
  const plantedInCode = "const outcome = { kind: 'result', value: 'allowed-once' };";
  const plantedInComment = "// 词表是 'allowed-once' / 'rejected' 等四个裸字符串\nconst x = 1;";
  eq(findOffVocabularyLiterals(plantedInCode).length, 1, '代码里的字面量必须被抓到');
  eq(findOffVocabularyLiterals(plantedInComment).length, 0, '注释里的词不得误报');
});

const SOURCE_OF_TRUTH = path.join(SRC_DIR, 'services', 'envelopes.ts');

check('C', 'envelopes.ts 之外没有任何文件手写审批词表字面量', () => {
  const offenders = [];
  for (const file of walk(SRC_DIR)) {
    if (path.resolve(file) === path.resolve(SOURCE_OF_TRUTH)) continue;
    for (const hit of findOffVocabularyLiterals(readFileSync(file, 'utf8'))) {
      offenders.push(`${path.relative(SRC_DIR, file)}:${hit}`);
    }
  }
  ok(
    offenders.length === 0,
    '发现手写的审批词表字面量（必须改为调用 Envelopes.*，否则契约测试保护不到它）:\n    ' +
      offenders.join('\n    '),
  );
});

check('C', 'App.tsx 的审批作答确实走了 Envelopes 构造器', () => {
  const app = readFileSync(path.join(SRC_DIR, 'App.tsx'), 'utf8');
  ok(
    /Envelopes\.approvalOutcome\s*\(/.test(app),
    'App.tsx 没有调用 Envelopes.approvalOutcome()',
  );
  ok(
    /Envelopes\.questionOutcome\s*\(/.test(app),
    'App.tsx 没有调用 Envelopes.questionOutcome()',
  );
});

check('C', 'App.tsx 检查了 respond() 的返回值（不得静默丢弃失败）', () => {
  const app = readFileSync(path.join(SRC_DIR, 'App.tsx'), 'utf8');
  // 「没送达却关掉弹窗」= 用户以为批了、主机还在等，与静默归一化同类
  ok(
    /const\s+ok\s*=\s*await\s+connRef\.current\.respond/.test(app),
    'App.tsx 没有接住 respond() 的返回值 —— 应答失败会被静默吞掉',
  );
});

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log('');
console.log('  审批 / 提问应答 · 协议契约测试');
console.log('  ' + '─'.repeat(50));
if (failures.length === 0) {
  console.log(`  ✓ ${passed} passed, 0 failed`);
  console.log('');
  process.exit(0);
} else {
  console.log(`  ✗ ${passed} passed, ${failures.length} failed`);
  for (const f of failures) {
    console.log('');
    console.log(`  [§${f.group}] ${f.name}`);
    console.log(`    ${f.message}`);
  }
  console.log('');
  process.exit(1);
}