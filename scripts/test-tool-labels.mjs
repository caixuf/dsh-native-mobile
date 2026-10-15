/**
 * 工具名 → 人话 的单元测试。
 *
 *   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs scripts/test-tool-labels.mjs
 */
import { describeTool, toolActionLabel, toolKind } from '../src/lib/tool-labels.ts';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n      expected: ${b}\n      actual:   ${a}`);
}

console.log('\n  工具名 → 人话 单元测试');
console.log('  ──────────────────────────────────────────────────');

check('DSH 真实工具名不再显示英文原名（这正是旧实现的缺陷）', () => {
  // 旧 getFriendlyName 只认 run_command/read_file/…，这些新名字全落到 default
  eq(toolActionLabel('pwsh', 'done'), '执行了命令');
  eq(toolActionLabel('pwsh', 'running'), '执行命令');
  eq(toolActionLabel('read', 'running'), '读取文件');
  eq(toolActionLabel('edit', 'running'), '修改文件');
  eq(toolActionLabel('write', 'running'), '写入文件');
  eq(toolActionLabel('grep', 'running'), '搜索代码');
  eq(toolActionLabel('glob', 'running'), '浏览目录');
  eq(toolActionLabel('read_image', 'running'), '查看图片');
});

check('网络类措辞对齐 GUI：深度搜索中 / 抓取网页', () => {
  eq(toolActionLabel('web_search', 'running'), '深度搜索');
  eq(toolActionLabel('web_search', 'done'), '深度搜索');
  eq(toolActionLabel('web_fetch', 'running'), '抓取网页');
});

check('多智能体族', () => {
  eq(toolActionLabel('spawn_teammate', 'running'), '创建队友');
  eq(toolActionLabel('subagent', 'running'), '派子智能体');
  eq(toolActionLabel('workflow', 'running'), '编排子智能体');
  eq(toolActionLabel('send_message', 'running'), '发消息');
  eq(toolActionLabel('todo_write', 'running'), '更新任务板');
  eq(toolActionLabel('team_task_create', 'running'), '更新任务板', '前缀兜底');
  eq(toolActionLabel('job_output', 'running'), '查看后台任务');
});

check('记忆 / 运行时族按读写分派', () => {
  eq(toolActionLabel('mnemon_recall', 'running'), '读取记忆');
  eq(toolActionLabel('mnemon_document_search', 'running'), '检索记忆');
  eq(toolActionLabel('mnemon_remember', 'running'), '写入记忆');
  eq(toolActionLabel('mnemon_document_manage', 'running'), '写入记忆', '精确/特化规则必须优先于"其余 mnemon_ 一律写入"的族兜底');
  eq(toolActionLabel('cordis_inspect_list', 'running'), '检查运行时');
  eq(toolActionLabel('plugin_manager', 'running'), '管理插件');
  eq(toolActionLabel('skill', 'running'), '加载技能');
});

check('浏览器族（bcdp_*）细分到具体动作', () => {
  eq(toolActionLabel('bcdp_web_search', 'running'), '深度搜索');
  eq(toolActionLabel('bcdp_click', 'running'), '操作网页');
  eq(toolActionLabel('bcdp_navigate', 'running'), '打开网页');
  eq(toolActionLabel('bcdp_snapshot', 'running'), '读取网页');
  eq(toolActionLabel('bcdp_captcha', 'running'), '操作浏览器', '未细分的落到族兜底');
});

check('交互类会明确"询问你"（用户知道自己被问了）', () => {
  eq(toolActionLabel('ask_user_question', 'running'), '询问你');
  eq(toolActionLabel('ask_user_question', 'done'), '询问了你');
});

check('未知工具优雅降级为"调用 X"，不显示空白也不报错', () => {
  eq(toolActionLabel('my_custom_plugin_tool', 'running'), '调用 my_custom_plugin_tool');
  eq(toolActionLabel('my_custom_plugin_tool', 'done'), '调用了 my_custom_plugin_tool');
  eq(toolKind('my_custom_plugin_tool'), 'generic');
});

check('空/异常输入不炸', () => {
  eq(toolActionLabel(null, 'running'), '调用 工具');
  eq(toolActionLabel(undefined, 'done'), '调用了 工具');
  eq(toolActionLabel('', 'running'), '调用 工具');
  eq(toolActionLabel('   ', 'running'), '调用 工具');
  eq(describeTool(null).kind, 'generic');
});

check('旧 Kotlin 工具名仍然认（向后兼容，不回归历史会话）', () => {
  eq(toolActionLabel('run_command', 'done'), '执行了命令');
  eq(toolActionLabel('read_file', 'running'), '读取文件');
  eq(toolActionLabel('edit_file', 'running'), '修改文件');
  eq(toolActionLabel('write_file', 'running'), '写入文件');
  eq(toolActionLabel('list_dir', 'running'), '浏览目录');
});

check('图标类别可用于 UI（不再各组件各写 switch）', () => {
  eq(toolKind('pwsh'), 'shell');
  eq(toolKind('read'), 'file');
  eq(toolKind('grep'), 'search');
  eq(toolKind('web_search'), 'web');
  eq(toolKind('subagent'), 'team');
  eq(toolKind('mnemon_remember'), 'memory');
  eq(toolKind('plugin_manager'), 'runtime');
  eq(toolKind('ask_user_question'), 'ui');
});

check('运行中/已完成两种措辞都不为空', () => {
  const names = ['pwsh', 'read', 'edit', 'write', 'grep', 'glob', 'web_search', 'web_fetch',
    'spawn_teammate', 'subagent', 'workflow', 'todo_write', 'mnemon_remember', 'cordis_inspect_list',
    'bcdp_click', 'ask_user_question', 'skill', 'plugin_manager', 'job_output', 'present',
    'read_image', 'create_goal', 'whatever_new_tool'];
  for (const n of names) {
    const r = toolActionLabel(n, 'running');
    const d = toolActionLabel(n, 'done');
    if (!r || !d) throw new Error(`${n} 的措辞为空`);
    if (r === n || d === n) throw new Error(`${n} 直接把工具名当措辞了（等于没映射）`);
  }
});

console.log('  ──────────────────────────────────────────────────');
console.log(`  ${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);