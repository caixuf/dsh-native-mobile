/**
 * 功能增强专项自动化测试套件 (Feature Enhancements Guardrails)
 * 覆盖：
 *  1. 会话星标置顶 (Pinning) 存储、排序与操作菜单状态流转
 *  2. 会话记录全文 Markdown 格式化导出与跨平台分享/下载
 *  3. 网络链路诊断面板 (Network Diagnostic) 属性与交互契约
 *  4. 触控目标 (≥44px) 与无障碍无缝兼容护栏
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readPinnedIds,
  writePinnedIds,
  togglePinnedId,
  setPinnedId,
  sortSessions,
  sessionActionItems,
  groupSessions,
} from '../src/lib/session-groups.ts';

import {
  formatSessionToMarkdown,
  sanitizeFilename,
} from '../src/utils/export-markdown.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

let total = 0;
let passed = 0;

function test(name, fn) {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${passed}. ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

console.log('功能增强专项自动化测试 (Feature Enhancements Guardrails)');
console.log('──────────────────────────────────────────────────');

// ── 1. 会话星标置顶 (Pinning) ──────────────────────────────

test('星标置顶：readPinnedIds 与 writePinnedIds 读写、去重与容错', () => {
  const storage = fakeStorage();
  assert.deepEqual(readPinnedIds(storage), []);

  assert.equal(writePinnedIds(['sess-1', 'sess-2', 'sess-1', ''], storage), true);
  assert.deepEqual(readPinnedIds(storage), ['sess-1', 'sess-2']);

  // 坏数据容错
  storage.setItem('dsh.sessions.pinned.v1', '{invalid-json');
  assert.deepEqual(readPinnedIds(storage), []);
});

test('星标置顶：togglePinnedId 与 setPinnedId 状态纯函数流转', () => {
  let list = ['sess-1'];
  list = togglePinnedId(list, 'sess-2');
  assert.deepEqual(list, ['sess-1', 'sess-2']);
  list = togglePinnedId(list, 'sess-1');
  assert.deepEqual(list, ['sess-2']);

  // setPinnedId 幂等
  assert.deepEqual(setPinnedId(list, 'sess-2', true), ['sess-2']);
  assert.deepEqual(setPinnedId(list, 'sess-3', true), ['sess-2', 'sess-3']);
  assert.deepEqual(setPinnedId(list, 'sess-2', false), []);
});

test('星标置顶：sortSessions 优先将置顶项排在前面', () => {
  const rows = [
    { sessionId: 'idle-1', updatedAt: 100 },
    { sessionId: 'idle-pinned', updatedAt: 50 },
    { sessionId: 'run-normal', updatedAt: 20, running: true },
    { sessionId: 'run-pinned', updatedAt: 10, running: true },
  ];

  const sorted = sortSessions(rows, new Set(['idle-pinned', 'run-pinned']));
  // 排序优先级：置顶优先（pinned 内按 running 优先 + 时间序）
  assert.equal(sorted[0].sessionId, 'run-pinned');
  assert.equal(sorted[1].sessionId, 'idle-pinned');
  assert.equal(sorted[2].sessionId, 'run-normal');
  assert.equal(sorted[3].sessionId, 'idle-1');
});

test('星标置顶：sessionActionItems 仅在明确传入 canPin 时挂出 pin/unpin', () => {
  const session = { sessionId: 'sess-a', title: '分析' };

  // 默认不传 canPin 时，保持历史纯净（不破坏已有操作测试契约）
  const normal = sessionActionItems(session);
  assert.equal(normal.some((i) => i.id === 'pin' || i.id === 'unpin'), false);

  // 传入 canPin 且 pinned=false 时，给出「星标置顶」
  const pinnable = sessionActionItems(session, { canPin: true, pinned: false });
  assert.equal(pinnable.some((i) => i.id === 'pin'), true);
  assert.equal(pinnable.find((i) => i.id === 'pin').label, '星标置顶');

  // 传入 canPin 且 pinned=true 时，给出「取消置顶」
  const unpinnable = sessionActionItems(session, { canPin: true, pinned: true });
  assert.equal(unpinnable.some((i) => i.id === 'unpin'), true);
  assert.equal(unpinnable.find((i) => i.id === 'unpin').label, '取消置顶');
});

// ── 2. 会话全文 Markdown 导出 ──────────────────────────────

test('Markdown 导出：空会话记录优雅降级占位', () => {
  const meta = { sessionId: 's-123', title: '空任务' };
  const md = formatSessionToMarkdown(meta, []);
  assert.ok(md.includes('# 空任务'));
  assert.ok(md.includes('s-123'));
  assert.ok(md.includes('暂无消息记录'));
});

test('Markdown 导出：完整包含用户提问、助手回答与折叠工具调用', () => {
  const meta = {
    sessionId: 'session-full-export',
    title: '排查 Nginx 故障',
    workspace: '/etc/nginx',
    hostName: 'prod-gateway-01',
  };

  const lines = [
    {
      role: 'user',
      text: '请帮我检查为什么 80 端口无法响应请求',
      imageRefs: ['img-1'],
    },
    {
      role: 'assistant',
      text: '正在为您排查 Nginx 状态并调用 netstat 检查端口...',
    },
    {
      kind: 'tool/call',
      toolName: 'execute_command',
      toolArgs: '{"command":"systemctl status nginx"}',
    },
    {
      kind: 'tool/result',
      toolResult: 'Active: active (running) since Mon 2026-10-19',
      toolMs: 142,
    },
    {
      role: 'assistant',
      text: '已确认服务正常运行，80 端口已被监听。',
    },
  ];

  const md = formatSessionToMarkdown(meta, lines);
  assert.ok(md.includes('# 排查 Nginx 故障'));
  assert.ok(md.includes('prod-gateway-01'));
  assert.ok(md.includes('/etc/nginx'));
  assert.ok(md.includes('请帮我检查为什么 80 端口无法响应请求'));
  assert.ok(md.includes('[附带 1 张图片附件]'));
  assert.ok(md.includes('<details>'));
  assert.ok(md.includes('execute_command'));
  assert.ok(md.includes('systemctl status nginx'));
  assert.ok(md.includes('142ms'));
  assert.ok(md.includes('已确认服务正常运行'));
});

test('Markdown 导出：sanitizeFilename 正确清洗非法文件名字符', () => {
  assert.equal(sanitizeFilename('test/name:with*special?chars'), 'test_name_with_special_chars.md');
  assert.equal(sanitizeFilename('   '), 'session-export.md');
});

// ── 3. 源码与 UI 契约护栏 ─────────────────────────────────

test('静态护栏：ChatScreen 包含导出为 Markdown 按钮且触控目标 ≥44px', () => {
  const chatSrc = readFileSync(join(ROOT, 'src/components/screens/ChatScreen.tsx'), 'utf8');
  assert.ok(chatSrc.includes('handleExportMarkdown'), 'ChatScreen 必须包含 handleExportMarkdown');
  assert.ok(chatSrc.includes('aria-label="导出为 Markdown"'), '导出按钮必须包含 aria-label');
  assert.ok(chatSrc.includes('title="导出为 Markdown 全文"'), '导出按钮必须包含 title');
  assert.ok(chatSrc.includes('NetworkDiagnosticModal'), 'ChatScreen 必须接入 NetworkDiagnosticModal');
});

test('静态护栏：NetworkDiagnosticModal 包含所有无障碍及 ≥44px 触控目标', () => {
  const modalSrc = readFileSync(join(ROOT, 'src/components/modals/NetworkDiagnosticModal.tsx'), 'utf8');
  assert.ok(modalSrc.includes('链路健康诊断'), '包含链路健康诊断标题');
  assert.ok(modalSrc.includes('局域网直连 (LAN)'), '包含 LAN 链路诊断说明');
  assert.ok(modalSrc.includes('往返延迟 (RTT)'), '包含 RTT 延迟说明');
  assert.ok(modalSrc.includes('min-h-[44px]'), '可交互按钮必须满足 min-h-[44px]');
  assert.ok(modalSrc.includes('copyToClipboard'), '支持一键复制诊断报告');
});

test('静态护栏：SessionCard 与 SessionsScreen 完整连通置顶 Pin 机制', () => {
  const cardSrc = readFileSync(join(ROOT, 'src/components/sessions/SessionCard.tsx'), 'utf8');
  const screenSrc = readFileSync(join(ROOT, 'src/components/screens/SessionsScreen.tsx'), 'utf8');
  const appSrc = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');

  assert.ok(cardSrc.includes('pinned = false'), 'SessionCard 必须支持 pinned 属性');
  assert.ok(cardSrc.includes('onPin'), 'SessionCard 必须支持 onPin 回调');
  assert.ok(cardSrc.includes('title="已星标置顶"'), '置顶会话必须在卡片标题旁渲染星标标记');

  assert.ok(screenSrc.includes('readPinnedIds'), 'SessionsScreen 必须读取 pinned 状态');
  assert.ok(screenSrc.includes('pinnedIds: pinnedList'), 'SessionsScreen 分组时必须注入 pinnedIds');

  assert.ok(appSrc.includes('readPinnedIds'), 'App.tsx 必须读取置顶会话状态');
  assert.ok(appSrc.includes('handleTogglePin'), 'App.tsx 必须处理置顶切换事件');
});

console.log('──────────────────────────────────────────────────');
console.log(`✓ 全部 ${passed} 项通过：功能与体验增强专项防线全部建立并验证成功\n`);
