/**
 * 工具名 → 人话。
 *
 * 🔴 旧实现的 `getFriendlyName()` 只认 **旧 Kotlin App** 的工具名
 * （`run_command` / `read_file` / `edit_file` / `write_file` / `list_dir`），
 * 而 DSH 现在的工具叫 `pwsh` / `read` / `edit` / `web_search` / `spawn_teammate`…
 * → 全部落到 default 分支，**每张工具卡都只显示原始英文工具名**，
 * 过程条也只会说"正在调用 pwsh"，读起来像日志而不是人话。
 *
 * 这里按 DSH 真实工具集建表；**未知工具必须优雅降级**成"调用 <原名>"
 * （用户自己装的插件工具随时会新增，不能因此显示成空白或报错）。
 *
 * 措辞对齐 GUI：运行中「深度搜索中」/ 完成后「执行了命令」。
 */

export type ToolKind = 'shell' | 'file' | 'search' | 'web' | 'team' | 'memory' | 'runtime' | 'ui' | 'generic';

export interface ToolDescription {
  kind: ToolKind;
  /** 运行中的说法，如「执行命令」。 */
  running: string;
  /** 完成后的说法，如「执行了命令」。 */
  done: string;
}

/** 全名精确匹配（顺序即优先级，先特化后泛化）。 */
const EXACT: Record<string, ToolDescription> = {
  // ── 命令行 ──
  pwsh: { kind: 'shell', running: '执行命令', done: '执行了命令' },
  bash: { kind: 'shell', running: '执行命令', done: '执行了命令' },
  terminal: { kind: 'shell', running: '执行命令', done: '执行了命令' },
  run_command: { kind: 'shell', running: '执行命令', done: '执行了命令' },
  wsl: { kind: 'shell', running: '执行命令', done: '执行了命令' },
  'wsl-path': { kind: 'shell', running: '转换路径', done: '转换了路径' },

  // ── 文件 ──
  read: { kind: 'file', running: '读取文件', done: '读取了文件' },
  read_file: { kind: 'file', running: '读取文件', done: '读取了文件' },
  read_image: { kind: 'file', running: '查看图片', done: '查看了图片' },
  write: { kind: 'file', running: '写入文件', done: '写入了文件' },
  write_file: { kind: 'file', running: '写入文件', done: '写入了文件' },
  edit: { kind: 'file', running: '修改文件', done: '修改了文件' },
  edit_file: { kind: 'file', running: '修改文件', done: '修改了文件' },
  present: { kind: 'ui', running: '展示文件', done: '展示了文件' },

  // ── 查找 ──
  grep: { kind: 'search', running: '搜索代码', done: '搜索了代码' },
  glob: { kind: 'search', running: '浏览目录', done: '浏览了目录' },
  list_dir: { kind: 'search', running: '浏览目录', done: '浏览了目录' },

  // ── 网络 ──
  web_search: { kind: 'web', running: '深度搜索', done: '深度搜索' },
  web_fetch: { kind: 'web', running: '抓取网页', done: '抓取了网页' },

  // ── 多智能体 ──
  spawn_teammate: { kind: 'team', running: '创建队友', done: '创建了队友' },
  subagent: { kind: 'team', running: '派子智能体', done: '派了子智能体' },
  subagent_fork: { kind: 'team', running: '派子智能体', done: '派了子智能体' },
  workflow: { kind: 'team', running: '编排子智能体', done: '编排了子智能体' },
  send_message: { kind: 'team', running: '发消息', done: '发了消息' },
  list_agents: { kind: 'team', running: '查看队友', done: '查看了队友' },
  interrupt_agent: { kind: 'team', running: '打断队友', done: '打断了队友' },
  todo_write: { kind: 'team', running: '更新任务板', done: '更新了任务板' },

  // ── 环境 / 运行时 ──
  skill: { kind: 'runtime', running: '加载技能', done: '加载了技能' },
  plugin_manager: { kind: 'runtime', running: '管理插件', done: '管理了插件' },
  load_workspace_dependencies: { kind: 'runtime', running: '检查依赖', done: '检查了依赖' },
  cordis_inspect_list: { kind: 'runtime', running: '检查运行时', done: '检查了运行时' },
  cordis_inspect_query: { kind: 'runtime', running: '查询运行时', done: '查询了运行时' },

  // ── 目标 / 记忆 ──
  create_goal: { kind: 'memory', running: '建立目标', done: '建立了目标' },
  update_goal: { kind: 'memory', running: '更新目标', done: '更新了目标' },
  get_goal: { kind: 'memory', running: '查看目标', done: '查看了目标' },
  mnemon_recall: { kind: 'memory', running: '读取记忆', done: '读取了记忆' },
  mnemon_remember: { kind: 'memory', running: '写入记忆', done: '写入了记忆' },
  mnemon_runtime_memory: { kind: 'memory', running: '写入记忆', done: '写入了记忆' },
  mnemon_document_search: { kind: 'memory', running: '检索记忆', done: '检索了记忆' },
  mnemon_related: { kind: 'memory', running: '追溯记忆', done: '追溯了记忆' },

  // ── 交互 ──
  ask_user_question: { kind: 'ui', running: '询问你', done: '询问了你' },
  exit_plan_mode: { kind: 'ui', running: '提交计划', done: '提交了计划' },
};

/** 前缀兜底（插件/浏览器/记忆等命名族）。 */
const PREFIX: Array<[RegExp, ToolDescription]> = [
  [/^bcdp_(web_search|jev_run|jev_attempt)$/, { kind: 'web', running: '深度搜索', done: '深度搜索' }],
  [/^bcdp_(click|check|drag|fill|select|upload|download|key|hover)$/, { kind: 'web', running: '操作网页', done: '操作了网页' }],
  [/^bcdp_navigate$/, { kind: 'web', running: '打开网页', done: '打开了网页' }],
  [/^bcdp_(read_element|snapshot|js|cli|cli2|wait|wait_for.*|wait_for_url|page_info)$/, { kind: 'web', running: '读取网页', done: '读取了网页' }],
  [/^bcdp_/, { kind: 'web', running: '操作浏览器', done: '操作了浏览器' }],
  [/^cordis_inspect_/, { kind: 'runtime', running: '检查运行时', done: '检查了运行时' }],
  [/^mnemon_document_manage$/, { kind: 'memory', running: '写入记忆', done: '写入了记忆' }],
  [/^mnemon_document_create$/, { kind: 'memory', running: '写入记忆', done: '写入了记忆' }],
  [/^mnemon_(recall|related|status|memory_bodies|document_search)$/, { kind: 'memory', running: '读取记忆', done: '读取了记忆' }],
  [/^mnemon_/, { kind: 'memory', running: '写入记忆', done: '写入了记忆' }],
  [/^team_task_/, { kind: 'team', running: '更新任务板', done: '更新了任务板' }],
  [/^job_/, { kind: 'shell', running: '查看后台任务', done: '查看了后台任务' }],
  [/^wsl/, { kind: 'shell', running: '执行命令', done: '执行了命令' }],
  [/^subagent/, { kind: 'team', running: '派子智能体', done: '派了子智能体' }],
];

/** 查一个工具的语义描述；未知工具优雅降级，绝不返回空。 */
export function describeTool(name: string | null | undefined): ToolDescription {
  const raw = (name || '').trim();
  const exact = EXACT[raw];
  if (exact) return exact;
  for (const [pattern, desc] of PREFIX) {
    if (pattern.test(raw)) return desc;
  }
  return { kind: 'generic', running: `调用 ${raw || '工具'}`, done: `调用了 ${raw || '工具'}` };
}

/**
 * 过程条 / 工具卡标题用的人话。
 *
 * @param mode `running` = 正在做（GUI 的「深度搜索中」），`done` = 已完成（「执行了命令」）
 */
export function toolActionLabel(name: string | null | undefined, mode: 'running' | 'done' = 'running'): string {
  const desc = describeTool(name);
  return mode === 'done' ? desc.done : desc.running;
}

/** 图标类别（UI 层据此挑图标，避免每个组件各写一套 switch）。 */
export function toolKind(name: string | null | undefined): ToolKind {
  return describeTool(name).kind;
}
