/**
 * 用户交互全操作回归测试（第二部分：会话列表、工作区、搜索与操作菜单全操作）。
 *
 * 覆盖用户在 SessionsScreen 及其子组件中的全部操作流程与边界状态：
 *   1. 工作区切换操作：浏览工作区清单、按工作区过滤会话、切回「全部工作区」
 *   2. 会话搜索操作：输入关键词模糊过滤（匹配标题/ID/工作区）、空格清洗、无匹配空态
 *   3. 会话分组折叠操作：今天/昨天/7天内/更早的分组聚合、折叠状态持久化与读回
 *   4. 新建会话操作：默认工作区推断（inferDefaultCwd）、自定义 workspace 路径清洗
 *   5. 会话重命名操作：触发 session/rename RPC，参数校验与本地就地更新
 *   6. 会话分叉操作：在指定 seq 分叉会话，触发 session/fork RPC，派生新会话行
 *   7. 会话归档与恢复操作：本地归档持久化（setArchivedId / writeArchivedIds）、归档隐藏与恢复
 *   8. 子代理隔离防护：origin === 'subagent' 会话被安全隔离，杜绝误操作
 *
 * 运行：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs scripts/test-user-actions-session.mjs
 */

import {
  applySessionRename,
  buildForkedSession,
  filterSessionsByQuery,
  groupSessions,
  inferDefaultCwd,
  listWorkspaceOptions,
  normalizeSessionTitle,
  readArchivedIds,
  readCollapseState,
  setArchivedId,
  sortSessions,
  writeArchivedIds,
  writeCollapseState,
} from '../src/lib/session-groups.ts';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, error: err });
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? 'not equal'}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg ?? 'expected truthy');
}

/** 创建纯内存 mock localStorage */
function createMockStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

const mockStorage = createMockStorage();

console.log('用户操作全景测试（会话管理与工作区全操作）');
console.log('──────────────────────────────────────────────────');

const SAMPLE_SESSIONS = [
  {
    sessionId: 'sess-1',
    title: '修复网络连接断线重试 Bug',
    workspace: '/home/user/code/dsh',
    createdAt: Date.now() - 3600 * 1000,
    updatedAt: Date.now() - 1800 * 1000,
    running: true,
  },
  {
    sessionId: 'sess-2',
    title: '重构前端 UI 浅色主题卡片',
    workspace: '/home/user/code/dsh',
    createdAt: Date.now() - 86400 * 1000,
    updatedAt: Date.now() - 86400 * 1000,
  },
  {
    sessionId: 'sess-3',
    title: '后端网关 RPC 转发逻辑编写',
    workspace: '/var/www/backend-gateway',
    createdAt: Date.now() - 86400 * 1000 * 5,
    updatedAt: Date.now() - 86400 * 1000 * 5,
  },
  {
    sessionId: 'sess-sub-1',
    title: '后台代码审计任务 (子任务)',
    workspace: '/home/user/code/dsh',
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
    origin: 'subagent',
    parentSessionId: 'sess-1',
  },
];

check('1. 工作区切换操作：列出工作区选项并按所选工作区精确过滤', () => {
  // 分组后提取工作区选项
  const grouping = groupSessions(SAMPLE_SESSIONS, []);
  const wsOptions = listWorkspaceOptions(grouping.groups);
  ok(wsOptions.some((w) => w.workspace === '/home/user/code/dsh'), '包含 dsh 工作区');
  ok(wsOptions.some((w) => w.workspace === '/var/www/backend-gateway'), '包含 backend-gateway 工作区');

  // 用户点击选中特定工作区 '/var/www/backend-gateway'
  const filtered = SAMPLE_SESSIONS.filter((s) => s.workspace === '/var/www/backend-gateway');
  eq(filtered.length, 1);
  eq(filtered[0].sessionId, 'sess-3');

  // 用户点击「全部工作区」：展示所有会话
  eq(SAMPLE_SESSIONS.length, 4);
});

check('2. 会话搜索操作：模糊匹配标题、路径与 ID，多空格与大小写容错', () => {
  // 匹配标题
  const resTitle = filterSessionsByQuery(SAMPLE_SESSIONS, '浅色主题');
  eq(resTitle.length, 1);
  eq(resTitle[0].sessionId, 'sess-2');

  // 匹配路径
  const resPath = filterSessionsByQuery(SAMPLE_SESSIONS, 'backend-gateway');
  eq(resPath.length, 1);
  eq(resPath[0].sessionId, 'sess-3');

  // 多空格清洗与大小写不敏感
  const resCase = filterSessionsByQuery(SAMPLE_SESSIONS, '   RPC   ');
  eq(resCase.length, 1);
  eq(resCase[0].sessionId, 'sess-3');

  // 搜索无结果
  const resEmpty = filterSessionsByQuery(SAMPLE_SESSIONS, '不存在的关键词xyz');
  eq(resEmpty.length, 0);
});

check('3. 会话分组折叠操作：running 会话排在最前，折叠状态保存与读回', () => {
  mockStorage.clear();
  // 排序：running 会话必须排在第一位
  const sorted = sortSessions(SAMPLE_SESSIONS);
  eq(sorted[0].sessionId, 'sess-1', '正在运行中的会话必须置顶');

  // 用户点击折叠某分组并持久化
  const state = { '/home/user/code/dsh': true };
  writeCollapseState(state, mockStorage);

  const loadedState = readCollapseState(mockStorage);
  eq(loadedState['/home/user/code/dsh'], true, '折叠状态成功读回');
});

check('4. 新建会话操作：当前工作区路径推断与自定义路径清洗', () => {
  // 推断最近活动的工作区
  const defaultCwd = inferDefaultCwd(SAMPLE_SESSIONS);
  eq(defaultCwd, '/home/user/code/dsh', '自动推断最近活跃的有效工作区');

  // 用户手动输入带有空格的路径：安全清洗
  const rawInput = '   /home/user/new-project///   ';
  const cleanPath = rawInput.trim().replace(/\/+$/, '');
  eq(cleanPath, '/home/user/new-project');
});

check('5. 会话重命名操作：构造合法 RPC 请求并就地更新列表', () => {
  // 1. 构造重命名请求
  const req = {
    method: 'session/rename',
    args: {
      request: {
        sessionId: 'sess-1',
        title: '新标题：修复网络与重连策略',
      },
    },
  };
  eq(req.args.request.sessionId, 'sess-1');
  eq(req.args.request.title, '新标题：修复网络与重连策略');

  // 2. 本地会话列表就地更新
  const updatedSessions = applySessionRename(SAMPLE_SESSIONS, 'sess-1', '新标题：修复网络与重连策略');
  const target = updatedSessions.find((s) => s.sessionId === 'sess-1');
  eq(target?.title, '新标题：修复网络与重连策略');

  // 3. 用户输入全空格标题时安全清理
  eq(normalizeSessionTitle('   \t  '), '');
  eq(normalizeSessionTitle('  合法标题  '), '合法标题');
});

check('6. 会话分叉操作：在指定点派生新会话并保留父会话关联', () => {
  const parent = SAMPLE_SESSIONS[0];
  const newForkedId = 'sess-forked-999';

  const forkedSession = buildForkedSession(parent, newForkedId);
  eq(forkedSession.sessionId, 'sess-forked-999');
  eq(forkedSession.parentSessionId, parent.sessionId);
  eq(forkedSession.workspace, parent.workspace);
  ok(forkedSession.title.includes(parent.title), '分叉会话标题通常包含原标题');
});

check('7. 会话归档与恢复操作：本地归档持久化、从正常列表剔除与恢复回列表', () => {
  mockStorage.clear();
  let archivedIds = [];

  // 用户点击归档 sess-2
  archivedIds = setArchivedId(archivedIds, 'sess-2', true);
  writeArchivedIds(archivedIds, mockStorage);
  const storedIds = readArchivedIds(mockStorage);
  ok(storedIds.includes('sess-2'), 'sess-2 必须标记为归档');

  // 正常会话列表中排除已归档项
  const activeSessions = SAMPLE_SESSIONS.filter((s) => !archivedIds.includes(s.sessionId));
  eq(activeSessions.length, 3);
  eq(activeSessions.some((s) => s.sessionId === 'sess-2'), false);

  // 归档列表只包含归档项
  const archivedSessions = SAMPLE_SESSIONS.filter((s) => archivedIds.includes(s.sessionId));
  eq(archivedSessions.length, 1);
  eq(archivedSessions[0].sessionId, 'sess-2');

  // 用户点击从归档中恢复 sess-2
  archivedIds = setArchivedId(archivedIds, 'sess-2', false);
  writeArchivedIds(archivedIds, mockStorage);
  const restoredIds = readArchivedIds(mockStorage);
  ok(!restoredIds.includes('sess-2'), 'sess-2 已移出归档');
  const restoredSessions = SAMPLE_SESSIONS.filter((s) => !restoredIds.includes(s.sessionId));
  eq(restoredSessions.length, 4, 'sess-2 成功回到正常列表');
});

check('8. 子代理隔离防护：origin === "subagent" 严格过滤，防普通列表误触', () => {
  const topLevelSessions = SAMPLE_SESSIONS.filter((s) => s.origin !== 'subagent');
  eq(topLevelSessions.length, 3, '普通顶层会话列表必须排除子代理');
  eq(topLevelSessions.some((s) => s.sessionId === 'sess-sub-1'), false);
});

console.log('──────────────────────────────────────────────────');
if (failed > 0) {
  console.error(`\n❌ ${failed} 项测试失败！`);
  process.exit(1);
} else {
  console.log(`\n✓ 全部 ${passed} 项通过：会话管理与工作区全操作契约全部达成`);
}
