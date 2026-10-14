/**
 * 待发队列 + 草稿持久化 + 超长消息折叠 回归测试（零依赖，手写断言）。
 *
 * 运行：`node --experimental-strip-types scripts/test-message-queue.mjs`
 * （**故意不依赖** `scripts/ts-resolve-hook.mjs`：直接 import 相对路径的 .ts）
 *
 * 🔴 覆盖的是四个真实事故对应的不变量：
 *  1. 运行中排队不能丢消息、不能乱序（入队顺序 / 上限淘汰 / 出队重排）；
 *  2. 失败**绝不丢用户打的字**（失败项保留、失败项不被上限淘汰、重试仍带原文）；
 *  3. 草稿按会话隔离且异常不炸（privacy mode / 配额满时 localStorage 会抛）；
 *  4. 1.2 万字 runtime context 不许整块淹没屏幕（折叠阈值/预览/展开记忆）。
 */

import {
  COLLAPSE_CHAR_THRESHOLD,
  COLLAPSE_LINE_THRESHOLD,
  COLLAPSE_PREVIEW_CHARS,
  COLLAPSE_PREVIEW_LINES,
  DEFAULT_QUEUE_LIMIT,
  MAX_ITEM_TEXT,
  applyLimit,
  clearFailed,
  collapsePreview,
  countChars,
  countLines,
  createQueueId,
  dedupeById,
  enqueue,
  expandLabel,
  failedCount,
  markFailed,
  moveQueued,
  normalizeItem,
  normalizeQueue,
  pendingCount,
  removeQueued,
  resequence,
  retryQueued,
  shouldCollapse,
  takeNext,
} from '../src/lib/message-queue.ts';
import {
  DRAFT_PREFIX,
  EXPANDED_MAX_KEYS,
  clearDraft,
  createMemoryStorage,
  draftKey,
  expandedKey,
  listDraftSessionIds,
  loadDraft,
  loadExpandedKeys,
  saveDraft,
  saveExpandedKeys,
} from '../src/components/chat/draft-store.ts';
import { copyToClipboard } from '../src/components/chat/clipboard.ts';

let passed = 0;
let failed = 0;
const failures = [];
/** 异步用例（例如剪贴板回退）会挂在这里，报告前统一 await。 */
const pendingChecks = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err && err.message ? err.message : String(err) });
  }
}

/** 异步版 check：必须 await 完成后再统计（否则失败会被吞掉）。 */
function checkAsync(name, fn) {
  pendingChecks.push(
    Promise.resolve()
      .then(fn)
      .then(
        () => {
          passed += 1;
        },
        (err) => {
          failed += 1;
          failures.push({ name, message: err && err.message ? err.message : String(err) });
        },
      ),
  );
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
const COLLAPSIBLE_MESSAGE = 'src/components/chat/CollapsibleMessage.tsx';

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
  for (const rel of [
    CHAT_SCREEN,
    QUEUE_BAR,
    TOOL_CARD,
    COLLAPSIBLE_MESSAGE,
    'src/components/chat/draft-store.ts',
    'src/components/chat/clipboard.ts',
    'src/lib/message-queue.ts',
  ]) {
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

check('无障碍：图标按钮必须有 aria-label，队列条/工具卡/折叠消息按钮全带标签', () => {
  const chat = stripComments(read(CHAT_SCREEN));
  ok(/aria-label="返回会话列表"/.test(chat), '返回按钮是纯图标，必须有 aria-label');
  ok(/aria-label="打开会话菜单"/.test(chat), '菜单按钮是纯图标，必须有 aria-label');

  for (const rel of [QUEUE_BAR, TOOL_CARD, COLLAPSIBLE_MESSAGE]) {
    for (const tag of openingTags(read(rel), 'button')) {
      ok(
        /aria-label=/.test(tag),
        `${rel} 有按钮缺少 aria-label: ${tag.replace(/\s+/g, ' ').slice(0, 90)}`,
      );
    }
  }
});

// ── T7：聊天可读性（折叠 / 滚动到底 / 流式光标 / 消息复制）──────────────────

check('🔴 T7 超长消息必须接上折叠组件（用户 + 助手两条路径）', () => {
  const chat = stripComments(read(CHAT_SCREEN));
  const collapsibleTags = openingTags(chat, 'CollapsibleMessage');
  eq(collapsibleTags.length, 2, '用户消息与助手消息都要走 CollapsibleMessage');
  ok(/mode="plain"/.test(chat), '用户原文走字符级预览（6 行 line-clamp）');
  ok(/mode="markdown"/.test(chat), '助手富文本走高度裁剪（保住代码块/表格布局）');
  ok(/expandedKeys\.has\(key\)/.test(chat), '展开状态必须按消息 key 查');
  ok(/loadExpandedKeys\(sessionId\)/.test(chat) && /saveExpandedKeys\(sessionId/.test(chat),
    '展开状态要按会话持久化（切走再回来不丢）');

  const card = read(COLLAPSIBLE_MESSAGE);
  ok(/data-collapsed=/.test(card) && /data-full-chars=/.test(card),
    '要暴露 data-collapsed / data-full-chars，方便 e2e 判定"是否真的折叠了"');
  ok(/WebkitLineClamp/.test(card), '纯文本模式必须用 line-clamp 精确裁 6 行');
  ok(/maxHeight: collapsedMaxHeightPx/.test(card), 'markdown 模式必须用 maxHeight 裁剪');
  ok(/collapsePreview\(text\)/.test(card), '折叠判定必须来自纯函数，不能在组件里手写');
  ok(/copyToClipboard/.test(card), '消息级复制要复用 clipboard 工具');
  ok(/onContextMenu/.test(card), '移动端长按要能唤出复制操作条');
  ok(/sr-only/.test(card) || /aria-label/.test(card), '流式光标/按钮要有可访问名');
});

check('🔴 T7 自动跟随：只在用户本来就在底部时才滚，且给「跳到最新」', () => {
  const chat = stripComments(read(CHAT_SCREEN));
  ok(/followBottomRef/.test(chat), '必须有用"是否贴底"控制的跟随开关');
  ok(/onScroll=\{handleTimelineScroll\}/.test(chat), '时间线必须监听滚动');
  ok(/if \(followBottomRef\.current\) scrollToBottom\(\)/.test(chat),
    '自动滚动必须被 followBottomRef 门控（不能无条件 scrollIntoView）');
  ok(/aria-label="跳到最新消息"/.test(chat), '跳转按钮要有 aria-label');
  ok(/jumpToLatest/.test(chat), '点击后要回到底部并恢复跟随');
  ok(/distance < 80/.test(chat), '要有贴底容差，避免手指抖动误判');
});

check('🔴 T7 流式光标：仅 running + liveConnected 时显示，且挂在最后一条消息尾部', () => {
  const chat = stripComments(read(CHAT_SCREEN));
  ok(/const showStreamCursor = running && liveConnected === true;/.test(chat),
    '链路断开时不能假装还在输出（必须要求 liveConnected === true）');
  ok(/showCursor=\{isLastMessage\}/.test(chat), '光标只挂最后一条消息');
  ok(/lastMessageKey/.test(chat), '要能定位最后一条消息类行（跳过工具卡）');
  ok(/animate-pulse/.test(chat), '用 Tailwind 内置动画，不新增样式/依赖');
});

check('来源契约：新文件零新增运行时依赖（只允许 react / lucide-react / 相对路径）', () => {
  const allowed = new Set(['react', 'lucide-react']);
  for (const rel of [
    CHAT_SCREEN,
    QUEUE_BAR,
    TOOL_CARD,
    COLLAPSIBLE_MESSAGE,
    'src/components/chat/draft-store.ts',
    'src/components/chat/clipboard.ts',
    'src/lib/message-queue.ts',
  ]) {
    const src = read(rel);
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      ok(allowed.has(spec), `${rel} 引入了未授权依赖: ${spec}`);
    }
  }
});

check('触控目标：输入区/队列条/工具卡/折叠消息的交互按钮 ≥44px', () => {
  for (const rel of [CHAT_SCREEN, QUEUE_BAR, TOOL_CARD, COLLAPSIBLE_MESSAGE]) {
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

// ── 超长消息折叠（真机事故：1.2 万字 runtime context 整块淹没屏幕）────────────

check('折叠阈值：短消息不折叠，超 600 字或超 12 行才折叠', () => {
  eq(shouldCollapse('短消息'), false);
  eq(shouldCollapse(''), false);
  eq(shouldCollapse(null), false);
  eq(shouldCollapse(undefined), false);

  // 边界：正好 600 字 / 12 行 → 不折叠（"超过"才折）
  eq(shouldCollapse('a'.repeat(COLLAPSE_CHAR_THRESHOLD)), false, '600 字整不该折叠');
  eq(shouldCollapse('a'.repeat(COLLAPSE_CHAR_THRESHOLD + 1)), true, '601 字要折叠');
  eq(shouldCollapse(Array.from({ length: COLLAPSE_LINE_THRESHOLD }, () => 'x').join('\n')), false);
  eq(
    shouldCollapse(Array.from({ length: COLLAPSE_LINE_THRESHOLD + 1 }, () => 'x').join('\n')),
    true,
    '13 行要折叠',
  );

  // 多行但总字数少、总字数多但只有一行，两条都要各自触发
  eq(shouldCollapse(Array.from({ length: 20 }, () => '短').join('\n')), true);
  eq(shouldCollapse('一'.repeat(2000)), true);
});

check('🔴 折叠预览：1.2 万字 runtime context 只暴露 6 行 / ≤600 字', () => {
  const huge = Array.from({ length: 240 }, (_, i) => `第 ${i + 1} 行：这是一段很长的运行上下文内容`).join('\n');
  const result = collapsePreview(huge);

  eq(result.collapsed, true);
  eq(result.totalLines, 240);
  eq(result.hiddenLines, 240 - COLLAPSE_PREVIEW_LINES);
  ok(result.preview.split('\n').length <= COLLAPSE_PREVIEW_LINES, '预览不能超过 6 行');
  ok(countChars(result.preview) <= COLLAPSE_PREVIEW_CHARS, '预览不能超过 600 字');
  ok(result.preview.startsWith('第 1 行'), '预览必须从原文开头开始');
  ok(result.hiddenChars > 0, '必须报告被折叠的字数');
  eq(
    countChars(result.preview) + result.hiddenChars,
    result.totalChars,
    '可见 + 隐藏 = 总数（不许悄悄吞字）',
  );
});

check('折叠预览：短消息原样返回、标记未折叠', () => {
  const result = collapsePreview('就一句话');
  eq(result.collapsed, false);
  eq(result.preview, '就一句话');
  eq(result.hiddenChars, 0);
  eq(result.hiddenLines, 0);
  eq(result.totalChars, 4);
  eq(result.totalLines, 1);
  eq(expandLabel(result), '', '未折叠时不该有展开文案');
});

check('折叠预览：单行超长文本按字数截断（行数仍算 1）', () => {
  const oneLine = 'x'.repeat(5000);
  const result = collapsePreview(oneLine);
  eq(result.collapsed, true);
  eq(result.totalLines, 1);
  eq(result.hiddenLines, 0, '单行文本没有"隐藏行"');
  eq(countChars(result.preview), COLLAPSE_PREVIEW_CHARS);
  eq(result.hiddenChars, 5000 - COLLAPSE_PREVIEW_CHARS);
  ok(expandLabel(result).includes('共 5000 字'), `文案要带总字数: ${expandLabel(result)}`);
});

check('🔴 折叠按**码点**切：emoji / 代理对不会被切成半个字符', () => {
  const emojis = '👍'.repeat(700);
  eq(countChars(emojis), 700, '码点计数而不是 UTF-16 长度');
  const result = collapsePreview(emojis);
  eq(result.collapsed, true);
  eq(countChars(result.preview), COLLAPSE_PREVIEW_CHARS);
  ok(!result.preview.includes('\uFFFD'), '预览里不能出现替换字符（半个 emoji）');
  eq(countChars(result.preview) + result.hiddenChars, 700);
});

check('折叠：CRLF 归一为 LF，行数统计一致', () => {
  eq(countLines('a\r\nb\rc'), 3, 'CRLF / CR 都算换行');
  const crlf = Array.from({ length: 20 }, (_, i) => `行${i}`).join('\r\n');
  const result = collapsePreview(crlf);
  eq(result.collapsed, true);
  eq(result.totalLines, 20);
  ok(!result.preview.includes('\r'), '预览里不该残留 \\r');
});

check('折叠：空串/null/undefined 不炸且不折叠', () => {
  for (const bad of ['', null, undefined, '   ', '\n\n\n']) {
    const result = collapsePreview(bad);
    eq(result.collapsed, false, `${JSON.stringify(bad)} 不该折叠`);
    eq(result.hiddenChars, 0);
  }
  eq(countChars(null), 0);
  eq(countChars(undefined), 0);
  eq(countLines(null), 0);
});

check('折叠：阈值可覆盖（不同场景不同口径）', () => {
  const text = 'a'.repeat(100);
  eq(shouldCollapse(text, { charThreshold: 50 }), true);
  eq(shouldCollapse(text, { charThreshold: 500 }), false);
  const result = collapsePreview(text, { charThreshold: 50, maxLines: 1, maxChars: 10 });
  eq(result.collapsed, true);
  eq(countChars(result.preview), 10);
});

check('折叠文案：带总字数（有隐藏行时补上行数）', () => {
  const text = Array.from({ length: 30 }, () => 'xx').join('\n');
  const label = expandLabel(collapsePreview(text));
  ok(label.includes(`共 ${countChars(text)} 字`), `要报告总字数: ${label}`);
  ok(label.includes(`${countLines(text)} 行`), `要报告总行数: ${label}`);
  ok(label.startsWith('展开全部（'), '固定前缀，便于 UI/测试对齐');
});

// ── 展开状态按消息 key 记住（切走会话再回来不丢）────────────────────────────

check('展开状态：按会话隔离持久化，切走再回来仍在', () => {
  const store = createMemoryStorage();
  saveExpandedKeys('s1', ['line-3', 'line-9'], store);
  saveExpandedKeys('s2', ['line-1'], store);

  eq(loadExpandedKeys('s1', store), ['line-3', 'line-9'], '顺序也要保住');
  eq(loadExpandedKeys('s2', store), ['line-1']);
  eq(loadExpandedKeys('s3', store), [], '没记录的会话为空');
  eq(expandedKey('s1') === expandedKey('s2'), false);
  eq(expandedKey(''), 'dsh_chat_expanded_v1:default');
});

check('展开状态：空集合删除键，坏数据按"全折叠"处理', () => {
  const store = createMemoryStorage();
  saveExpandedKeys('s', ['a'], store);
  saveExpandedKeys('s', [], store);
  eq(loadExpandedKeys('s', store), [], '空集合要删键，不留垃圾');

  // 坏数据是**预期要吞掉**的情况，临时静音 warn（同时断言确实告警了）
  const realWarn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args[0]);
  try {
    store.setItem(expandedKey('s'), '{不是 JSON');
    eq(loadExpandedKeys('s', store), [], '坏 JSON 不炸，按未展开');
    store.setItem(expandedKey('s'), JSON.stringify([1, null, '', 'ok']));
    eq(loadExpandedKeys('s', store), ['ok'], '非字符串项被过滤');
  } finally {
    console.warn = realWarn;
  }
  eq(warned.length, 1, '坏 JSON 必须 warn 而不是静默（否则用户以为状态记住了）');
});

check('展开状态：超出上限丢最旧的，防 localStorage 被长会话塞满', () => {
  const store = createMemoryStorage();
  const many = Array.from({ length: EXPANDED_MAX_KEYS + 20 }, (_, i) => `line-${i}`);
  saveExpandedKeys('s', many, store);
  const loaded = loadExpandedKeys('s', store);
  eq(loaded.length, EXPANDED_MAX_KEYS);
  eq(loaded[loaded.length - 1], `line-${EXPANDED_MAX_KEYS + 19}`, '保留最新的');
  eq(loaded.includes('line-0'), false, '最旧的被丢');
});

check('展开状态：存储抛异常时不炸（离线/配额满）', () => {
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
  const realWarn = console.warn;
  console.warn = () => {};
  let threw = false;
  try {
    eq(loadExpandedKeys('s', boom), []);
    eq(saveExpandedKeys('s', ['a'], boom), false);
  } catch {
    threw = true;
  } finally {
    console.warn = realWarn;
  }
  ok(!threw, '展开状态读写异常不能冒泡到 UI');
});

// ── 剪贴板回退（消息复制 / 工具卡复制共用）──────────────────────────────────

checkAsync('剪贴板：Node（无 navigator/document）下返回 false 而不是抛错', async () => {
  const done = await copyToClipboard('要复制的内容');
  eq(done, false, '没有 DOM/clipboard 时如实返回 false（UI 显示"复制失败"）');
});

checkAsync('剪贴板：非字符串输入不炸', async () => {
  eq(await copyToClipboard(null), false);
  eq(await copyToClipboard(undefined), false);
  eq(await copyToClipboard(123), false);
});

await Promise.all(pendingChecks);

// ── 报告 ────────────────────────────────────────────────────────────────────

console.log('\n  待发队列 / 草稿 / 折叠 单元测试');
console.log(`  ${'─'.repeat(46)}`);
for (const f of failures) {
  console.log(`  ✗ ${f.name}\n    ${f.message.split('\n').join('\n    ')}`);
}
console.log(`  ${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);

process.exit(failed === 0 ? 0 : 1);