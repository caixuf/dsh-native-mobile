/**
 * 会话分组 / 折叠 / 归档 回归测试（零依赖，手写断言）。
 *
 * 运行：`node --experimental-strip-types scripts/test-session-groups.mjs`
 *
 * 为什么这批断言值得写：用户的原话是「会话全部列出来，给人翻累死了，
 * 而且没有桌面的归档」。所以本文件盯的是**行为**而不是实现：
 *   1. 分组必须真的按 cwd 分（含空 cwd、反斜杠、WSL UNC 的等价写法）；
 *   2. 组内「运行中排前 + 时间倒序」的优先级不能反过来；
 *   3. 折叠状态能存能取，且坏数据不能把 UI 打崩；
 *   4. 归档是**仅本机**的：能隐藏、能恢复、不丢会话；
 *   5. 子代理必须落进它自己的工作区组，而不是混进主会话；
 *   6. 远端搜索结果单独成组，且不能和本地结果重复占两行。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  ARCHIVE_NOTE,
  ARCHIVE_STORAGE_KEY,
  COLLAPSE_STORAGE_KEY,
  SEARCH_GROUP_KEY,
  UNKNOWN_WORKSPACE_KEY,
  compareSessions,
  defaultCollapsedState,
  describeWorkspace,
  filterSessionsByQuery,
  formatSessionTime,
  groupSessions,
  normalizeWorkspace,
  readArchivedIds,
  readCollapseState,
  resolveCollapseState,
  setArchivedId,
  sortSessions,
  subagentSectionKey,
  toIdSet,
  toggleArchivedId,
  writeArchivedIds,
  writeCollapseState,
} from '../src/lib/session-groups.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err.message });
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? ''}\n  expected: ${e}\n  actual:   ${a}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg ?? 'expected truthy');
}

/** 造一条会话。除显式覆盖外字段都是确定值，避免测试互相耦合。 */
function row(id, over = {}) {
  return {
    sessionId: id,
    title: `会话 ${id}`,
    preview: '',
    updatedAt: 1000,
    running: false,
    isSubagent: false,
    parentSessionId: null,
    workspace: null,
    ...over,
  };
}

/** 极简内存 storage，用来观察「到底写了什么」。 */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

/** 会抛异常的 storage（隐私模式 / 配额满）。 */
function hostileStorage() {
  return {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
}

const ids = (rows) => rows.map((r) => r.sessionId);
const groupOf = (grouping, key) => grouping.groups.find((g) => g.key === key);

// ── 1. 按 cwd 分组 ──────────────────────────────────────────────────────────

check('按 cwd 分组：每个工作区一个组，组内会话数正确', () => {
  const g = groupSessions(
    [
      row('a', { workspace: '/home/me/FlowEngine', updatedAt: 500 }),
      row('b', { workspace: '/home/me/aiwork', updatedAt: 900 }),
      row('c', { workspace: '/home/me/FlowEngine', updatedAt: 700 }),
    ],
    [],
  );
  eq(g.workspaceCount, 2);
  eq(ids(groupOf(g, '/home/me/FlowEngine').sessions), ['c', 'a'], 'FlowEngine 组内按时间倒序');
  eq(ids(groupOf(g, '/home/me/aiwork').sessions), ['b']);
  eq(g.visibleCount, 3);
});

check('组间按最近活动倒序（最新工作区在第一个）', () => {
  const g = groupSessions(
    [
      row('old', { workspace: '/w/old', updatedAt: 100 }),
      row('new', { workspace: '/w/new', updatedAt: 9000 }),
      row('mid', { workspace: '/w/mid', updatedAt: 500 }),
    ],
    [],
  );
  eq(g.groups.map((x) => x.label), ['new', 'mid', 'old']);
});

check('路径等价写法必须落到同一个组（反斜杠 / 尾斜杠 / 重复斜杠）', () => {
  const g = groupSessions(
    [
      row('win', { workspace: 'C:\\Users\\me\\proj' }),
      row('win2', { workspace: 'C:/Users/me/proj/' }),
      row('posix', { workspace: '/home/me/proj' }),
      row('posix2', { workspace: '/home/me//proj' }),
    ],
    [],
  );
  eq(g.workspaceCount, 2, 'Windows 写法与 POSIX 写法各自归一');
  eq(g.groups.find((x) => x.label === 'proj' && x.workspace.startsWith('C:')).total, 2);
  eq(groupOf(g, '/home/me/proj').total, 2);
});

check('工作区友好名：取目录名，hint 给父目录', () => {
  eq(describeWorkspace('/home/me/Developer/FlowEngine').label, 'FlowEngine');
  eq(describeWorkspace('/home/me/Developer/FlowEngine').hint, '/home/me/Developer');
  eq(describeWorkspace('C:\\Users\\me\\proj').label, 'proj');
  eq(describeWorkspace('/').label, '/', '根目录不能变成空串');
  eq(describeWorkspace('/').hint, '');
});

check('WSL 路径显示友好名 + distro 提示', () => {
  const unc = describeWorkspace('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj');
  eq(unc.label, 'proj');
  eq(unc.hint, 'WSL · Ubuntu');
  eq(unc.workspace, '//wsl.localhost/Ubuntu/home/me/proj', '归一为 POSIX 风格 UNC');

  const dollar = describeWorkspace('//wsl$/Ubuntu');
  eq(dollar.label, 'Ubuntu', '没有子目录时用发行版名当组名');
  eq(dollar.hint, 'WSL · Ubuntu');

  // 两种 UNC 写法指向不同 distro → 不同组
  const g = groupSessions(
    [row('x', { workspace: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj' }), row('y', { workspace: '//wsl$/Debian/home/me/proj' })],
    [],
  );
  eq(g.workspaceCount, 2);
});

// ── 2. 空 cwd ───────────────────────────────────────────────────────────────

check('空 cwd 全部收敛到「未知工作区」同一组', () => {
  const g = groupSessions(
    [
      row('n1', { workspace: null }),
      row('n2', { workspace: undefined }),
      row('n3', { workspace: '' }),
      row('n4', { workspace: '   ' }),
      row('n5'), // 缺字段
    ],
    [],
  );
  eq(g.workspaceCount, 1);
  const unknown = groupOf(g, UNKNOWN_WORKSPACE_KEY);
  ok(unknown, '未知工作区组存在');
  eq(unknown.label, '未知工作区');
  eq(ids(unknown.sessions).sort(), ['n1', 'n2', 'n3', 'n4', 'n5']);
  eq(normalizeWorkspace('  '), null);
  eq(normalizeWorkspace(null), null);
});

// ── 3. 组内排序 ─────────────────────────────────────────────────────────────

check('组内排序：运行中排前，其次 updatedAt 倒序', () => {
  const rows = [
    row('idle-new', { workspace: '/w', updatedAt: 9000 }),
    row('run-old', { workspace: '/w', updatedAt: 10, running: true }),
    row('idle-old', { workspace: '/w', updatedAt: 100 }),
    row('run-new', { workspace: '/w', updatedAt: 5000, running: true }),
  ];
  eq(ids(sortSessions(rows)), ['run-new', 'run-old', 'idle-new', 'idle-old']);
});

check('组内排序：同 running 同时间时用 sessionId 兜底（稳定且确定）', () => {
  const rows = [row('b', { updatedAt: 5 }), row('a', { updatedAt: 5 }), row('c', { updatedAt: 5 })];
  eq(ids(sortSessions(rows)), ['a', 'b', 'c']);
  eq(compareSessions(row('a'), row('a')), 0);
  // 反向对照：确认不是「永远 -1」的假实现
  ok(compareSessions(row('a', { updatedAt: 1 }), row('b', { updatedAt: 2 })) > 0);
  ok(compareSessions(row('a', { running: true }), row('b', { updatedAt: 999 })) < 0);
});

check('排序不就地修改输入数组', () => {
  const rows = [row('1', { updatedAt: 1 }), row('2', { updatedAt: 2 })];
  const copy = [...rows];
  sortSessions(rows);
  eq(ids(rows), ids(copy), '传入数组必须原样不动');
});

check('updatedAt 缺失/NaN 不会把排序搞乱', () => {
  const rows = [row('nan', { updatedAt: NaN }), row('ok', { updatedAt: 50 }), row('miss', { updatedAt: undefined })];
  // NaN / undefined 都折算成 0（排最后），再用 sessionId 兜底成确定顺序
  eq(ids(sortSessions(rows)), ['ok', 'miss', 'nan']);
});

check('分组不会就地修改输入的 sessions/subagentSessions', () => {
  const main = [row('a', { workspace: '/w', updatedAt: 1 }), row('b', { workspace: '/w', updatedAt: 2 })];
  const subs = [row('s', { workspace: '/w', updatedAt: 3, isSubagent: true })];
  const mainCopy = ids(main);
  const subsCopy = ids(subs);
  groupSessions(main, subs, { archivedIds: ['a'] });
  eq(ids(main), mainCopy);
  eq(ids(subs), subsCopy);
});

// ── 4. 折叠状态存取 ─────────────────────────────────────────────────────────

check('默认折叠：只展开含最新会话的工作区组', () => {
  const g = groupSessions(
    [
      row('x', { workspace: '/w/old', updatedAt: 10 }),
      row('y', { workspace: '/w/new', updatedAt: 99 }),
      row('z', { workspace: '/w/mid', updatedAt: 50 }),
    ],
    [],
  );
  const state = defaultCollapsedState(g.groups);
  eq(state['/w/new'], false, '最新的组默认展开');
  eq(state['/w/old'], true);
  eq(state['/w/mid'], true);
});

check('默认折叠：搜索组永远展开，未知工作区组也参与「最新」判定', () => {
  const g = groupSessions(
    [row('remote', { workspace: '/w/a', updatedAt: 1 }), row('local', { updatedAt: 77 })],
    [],
    { searchQuery: 'x', searchResults: [row('r1', { updatedAt: 5 })] },
  );
  const state = defaultCollapsedState(g.groups);
  eq(state[SEARCH_GROUP_KEY], false);
  eq(state[UNKNOWN_WORKSPACE_KEY], false, '本地最新会话在未知工作区 → 它展开');
  eq(state['/w/a'], true);
});

check('折叠状态：写入后能原样读回', () => {
  const st = fakeStorage();
  ok(writeCollapseState({ '/w/a': true, [SEARCH_GROUP_KEY]: false }, st), '写应成功');
  eq(readCollapseState(st), { '/w/a': true, [SEARCH_GROUP_KEY]: false });
  ok(st.map.has(COLLAPSE_STORAGE_KEY), 'key 必须自带版本号，避免旧结构污染');
  ok(COLLAPSE_STORAGE_KEY.includes('v1'));
});

check('折叠状态：坏 JSON / 非对象 / 非布尔值全部安全降级', () => {
  eq(readCollapseState(fakeStorage({ [COLLAPSE_STORAGE_KEY]: '{不是 JSON' })), {});
  eq(readCollapseState(fakeStorage({ [COLLAPSE_STORAGE_KEY]: '"字符串"' })), {});
  eq(readCollapseState(fakeStorage({ [COLLAPSE_STORAGE_KEY]: '[1,2]' })), {});
  eq(readCollapseState(fakeStorage()), {}, '没写过 → 空对象');
  eq(readCollapseState(null), {}, '没有 storage（SSR/隐私模式）→ 空对象');
  eq(
    readCollapseState(fakeStorage({ [COLLAPSE_STORAGE_KEY]: '{"a":true,"b":"yes","c":1,"d":null}' })),
    { a: true },
    '只接受布尔值',
  );
});

check('折叠状态：storage 抛异常时不崩，写操作返回 false', () => {
  const hostile = hostileStorage();
  eq(readCollapseState(hostile), {});
  eq(writeCollapseState({ a: true }, hostile), false);
  eq(writeCollapseState({ a: true }, null), false);
});

check('折叠状态：显式选择优先于默认值（用户折叠了最新组，就必须记住）', () => {
  const g = groupSessions(
    [row('a', { workspace: '/w/new', updatedAt: 99 }), row('b', { workspace: '/w/old', updatedAt: 10 })],
    [],
  );
  const resolved = resolveCollapseState(g.groups, { '/w/new': true, '/w/old': false });
  eq(resolved['/w/new'], true, '用户手动折叠 → 覆盖默认展开');
  eq(resolved['/w/old'], false, '用户手动展开 → 覆盖默认折叠');
  // 未记录的组回到默认
  const partial = resolveCollapseState(g.groups, { '/w/old': false });
  eq(partial['/w/new'], false);
  eq(partial['/w/old'], false);
});

check('折叠状态：子代理子节默认折叠，且能被单独展开', () => {
  const g = groupSessions(
    [row('m', { workspace: '/w', updatedAt: 5 })],
    [row('s', { workspace: '/w', isSubagent: true, updatedAt: 4 })],
  );
  const subKey = subagentSectionKey('/w');
  eq(subKey, '/w::subagents');
  eq(resolveCollapseState(g.groups, null)[subKey], true, '子代理默认折叠');
  eq(resolveCollapseState(g.groups, { [subKey]: false })[subKey], false, '用户展开后要记住');
  // 没有子代理的组不产生多余 key
  const noSubs = groupSessions([row('m', { workspace: '/w2' })], []);
  eq(subagentSectionKey('/w2') in resolveCollapseState(noSubs.groups, null), false);
});

// ── 5. 归档过滤 ─────────────────────────────────────────────────────────────

check('归档：从工作区组隐藏，落入 archived 列表', () => {
  const g = groupSessions(
    [row('keep', { workspace: '/w' }), row('gone', { workspace: '/w' })],
    [],
    { archivedIds: ['gone'] },
  );
  eq(ids(groupOf(g, '/w').sessions), ['keep']);
  eq(ids(g.archived), ['gone']);
  eq(g.archivedCount, 1);
  eq(g.hiddenCount, 1);
  eq(g.visibleCount, 1);
});

check('归档：整组被归档后该工作区组消失（不留空壳组）', () => {
  const g = groupSessions([row('only', { workspace: '/w/solo' })], [], { archivedIds: ['only'] });
  eq(g.groups.length, 0);
  eq(g.archivedCount, 1);
});

check('归档：子代理会话也能被归档', () => {
  const g = groupSessions(
    [row('m', { workspace: '/w' })],
    [row('s1', { workspace: '/w', isSubagent: true }), row('s2', { workspace: '/w', isSubagent: true })],
    { archivedIds: ['s1'] },
  );
  eq(ids(groupOf(g, '/w').subagents), ['s2']);
  eq(ids(g.archived), ['s1']);
});

check('归档 ids：读写 / 去重 / 过滤脏数据 / toggle 幂等', () => {
  const st = fakeStorage();
  ok(writeArchivedIds(['a', 'a', '', null, 7, 'b'], st), '写应成功');
  eq(readArchivedIds(st), ['a', 'b'], '重复与脏值被清掉');
  ok(ARCHIVE_STORAGE_KEY.includes('v1'));

  eq(toggleArchivedId(['a'], 'a'), [], '再点一次 = 取消归档');
  eq(toggleArchivedId(['a'], 'b'), ['a', 'b']);
  eq(toggleArchivedId([], ''), [], '空 id 不动');
  eq(setArchivedId(['a'], 'a', true), ['a'], '重复归档不产生重复项');
  eq(setArchivedId(['a', 'b'], 'a', false), ['b']);
  eq(readArchivedIds(fakeStorage({ [ARCHIVE_STORAGE_KEY]: '{"a":1}' })), [], '非数组 → 空');
  eq(readArchivedIds(null), []);
});

check('归档：恢复后可回到原工作区组', () => {
  const rows = [row('a', { workspace: '/w' })];
  const archivedView = groupSessions(rows, [], { archivedIds: ['a'] });
  eq(archivedView.visibleCount, 0);

  const restored = setArchivedId(['a'], 'a', false);
  const back = groupSessions(rows, [], { archivedIds: restored });
  eq(back.visibleCount, 1);
  eq(back.archivedCount, 0);
  eq(ids(groupOf(back, '/w').sessions), ['a']);
});

check('归档说明必须如实写「仅本机」，不能暗示同步回主机', () => {
  ok(ARCHIVE_NOTE.includes('仅本机'), '文案必须点明只在本机生效');
  ok(ARCHIVE_NOTE.includes('不会同步') || ARCHIVE_NOTE.includes('不会同步回电脑'));
});

// ── 6. 子代理归类 ───────────────────────────────────────────────────────────

check('子代理落到所属工作区的子代理子节，不与主会话混排', () => {
  const g = groupSessions(
    [row('m1', { workspace: '/w' }), row('m2', { workspace: '/w2' })],
    [row('s1', { workspace: '/w', isSubagent: true }), row('s2', { workspace: '/w2', isSubagent: true })],
  );
  eq(ids(groupOf(g, '/w').sessions), ['m1']);
  eq(ids(groupOf(g, '/w').subagents), ['s1']);
  eq(groupOf(g, '/w').total, 2, 'total 必须含子代理');
  eq(g.visibleCount, 4);
});

check('子代理继承父会话缺失的 workspace 时归入未知工作区（不丢）', () => {
  const g = groupSessions([], [row('s', { isSubagent: true, workspace: null })]);
  eq(ids(groupOf(g, UNKNOWN_WORKSPACE_KEY).subagents), ['s']);
  eq(g.visibleCount, 1);
});

check('运行中计数：主会话 + 子代理都计入组头与总数', () => {
  const g = groupSessions(
    [row('m', { workspace: '/w', running: true })],
    [row('s', { workspace: '/w', isSubagent: true, running: true }), row('s2', { workspace: '/w', isSubagent: true })],
  );
  eq(groupOf(g, '/w').runningCount, 2);
  eq(g.runningCount, 2);
});

check('组内子代理与主会话各自独立排序', () => {
  const g = groupSessions(
    [row('m-old', { workspace: '/w', updatedAt: 1 }), row('m-new', { workspace: '/w', updatedAt: 2 })],
    [row('s-old', { workspace: '/w', isSubagent: true, updatedAt: 1, running: true }), row('s-new', { workspace: '/w', isSubagent: true, updatedAt: 3 })],
  );
  eq(ids(groupOf(g, '/w').sessions), ['m-new', 'm-old']);
  eq(ids(groupOf(g, '/w').subagents), ['s-old', 's-new'], '子代理同样「运行中排前」');
});

// ── 7. 搜索合并 ─────────────────────────────────────────────────────────────

check('搜索：远端结果单独成组并置顶', () => {
  const g = groupSessions(
    [row('local', { workspace: '/w/local', updatedAt: 10 })],
    [],
    { searchQuery: '部署', searchResults: [row('r1', { updatedAt: 5, preview: '远端' }), row('r2', { updatedAt: 6 })] },
  );
  eq(g.groups[0].key, SEARCH_GROUP_KEY);
  eq(g.groups[0].kind, 'search');
  eq(g.groups[0].label, '搜索结果');
  eq(ids(g.groups[0].sessions), ['r2', 'r1'], '远端结果也按时间倒序');
  eq(g.workspaceCount, 1, '工作区组数不含搜索组');
});

check('搜索：与本地重复的远端结果只算一次（不重复占两行）', () => {
  const g = groupSessions(
    [row('dup', { workspace: '/w', updatedAt: 3 }), row('local', { workspace: '/w', updatedAt: 9 })],
    [],
    { searchQuery: 'a', searchResults: [row('dup'), row('fresh')] },
  );
  eq(ids(g.groups[0].sessions), ['fresh'], '重复 id 不进搜索组');
  eq(g.searchDuplicateCount, 1);
  eq(g.groups[0].hiddenDuplicateCount, 1);
  eq(ids(groupOf(g, '/w').sessions), ['local', 'dup'], '本地那条仍然在工作区组里');
});

check('搜索：远端自身重复 id 也会去重', () => {
  const g = groupSessions([], [], { searchQuery: 'a', searchResults: [row('r'), row('r')] });
  eq(ids(g.groups[0].sessions), ['r']);
  eq(g.searchDuplicateCount, 1);
});

check('搜索：没有远端结果时只做本地过滤，不产生空搜索组', () => {
  const noRemote = groupSessions([row('a', { workspace: '/w' })], [], { searchQuery: 'a', searchResults: [] });
  eq(noRemote.groups.some((x) => x.kind === 'search'), false);

  const noQuery = groupSessions([row('a', { workspace: '/w' })], [], { searchQuery: '   ', searchResults: [row('r')] });
  eq(noQuery.groups.some((x) => x.kind === 'search'), false, '空搜索词不该冒出搜索组');

  const allDup = groupSessions([row('r')], [], { searchQuery: 'a', searchResults: [row('r')] });
  eq(allDup.groups.some((x) => x.kind === 'search'), false, '全是重复 → 不显示搜索组');
  eq(allDup.searchDuplicateCount, 1);
});

check('本地即时过滤：命中标题 / 摘要 / 工作区，大小写不敏感', () => {
  const rows = [
    row('a', { title: 'Deploy 到生产', preview: '' }),
    row('b', { title: 'x', preview: 'nginx reload' }),
    row('c', { title: 'y', workspace: '/home/me/FlowEngine' }),
    row('d', { title: '无关' }),
  ];
  eq(ids(filterSessionsByQuery(rows, 'deploy')), ['a']);
  eq(ids(filterSessionsByQuery(rows, 'NGINX')), ['b']);
  eq(ids(filterSessionsByQuery(rows, 'flowengine')), ['c']);
  eq(ids(filterSessionsByQuery(rows, '   ')), ['a', 'b', 'c', 'd'], '空搜索词 = 全部');
  eq(ids(filterSessionsByQuery(rows, 'zzz')), []);
});

// ── 8. 时间显示 ─────────────────────────────────────────────────────────────

check('相对时间：刚刚 / 分钟 / 小时 / 日期 / 跨年', () => {
  const now = new Date('2026-10-14T12:00:00').getTime();
  eq(formatSessionTime(now - 5 * 1000, now), '刚刚');
  eq(formatSessionTime(now - 5 * 60 * 1000, now), '5 分钟前');
  eq(formatSessionTime(now - 3 * 3600 * 1000, now), '3 小时前');
  eq(formatSessionTime(new Date('2026-10-01T00:00:00').getTime(), now), '10月1日');
  eq(formatSessionTime(new Date('2025-12-31T00:00:00').getTime(), now), '2025年12月31日');
  eq(formatSessionTime(0, now), '', '0 / 缺失 → 空串');
  eq(formatSessionTime(undefined, now), '');
  eq(formatSessionTime(now + 60 * 1000, now), '刚刚', '时钟漂移到未来也不能显示负数');
});

// ── 9. 规模 / 性能 ──────────────────────────────────────────────────────────

check('分组是 O(n)：5000 会话 / 50 工作区不退化，且每组 key 唯一', () => {
  const rows = [];
  for (let i = 0; i < 5000; i++) {
    rows.push(row(`s${i}`, { workspace: `/w/ws${i % 50}`, updatedAt: i, running: i % 997 === 0 }));
  }
  const t0 = performance.now();
  const g = groupSessions(rows, [], { archivedIds: [], searchResults: [], searchQuery: '' });
  const dt = performance.now() - t0;

  eq(g.workspaceCount, 50);
  eq(g.visibleCount, 5000);
  eq(new Set(g.groups.map((x) => x.key)).size, 50, '组 key 不能重复');
  eq(
    g.groups.reduce((n, x) => n + x.total, 0),
    5000,
    '一条会话都不能丢',
  );
  ok(dt < 150, `5000 条分组耗时 ${dt.toFixed(1)}ms，应远低于 150ms`);
});

check('空输入不炸', () => {
  const g = groupSessions([], []);
  eq(g.groups, []);
  eq(g.archived, []);
  eq(g.workspaceCount, 0);
  eq(groupSessions(null, undefined).groups, []);
  eq(defaultCollapsedState([]), {});
  eq(resolveCollapseState([], null), {});
  eq(toIdSet(null).size, 0);
});

// ── 10. 组件层契约（不跑构建，只做源码级检查）────────────────────────────────

check('🔴 无依赖可折叠：必须用 aria-expanded/aria-controls 且分组 memo 化', () => {
  const screen = readFileSync(path.join(ROOT, 'src/components/screens/SessionsScreen.tsx'), 'utf8');
  const collapse = readFileSync(path.join(ROOT, 'src/components/sessions/CollapsibleSection.tsx'), 'utf8');
  const groupSection = readFileSync(path.join(ROOT, 'src/components/sessions/SessionGroupSection.tsx'), 'utf8');
  const archive = readFileSync(path.join(ROOT, 'src/components/sessions/ArchivedSection.tsx'), 'utf8');

  ok(collapse.includes('aria-expanded'), '可折叠组件必须暴露 aria-expanded');
  ok(collapse.includes('aria-controls'), '可折叠组件必须暴露 aria-controls');
  ok(collapse.includes('useId'), 'panel id 必须唯一（同一页多个组）');
  ok(/<button/.test(collapse), '折叠头必须是真 button（键盘可达）');
  ok(groupSection.includes('CollapsibleSection'), '工作区组必须走可折叠容器');
  ok(groupSection.includes('子代理'), '子代理必须是组内子节');
  ok(archive.includes('ARCHIVE_NOTE'), '归档区必须显示「仅本机」说明');
  ok(screen.includes('SessionGroupSection'), 'SessionsScreen 必须按工作区渲染分组');
  ok(screen.includes('ArchivedSection'), 'SessionsScreen 必须渲染归档区');
  ok(screen.includes('useMemo'), '分组计算必须 memo 化，不能在每次 render 重算');
  ok(!/showSubagents/.test(screen), '旧的全量平铺/子代理开关应被分组子节取代');
});

check('🔴 不引入新运行时依赖：本次改动的文件只许用已存在的依赖', () => {
  const allowed = new Set(['react', 'lucide-react', 'clsx', 'tailwind-merge']);
  const files = [
    'src/lib/session-groups.ts',
    'src/components/sessions/CollapsibleSection.tsx',
    'src/components/sessions/SessionCard.tsx',
    'src/components/sessions/SessionGroupSection.tsx',
    'src/components/sessions/ArchivedSection.tsx',
    'src/components/screens/SessionsScreen.tsx',
  ];
  const offenders = [];
  for (const file of files) {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of src.matchAll(/from\s+'([^']+)'/g)) {
      const spec = match[1];
      if (spec.startsWith('.')) continue; // 仓库内部相对导入
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!allowed.has(pkg)) offenders.push(`${file}: ${spec}`);
    }
  }
  eq(offenders, [], `本次改造不允许新增运行时依赖，却发现：\n${offenders.join('\n')}`);
});

check('纯函数层不许有运行时导入（测试才能免 hook 直跑）', () => {
  const src = readFileSync(path.join(ROOT, 'src/lib/session-groups.ts'), 'utf8');
  const runtimeImports = [...src.matchAll(/^\s*import\s+(?!type\b)[^;]*;/gm)].map((m) => m[0].trim());
  eq(runtimeImports, [], 'session-groups.ts 必须零运行时依赖（只允许 import type）');
});

// ── 报告 ────────────────────────────────────────────────────────────────────

console.log(`\n  会话分组 / 折叠 / 归档 单元测试`);
console.log(`  ${'─'.repeat(46)}`);
for (const f of failures) {
  console.log(`  ✗ ${f.name}\n    ${f.message.split('\n').join('\n    ')}`);
}
console.log(`  ${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);

process.exit(failed === 0 ? 0 : 1);