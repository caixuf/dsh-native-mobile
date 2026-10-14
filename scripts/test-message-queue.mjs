/**
 * 待发队列 + 草稿持久化 回归测试（零依赖，手写断言）。
 *
 * 运行：`node --experimental-strip-types scripts/test-message-queue.mjs`
 * （**故意不依赖** `scripts/ts-resolve-hook.mjs`：直接 import 相对路径的 .ts）
 *
 * 🔴 覆盖的是三个真实事故对应的不变量：
 *  1. 运行中排队不能丢消息、不能乱序（入队顺序 / 上限淘汰 / 出队重排）；
 *  2. 失败**绝不丢用户打的字**（失败项保留、失败项不被上限淘汰、重试仍带原文）；
 *  3. 草稿按会话隔离且异常不炸（privacy mode / 配额满时 localStorage 会抛）。
 */

import {
  DEFAULT_QUEUE_LIMIT,
  MAX_ITEM_TEXT,
  applyLimit,
  clearFailed,
  createQueueId,
  dedupeById,
  enqueue,
  failedCount,
  markFailed,
  moveQueued,
  normalizeItem,
  normalizeQueue,
  pendingCount,
  removeQueued,
  resequence,
  retryQueued,
  takeNext,
} from '../src/lib/message-queue.ts';
import {
  DRAFT_PREFIX,
  clearDraft,
  createMemoryStorage,
  draftKey,
  listDraftSessionIds,
  loadDraft,
  saveDraft,
} from '../src/components/chat/draft-store.ts';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err && err.message ? err.message : String(err) });
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ? msg + '\n' : ''}  expected: ${e}\n  actual:   ${a}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}

function msg(id, text, createdAt = 1000, extra = {}) {
  return { id, text, createdAt, ...extra };
}

/** 队列"骨架"：只比 id + status，避免测试被无关字段绊倒。 */
function shape(queue) {
  return queue.map((i) => `${i.id}:${i.status || 'pending'}`);
}

// ── 入队顺序 ────────────────────────────────────────────────────────────────

check('入队顺序：先进先出，且不修改入参', () => {
  const first = [];
  const a = enqueue(first, msg('a', '第一条'));
  const b = enqueue(a.queue, msg('b', '第二条'));
  const c = enqueue(b.queue, msg('c', '第三条'));

  eq(c.queue.map((i) => i.id), ['a', 'b', 'c'], '队列必须保持入队顺序');
  eq(first, [], '原数组不能被修改（纯函数）');
  eq(a.queue.length, 1);
  eq(b.queue.length, 2);
  ok(a.added && b.added && c.added, '三次入队都应 added:true');
});

check('入队顺序：createdAt 不参与排序（按入队先后，不按时间戳）', () => {
  const q = enqueue([], msg('late', '后入队但时间戳更早', 9999)).queue;
  const q2 = enqueue(q, msg('early', '先入队但时间戳更晚', 1)).queue;
  eq(q2.map((i) => i.id), ['late', 'early'], '顺序只由入队动作决定');
});

check('入队拒绝空 id / 纯空白文本（必须显式抛错，不能静默吞）', () => {
  for (const bad of [msg('', 'x'), msg('a', '   '), msg('a', '\n\t '), null, undefined, 'x', 42]) {
    let threw = false;
    try {
      enqueue([], bad);
    } catch {
      threw = true;
    }
    ok(threw, `enqueue(${JSON.stringify(bad)}) 必须抛错`);
  }
  eq(normalizeItem({ id: 'a', text: 'ok' }).text, 'ok');
  eq(normalizeItem({ id: '', text: 'ok' }), null);
});

check('入队：超长文本被截断到 MAX_ITEM_TEXT（不撑爆存储/UI）', () => {
  const long = 'x'.repeat(MAX_ITEM_TEXT + 500);
  const { queue } = enqueue([], msg('a', long));
  eq(queue[0].text.length, MAX_ITEM_TEXT);
});

// ── 同 id 幂等 / 重复文本不去重 ─────────────────────────────────────────────

check('同 id 幂等：重复入队同一个 id 是 no-op（队列完全不变）', () => {
  const first = enqueue([], msg('same', '原文')).queue;
  const second = enqueue(first, msg('same', '被改过的文本'));
  eq(second.added, false, '第二次必须 reported added:false');
  eq(shape(second.queue), shape(first), '队列内容不能变');
  eq(second.queue[0].text, '原文', '幂等命中不覆盖已有文本');
  eq(second.item.text, '原文');
  eq(second.queue.length, 1);
});

check('同 id 幂等：normalizeQueue 对同 id 只保留第一次出现', () => {
  const cleaned = normalizeQueue([
    msg('a', '第一次', 2),
    msg('b', '另一个'),
    msg('a', '第二次（应被丢弃）', 1),
  ]);
  eq(cleaned.map((i) => i.id), ['a', 'b']);
  eq(cleaned[0].text, '第一次');
  eq(dedupeById(cleaned).length, 2);
});

check('重复文本**不去重**：不同 id 的相同文本两条都保留', () => {
  const a = enqueue([], msg('id-1', '重新跑一遍测试')).queue;
  const b = enqueue(a, msg('id-2', '重新跑一遍测试')).queue;
  eq(b.length, 2, '用户确实想发两遍，不能替他"聪明"地去重');
  eq(b.map((i) => i.text), ['重新跑一遍测试', '重新跑一遍测试']);
  eq(b.map((i) => i.id), ['id-1', 'id-2']);
});

check('幂等键是 id 而不是文本：同文本同 id 才算重复', () => {
  const q = normalizeQueue([
    msg('x', 't'),
    msg('x', 't'),
    msg('y', 't'),
  ]);
  eq(q.length, 2);
});

// ── 上限淘汰 ────────────────────────────────────────────────────────────────

check('上限淘汰：超过上限淘汰**最旧**的（FIFO），新项一定保留', () => {
  const limit = 3;
  let q = [];
  for (let i = 1; i <= 5; i += 1) {
    q = enqueue(q, msg(`m${i}`, `第 ${i} 条`), { limit }).queue;
  }
  eq(q.length, limit);
  eq(q.map((i) => i.id), ['m3', 'm4', 'm5'], '最旧的被淘汰');
});

check('上限淘汰：一次入队只淘汰必要的数量，且报告 evicted（UI 要能提示）', () => {
  let q = [];
  for (let i = 1; i <= 4; i += 1) q = enqueue(q, msg(`m${i}`, `第 ${i} 条`), { limit: 4 }).queue;
  const res = enqueue(q, msg('m5', '第 5 条'), { limit: 3 });
  eq(res.evicted.map((i) => i.id), ['m1', 'm2'], '多出的两条要被淘汰');
  eq(res.queue.map((i) => i.id), ['m3', 'm4', 'm5']);
});

check('🔴 上限淘汰：失败项优先保留（最旧的 pending 先走）', () => {
  let q = [];
  q = enqueue(q, msg('old-failed', '会失败的那条'), { limit: 10 }).queue;
  q = markFailed(q, 'old-failed', '网络断了');
  q = enqueue(q, msg('p1', '待发 1'), { limit: 10 }).queue;
  q = enqueue(q, msg('p2', '待发 2'), { limit: 10 }).queue;

  const { queue, evicted } = applyLimit(q, 2);
  eq(shape(queue), ['old-failed:failed', 'p2:pending'], '失败项不能被上限吃掉');
  eq(evicted.map((i) => i.id), ['p1']);
  eq(queue.find((i) => i.id === 'old-failed').text, '会失败的那条', '原文必须还在');
});

check('上限淘汰：全是失败项时才按最旧淘汰（不会死锁溢出）', () => {
  let q = [];
  for (const id of ['f1', 'f2', 'f3']) {
    q = enqueue(q, msg(id, `失败 ${id}`), { limit: 10 }).queue;
    q = markFailed(q, id);
  }
  const { queue } = applyLimit(q, 2);
  eq(shape(queue), ['f2:failed', 'f3:failed']);
});

check('上限边界：limit=0 清空，limit 非法时回落到默认上限', () => {
  const q = normalizeQueue([msg('a', '1'), msg('b', '2')], 0);
  eq(q, []);
  const many = Array.from({ length: DEFAULT_QUEUE_LIMIT + 5 }, (_, i) => msg(`m${i}`, `第 ${i}`));
  eq(normalizeQueue(many).length, DEFAULT_QUEUE_LIMIT, '默认上限生效');
  eq(normalizeQueue(many, Number.NaN).length, DEFAULT_QUEUE_LIMIT, 'NaN 上限回落默认');
});

// ── 出队 / 重排 ─────────────────────────────────────────────────────────────

check('出队：removeQueued 只删指定 id，其余顺序不变', () => {
  const q = [msg('a', 'A'), msg('b', 'B'), msg('c', 'C')];
  const next = removeQueued(q, 'b');
  eq(next.map((i) => i.id), ['a', 'c']);
  eq(q.map((i) => i.id), ['a', 'b', 'c'], '入参不被修改');
  eq(removeQueued(q, '不存在').map((i) => i.id), ['a', 'b', 'c']);
});

check('🔴 出队后重排：序号重新连续编号 1..n（不留空洞）', () => {
  const q = [msg('a', 'A'), msg('b', 'B'), msg('c', 'C'), msg('d', 'D')];
  eq(resequence(q).map((i) => i.seq), [1, 2, 3, 4]);

  const afterRemove = resequence(removeQueued(q, 'b'));
  eq(afterRemove.map((i) => i.id), ['a', 'c', 'd']);
  eq(afterRemove.map((i) => i.seq), [1, 2, 3], '删掉第 2 条后不能留下 1,3,4');

  const afterTwo = resequence(removeQueued(removeQueued(q, 'a'), 'c'));
  eq(afterTwo.map((i) => i.seq), [1, 2]);
  eq(afterTwo.map((i) => i.id), ['b', 'd']);
  eq(resequence(q, 5).map((i) => i.seq), [5, 6, 7, 8], '支持自定义起始序号');
});

check('出队：takeNext 取队首可发送项，失败项被跳过且留在队里', () => {
  let q = [msg('a', 'A'), msg('b', 'B'), msg('c', 'C')];
  q = markFailed(q, 'a', '超时');
  const taken = takeNext(q);
  eq(taken.item.id, 'b');
  eq(shape(taken.queue), ['a:failed', 'c:pending'], '失败项不消失');

  const taken2 = takeNext(taken.queue);
  eq(taken2.item.id, 'c');
  eq(shape(taken2.queue), ['a:failed']);

  const taken3 = takeNext(taken2.queue);
  eq(taken3.item, null, '全是失败项时没有可发送项');
  eq(shape(taken3.queue), ['a:failed']);
});

check('重排：moveQueued 上下移动并在边界夹紧', () => {
  const q = [msg('a', 'A'), msg('b', 'B'), msg('c', 'C')];
  eq(moveQueued(q, 'c', -1).map((i) => i.id), ['a', 'c', 'b']);
  eq(moveQueued(q, 'a', 1).map((i) => i.id), ['b', 'a', 'c']);
  eq(moveQueued(q, 'a', -1).map((i) => i.id), ['a', 'b', 'c'], '越界夹紧');
  eq(moveQueued(q, 'c', 99).map((i) => i.id), ['a', 'b', 'c'], '越界夹紧');
  eq(moveQueued(q, '不存在', 1).map((i) => i.id), ['a', 'b', 'c']);
});

// ── 失败项保留 / 重试 ───────────────────────────────────────────────────────

check('🔴 失败项保留：markFailed 保留原文 + 错误原因 + 累加尝试次数', () => {
  const q = [msg('a', '这是用户打的字，绝对不能丢')];
  const once = markFailed(q, 'a', '连接超时');
  eq(once[0].status, 'failed');
  eq(once[0].text, '这是用户打的字，绝对不能丢', '原文必须逐字保留');
  eq(once[0].error, '连接超时');
  eq(once[0].attempts, 1);
  eq(q[0].status, undefined, '入参（无 status 的原始项）不能被写上 status');

  const twice = markFailed(once, 'a', '仍然失败');
  eq(twice[0].attempts, 2);
  eq(twice[0].text, '这是用户打的字，绝对不能丢');
});

check('失败项保留：markFailed 不影响其它项，未知 id 是 no-op', () => {
  let q = [msg('a', 'A'), msg('b', 'B')];
  q = markFailed(q, 'a');
  eq(shape(q), ['a:failed', 'b:pending']);
  eq(markFailed(q, 'nope').map((i) => i.id), ['a', 'b']);
});

check('重试：retryQueued 回到 pending、清掉错误、原文不变；再失败次数继续累加', () => {
  let q = [msg('a', '重试也要保留原文')];
  q = markFailed(q, 'a', '第一次失败');
  q = retryQueued(q, 'a');
  eq(q[0].status, 'pending');
  eq(q[0].error, undefined, '重试后错误信息必须清掉（否则 UI 一直显示失败）');
  eq(q[0].text, '重试也要保留原文');
  eq(q[0].attempts, 1, '尝试次数是历史，重试不清零');

  q = markFailed(q, 'a', '第二次失败');
  eq(q[0].attempts, 2);
  eq(q[0].text, '重试也要保留原文');
});

check('统计与清理：pendingCount/failedCount 正确，clearFailed 只清失败项', () => {
  let q = [msg('a', 'A'), msg('b', 'B'), msg('c', 'C')];
  q = markFailed(q, 'a');
  q = markFailed(q, 'c', '挂了');
  eq(pendingCount(q), 1);
  eq(failedCount(q), 2);
  eq(clearFailed(q).map((i) => i.id), ['b']);
  eq(q.length, 3, '入参不被修改');
});

// ── 其它不变量 ──────────────────────────────────────────────────────────────

check('normalizeQueue：坏数据（null/数字/缺字段/重复 id）不炸、不产生幽灵项', () => {
  const cleaned = normalizeQueue([null, 1, 'x', { id: 'a' }, { text: 't' }, msg('b', 'ok'), msg('b', 'dup')]);
  eq(cleaned.map((i) => i.id), ['b']);
  eq(cleaned[0].status, 'pending', '缺省状态归一为 pending');
  eq(normalizeQueue(null), []);
  eq(normalizeQueue(undefined), []);
  eq(normalizeQueue('not-an-array'), []);
});

check('createQueueId：确定性（同 now+seq 同 id，防重复点击靠它）', () => {
  eq(createQueueId(1700000000000, 1), 'q-1700000000000-1');
  eq(createQueueId(1700000000000, 1), createQueueId(1700000000000, 1));
  ok(createQueueId(1, 1) !== createQueueId(1, 2), '不同序号必须不同 id');
  eq(createQueueId(Number.NaN, 2), 'q-0-2');
});

check('往返一致性：入队 → 出队 → 重排后队列骨架与预期一致（端到端小场景）', () => {
  let q = [];
  q = enqueue(q, msg('q-1', '第一步'), { limit: 3 }).queue;
  q = enqueue(q, msg('q-2', '第二步'), { limit: 3 }).queue;
  q = enqueue(q, msg('q-3', '第三步'), { limit: 3 }).queue;
  q = enqueue(q, msg('q-4', '第四步（挤掉第一步）'), { limit: 3 }).queue;
  eq(q.map((i) => i.id), ['q-2', 'q-3', 'q-4']);

  q = markFailed(q, 'q-3', '断开');
  const taken = takeNext(q);
  eq(taken.item.id, 'q-2');
  const view = resequence(taken.queue);
  eq(view.map((i) => `${i.seq}.${i.id}`), ['1.q-3', '2.q-4']);
  eq(view.map((i) => i.text), ['第三步', '第四步（挤掉第一步）'], '失败项原文在展示层仍然可读');
});

// ── 草稿持久化 ──────────────────────────────────────────────────────────────

check('草稿：按会话隔离（切会话不串字）', () => {
  const store = createMemoryStorage();
  saveDraft('session-a', '给 A 的草稿', store);
  saveDraft('session-b', '给 B 的草稿', store);

  eq(loadDraft('session-a', store), { text: '给 A 的草稿', restored: true });
  eq(loadDraft('session-b', store), { text: '给 B 的草稿', restored: true });
  eq(loadDraft('session-c', store), { text: '', restored: false });
  eq(draftKey('session-a') === draftKey('session-b'), false, '键必须按会话区分');
  eq(draftKey(''), `${DRAFT_PREFIX}:default`);
});

check('草稿：纯空白=清空，且不会误报"已恢复"', () => {
  const store = createMemoryStorage();
  saveDraft('s', '内容', store);
  eq(loadDraft('s', store).restored, true);
  saveDraft('s', '   \n\t ', store);
  eq(loadDraft('s', store), { text: '', restored: false });

  saveDraft('s', '内容', store);
  clearDraft('s', store);
  eq(loadDraft('s', store).restored, false);
});

check('草稿：逐字符输入可恢复（切会话/退出不丢）', () => {
  const store = createMemoryStorage();
  let typed = '';
  for (const ch of '聊天输入不能丢') {
    typed += ch;
    saveDraft('s', typed, store);
  }
  const restored = loadDraft('s', store);
  eq(restored.text, '聊天输入不能丢');
  eq(restored.restored, true);
});

check('🔴 草稿：存储抛异常时不炸（隐私模式/配额满），并降级不丢内容', () => {
  const boom = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
  };
  // 这次降级是**预期行为**，临时静音 warn（同时断言确实告警过，不能静默吞）
  const realWarn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args[0]);
  let threw = false;
  try {
    eq(saveDraft('s', '很重要的草稿', boom), false, '写失败要如实返回 false');
    eq(loadDraft('s', boom), { text: '', restored: false }, '读失败返回空而不是抛');
    clearDraft('s', boom);
  } catch (err) {
    threw = true;
  } finally {
    console.warn = realWarn;
  }
  ok(!threw, '任何存储异常都不能冒泡到 UI');
  ok(warned.length >= 3, '读/写/清三类降级都必须有 warn，不能静默退化');
});

check('草稿：超长草稿被截断到 DRAFT_MAX_CHARS', () => {
  const store = createMemoryStorage();
  saveDraft('s', 'y'.repeat(20000), store);
  eq(loadDraft('s', store).text.length, 8000);
});

check('草稿：listDraftSessionIds 只列草稿键（供"有未发送草稿"标记）', () => {
  const store = createMemoryStorage({ other: 'x' });
  saveDraft('a', '1', store);
  saveDraft('b', '2', store);
  eq(listDraftSessionIds(createMemoryStorage()), []);
  const listed = listDraftSessionIds(store).sort();
  eq(listed, ['a', 'b']);
});

// ── 源码契约：这三个缺陷不许复发（读源文件断言，不需要打包器）──────────────
//
// 纯函数测不出 UI 回归（例如有人把 `|| sending` 加回禁用条件、或把清空挪到
// await 之前）。这里直接在源码上钉住不变量，避免"测试绿但功能又坏了"。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

const CHAT_SCREEN = 'src/components/screens/ChatScreen.tsx';
const QUEUE_BAR = 'src/components/chat/QueuedMessagesBar.tsx';
const TOOL_CARD = 'src/components/chat/DisclosureToolCard.tsx';

/** 极简括号平衡检查：跳过字符串/模板串/注释后统计 ()[]{} （能抓住大部分语法事故）。 */
function unbalancedReason(source) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === ch) {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (pairs[ch]) {
      if (stack.pop() !== pairs[ch]) return `第 ${i} 字符处 ${ch} 不匹配`;
    }
    i += 1;
  }
  return stack.length ? `有 ${stack.length} 个括号未闭合（最后一个是 ${stack[stack.length - 1]}）` : null;
}

check('源码语法自检：改动过的源文件括号平衡（轻量，代替打包器）', () => {
  for (const rel of [CHAT_SCREEN, QUEUE_BAR, TOOL_CARD, 'src/components/chat/draft-store.ts', 'src/lib/message-queue.ts']) {
    const reason = unbalancedReason(read(rel));
    eq(reason, null, `${rel}: ${reason}`);
  }
});

check('🔴 缺陷 1 不许复发：Composer 不能因 sending/running 被禁用', () => {
  const src = read(CHAT_SCREEN);
  ok(
    !/disabled=\{[^}]*\bsending\b[^}]*\}/.test(src),
    '发送按钮的 disabled 里不能再出现 sending（历史缺陷：运行中无法补话）',
  );
  ok(
    !/disabled=\{[^}]*\brunning\b[^}]*\}/.test(src),
    '发送按钮的 disabled 里不能再出现 running',
  );
  const textarea = src.match(/<textarea[\s\S]*?\/>/);
  ok(textarea, '必须还能找到 textarea');
  ok(!/disabled/.test(textarea[0]), 'textarea 任何情况下都不该被 disabled');
  ok(/aria-label="输入遥控指令"/.test(textarea[0]), 'textarea 需要 aria-label');
});

check('🔴 缺陷 2 不许复发：必须先判 onSend 结果，再清空草稿', () => {
  const src = read(CHAT_SCREEN);
  const guardAt = src.indexOf('if (accepted === false)');
  ok(guardAt > 0, '必须存在 `accepted === false` 保留分支');
  // 保留分支的边界：从 `if (accepted === false)` 到"已接收"注释之前的整段
  const acceptedAt = src.indexOf('// 已接收', guardAt);
  ok(acceptedAt > guardAt, '必须能定位到"已接收"分支起点');
  const keepBranch = src.slice(guardAt, acceptedAt);

  ok(/setInputText\(kept\)/.test(keepBranch), '失败分支必须把原文放回输入框');
  ok(/saveDraft\(targetSession, kept\)/.test(keepBranch), '失败分支必须把原文重新落盘');
  ok(!/setInputText\(''\)/.test(keepBranch), '保留分支里不能清空输入框');
  ok(!/clearDraft\(/.test(keepBranch), '保留分支里不能 clearDraft（失败必须留下原文）');

  const clearAt = src.slice(acceptedAt).indexOf("setInputText('')");
  ok(clearAt > 0, '清空输入必须发生在"已接收"分支之后');
  ok(/await Promise\.resolve\(onSend\(text\)\)/.test(src), '必须先 await onSend 再决定是否清空');
});

check('源码契约：运行中的提示与"入队"文案存在', () => {
  const src = read(CHAT_SCREEN);
  ok(/任务执行中/.test(src), '运行中应提示"会进入队列"');
  ok(/><QueuedMessagesBar|<QueuedMessagesBar/.test(src), '输入框上方必须挂队列条');
  ok(/liveConnected === false/.test(src), '实时事件流断连要有可见提示');
});

check('🔴 缺陷 3 不许复发：tool/result 必须被渲染且与 tool/call 可区分', () => {
  const src = read(CHAT_SCREEN);
  ok(!/Merged into DisclosureToolCard/.test(src), '不能再把 tool/result 直接吞掉');
  ok(/kind="tool\/result"/.test(src), '独立结果卡必须显式标 kind="tool/result"');
  ok(/kind="tool\/call"/.test(src), '调用卡必须显式标 kind="tool/call"');
  ok(/resultByCallId/.test(src), '结果应按 callId 配对回调用卡（对齐桌面端）');

  const card = read(TOOL_CARD);
  ok(/tool\/result/.test(card) && /结果/.test(card), '卡片要区分"结果"与"调用"');
  ok(/isError/.test(card) && /#f43f5e/.test(card), '错误态要有醒目但克制的样式');
  ok(/copyToClipboard/.test(card), '长参数/长结果要有复制按钮');
  ok(/COLLAPSE_AT/.test(card), '长参数/长结果要折叠');
  ok(/aria-expanded/.test(card), '折叠控件必须键盘可达（aria-expanded）');
});

check('来源契约：新文件零新增运行时依赖（只允许 react / lucide-react / 相对路径）', () => {
  const allowed = new Set(['react', 'lucide-react']);
  for (const rel of [CHAT_SCREEN, QUEUE_BAR, TOOL_CARD, 'src/components/chat/draft-store.ts', 'src/lib/message-queue.ts']) {
    const src = read(rel);
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      ok(allowed.has(spec), `${rel} 引入了未授权依赖: ${spec}`);
    }
  }
});

/** 跳过一段字符串字面量（含模板串），返回结束后的下标。 */
function skipString(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') i += 2;
    else if (src[i] === quote) return i + 1;
    else i += 1;
  }
  return i;
}

/** 去掉注释（跳过字符串），避免注释里的示例 JSX 干扰源码契约断言。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 取出某个标签的所有**开标签**原文（按花括号深度找 `>`，容忍 `=>` 与模板串）。 */
function openingTags(source, tagName) {
  const src = stripComments(source);
  const tags = [];
  const needle = `<${tagName}`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at < 0) break;
    let i = at + needle.length;
    let depth = 0;
    let end = -1;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        i = skipString(src, i);
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) {
        end = i;
        break;
      }
      i += 1;
    }
    tags.push(src.slice(at, end < 0 ? src.length : end + 1));
    from = end < 0 ? src.length : end + 1;
  }
  return tags;
}

check('触控目标：输入区/队列条/工具卡的交互按钮 ≥44px', () => {
  for (const rel of [CHAT_SCREEN, QUEUE_BAR, TOOL_CARD]) {
    const tags = openingTags(read(rel), 'button');
    ok(tags.length > 0, `${rel} 应包含按钮`);
    for (const tag of tags) {
      const matched = tag.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/);
      const cls = (matched && (matched[1] ?? matched[2])) || '';
      ok(
        /w-11|h-11|min-h-\[44px\]/.test(cls),
        `${rel} 有按钮缺少 44px 触控目标: ${tag.replace(/\s+/g, ' ').slice(0, 90)}`,
      );
    }
  }
});

check('无障碍：图标按钮必须有 aria-label，队列条/工具卡按钮全带标签', () => {
  const chat = stripComments(read(CHAT_SCREEN));
  ok(/aria-label="返回会话列表"/.test(chat), '返回按钮是纯图标，必须有 aria-label');
  ok(/aria-label="打开会话菜单"/.test(chat), '菜单按钮是纯图标，必须有 aria-label');

  for (const rel of [QUEUE_BAR, TOOL_CARD]) {
    for (const tag of openingTags(read(rel), 'button')) {
      ok(
        /aria-label=/.test(tag),
        `${rel} 有按钮缺少 aria-label: ${tag.replace(/\s+/g, ' ').slice(0, 90)}`,
      );
    }
  }
});

// ── 报告 ────────────────────────────────────────────────────────────────────

console.log('\n  待发队列 / 草稿持久化 单元测试');
console.log(`  ${'─'.repeat(46)}`);
for (const f of failures) {
  console.log(`  ✗ ${f.name}\n    ${f.message.split('\n').join('\n    ')}`);
}
console.log(`  ${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);

process.exit(failed === 0 ? 0 : 1);