/**
 * 归档同步与运行态对账的护栏。
 *
 * ## 为什么需要它（两个真实用户反馈，都是静默失败）
 *
 * 2026-10-20 用户报告：
 *   ① 「手机上点归档没有成功」 —— 点了没反应，也没有任何错误提示；
 *   ② 「电脑上任务已经结束了，手机显示还在执行」 —— 状态永远卡在过期值。
 *
 * 两者根因都不是协议（协议实测是通的），而是**前端接线**：
 *
 * ① 归档失败时只调了 `setError`，而 `setError` 的展示位在**聊天页**；
 *    归档动作发生在**会话列表页** → 用户看不到任何反馈。
 *    另外 `refreshWorkspaceState` 当时是个**空函数**（只有 `void conn;`），
 *    归档成功后根本没有再对齐权威集合。
 *
 * ② `handleOpenSession` 用**列表快照** `session.running` 设初始状态，
 *    而真正刷新 running 的 `startTurnWatch` **只在发消息后启动** ——
 *    纯浏览历史时没有任何对账，过期状态一直挂着。
 *
 * 这两类 bug 功能测试全绿（接口能调通、按钮在 DOM 里），
 * 只有"接线正确性"的静态护栏能盯住。
 *
 *   node --experimental-strip-types scripts/test-sync-wiring.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** 剥离注释：护栏只盯代码，不误伤解释性注释（上一版踩过这个坑）。 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err?.message || err}`);
  }
}
const ok = (cond, msg) => assert.ok(cond, msg);

console.log('\n  归档同步 + 运行态对账 护栏');
console.log('  ' + '─'.repeat(50));

const app = codeOnly(read('src/App.tsx'));
const sync = codeOnly(read('src/services/workspace-sync.ts'));

// ── ① 归档 ──────────────────────────────────────────────────

test('refreshWorkspaceState 不能是空实现（必须有真实对齐动作）', () => {
  // 旧实现是：const refreshWorkspaceState = useCallback(async () => { ... void conn; }, [])
  const m = app.match(/const refreshWorkspaceState = useCallback\([\s\S]*?\}, \[\]\);/);
  ok(m, '找不到 refreshWorkspaceState 定义');
  const body = m[0];
  ok(!/^\s*void conn;\s*$/m.test(body.replace(/const refreshWorkspaceState[^{]*\{/, '')), 'refreshWorkspaceState 不能只有 void conn');
  ok(/subscribeWorkspaceState/.test(body), '必须真的重新订阅（拉权威集合）');
});

test('归档失败必须在**会话列表页**可见（不能只 setError 到聊天页）', () => {
  // 归档动作来自 SessionsScreen，setError 的展示位在 ChatScreen → 用户看不到
  const m = app.match(/const applyArchive = \([\s\S]*?\n  \};/);
  ok(m, '找不到 applyArchive');
  const body = m[0];
  ok(/setCreateNotice/.test(body), '归档结果必须走列表页的 createNotice 通道');
  ok(/kind: 'error'/.test(body), '失败必须是 error 类型');
  // 成功也要有反馈：列表里那行只是"移走"，折叠时用户看不出来
  ok(/已归档|已取消归档/.test(body), '成功也要给可见反馈');
});

test('归档失败要回滚本地状态（不能乐观更新后不撤销）', () => {
  const m = app.match(/const applyArchive = \([\s\S]*?\n  \};/);
  const body = m[0];
  ok(/setArchivedIds\(rollback\)/.test(body), '失败必须回滚 archivedIds');
  ok(/writeArchivedIds\(rollback/.test(body), '失败必须回滚本地缓存');
});

test('未连接时归档不能假装成功', () => {
  const body = app.match(/const applyArchive = \([\s\S]*?\n  \};/)?.[0] || '';
  ok(/if \(!conn\)/.test(body), '必须显式处理无连接分支');
  ok(/setCreateNotice\(/.test(body), '无连接时必须提示用户');
});

test('归档/置顶走后端官方端点，且有对应客户端函数', () => {
  for (const fn of ['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession']) {
    ok(new RegExp(`export async function ${fn}`).test(sync), `workspace-sync 缺少 ${fn}`);
  }
});

// ── ② 运行态对账 ────────────────────────────────────────────

test('打开会话必须启动运行态校准（不能只用列表快照）', () => {
  const m = app.match(/const handleOpenSession = [\s\S]*?\n  \};/);
  ok(m, '找不到 handleOpenSession');
  const body = m[0];
  // 快照仍然可以用作**初始值**，但必须有后续对账
  ok(/setRunning\(session\.running === true\)/.test(body), '初始值来自快照（可接受）');
  ok(/startRunningWatch/.test(body), '必须启动 startRunningWatch 校准过期状态');
});

test('校准循环会查主机真值，并且能自己停（不能永久空转）', () => {
  const m = app.match(/const startRunningWatch = useCallback\([\s\S]*?\n    \[stopRunningWatch\],\n  \);/);
  ok(m, '找不到 startRunningWatch');
  const body = m[0];
  ok(/'session\/list'/.test(body), '必须查 session/list 拿真值');
  ok(/stopRunningWatch\(\)/.test(body), '必须能停止（切会话/稳定后）');
  ok(/ticks > \d+/.test(body), '必须有拍数上限，避免长期轮询');
  ok(/stableStreak/.test(body), '稳定后应停止校准');
});

test('卸载时要停掉校准循环（防定时器泄漏）', () => {
  ok(/useEffect\(\(\) => stopRunningWatch/.test(app), '缺少 stopRunningWatch 的清理 effect');
});

test('只在状态真的变化时 setRunning（避免无谓重渲染）', () => {
  const m = app.match(/const startRunningWatch = useCallback\([\s\S]*?\n    \[stopRunningWatch\],\n  \);/)?.[0] || '';
  ok(/prev === truth/.test(m), '必须比较前后值，相同则不改状态');
});

console.log('  ' + '─'.repeat(50));
console.log(`  ${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
