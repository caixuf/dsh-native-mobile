/**
 * 会话列表的**纯函数层**：按工作区分组 / 折叠状态 / 本机归档 / 时间格式化。
 *
 * 为什么单独抽出来（2026-10-14）：
 *  - 用户抱怨「会话全部列出来，给人翻累死了」，所以列表要变成
 *    工作区分组 + 可折叠 + 归档。这些全是**可判定的数据变换**，
 *    放进组件里就变成不可测的 render 副作用；
 *  - 会话多时分组必须 O(n)，不能每次 render 重算 O(n²)；
 *  - 本模块**零运行时依赖**（只有一句被完全擦除的 `import type`），
 *    因此测试不需要 `ts-resolve-hook`：
 *      node --experimental-strip-types scripts/test-session-groups.mjs
 *
 * 归档是**仅本机**的：真主机的 session 端点没有 archive
 * （session/cancel|control|create|follow|fork|initializeDefaultModel|list|
 *   modelCatalog|openWorkspacePath|page|projections|prompt|rename|search|
 *   selectModel|updateQueue|workspacePathApplications）。
 * 所以 UI 必须如实写「仅本机归档」，绝不能暗示它会同步回电脑。
 */

import type { SessionRow } from '../types';

/** 折叠状态持久化 key（自带版本号：v1 的语义变了就换 v2，旧数据自然作废）。 */
export const COLLAPSE_STORAGE_KEY = 'dsh.sessions.collapsed.v1';
/** 本机归档 id 列表持久化 key。 */
export const ARCHIVE_STORAGE_KEY = 'dsh.sessions.archived.v1';

/** 没有 workspace 的会话统一归到这一组。 */
export const UNKNOWN_WORKSPACE_KEY = '::unknown-workspace::';
export const UNKNOWN_WORKSPACE_LABEL = '未知工作区';
/** 远端搜索结果单独一组。 */
export const SEARCH_GROUP_KEY = '::search-results::';
export const SEARCH_GROUP_LABEL = '搜索结果';

/** 归档区必须展示的免责说明（真主机没有 archive 端点）。 */
export const ARCHIVE_NOTE = '仅本机归档 · 主机无 archive 接口，不会同步回电脑';

/** localStorage 的最小依赖面，方便测试注入假实现。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 工作区识别结果。 */
export interface WorkspaceInfo {
  /** 分组 key（已归一化的路径；空 cwd 用 UNKNOWN_WORKSPACE_KEY）。 */
  key: string;
  /** 人看的短名字（路径 basename；WSL 路径取真实目录名）。 */
  label: string;
  /** 辅助说明（父目录 / `WSL · Ubuntu`）；可能为空串。 */
  hint: string;
  /** 归一化后的原始路径；空 cwd 为 null。 */
  workspace: string | null;
}

export interface SessionGroup extends WorkspaceInfo {
  kind: 'workspace' | 'search';
  /** 主会话（已排序）。 */
  sessions: SessionRow[];
  /** 子代理会话（已排序），UI 里默认折叠成「子代理 (N)」子节。 */
  subagents: SessionRow[];
  /** sessions + subagents 数量。 */
  total: number;
  /** 组内 running 会话数（含子代理）。 */
  runningCount: number;
  /** 组内最近活动时间，用于组间排序与「默认展开最新的组」。 */
  latestAt: number;
  /** 仅搜索组有意义：与本地列表重复、因此未展示的远端结果数。 */
  hiddenDuplicateCount: number;
}

export interface GroupSessionsOptions {
  /** 已归档 id（本机归档），这些会话从工作区组里剔除。 */
  archivedIds?: ReadonlySet<string> | readonly string[] | null;
  /** 远端 session.search 返回的原始结果（可选）。 */
  searchResults?: readonly SessionRow[] | null;
  /** 当前搜索词；为空串时不生成「搜索结果」组。 */
  searchQuery?: string | null;
}

export interface SessionGrouping {
  /** 展示顺序：搜索结果组在最前，其余按 latestAt 倒序。 */
  groups: SessionGroup[];
  /** 已归档会话（按 running/时间排序）。 */
  archived: SessionRow[];
  archivedCount: number;
  /** 因归档而从工作区组隐藏的会话数。 */
  hiddenCount: number;
  /** 未归档、实际展示的会话数（含子代理）。 */
  visibleCount: number;
  runningCount: number;
  /** 工作区组数量（不含搜索组）。 */
  workspaceCount: number;
  /** 远端结果里与本地重复的条数。 */
  searchDuplicateCount: number;
}

/** key → 是否折叠。 */
export type CollapseState = Record<string, boolean>;

// ── 工作区识别 ──────────────────────────────────────────────────────────────

const WSL_UNC_RE = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(?:\/(.*))?$/i;
const DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;

/**
 * 归一化工作区路径：统一分隔符、去掉尾部斜杠、折叠重复斜杠。
 * 目的是让 `C:\a\b`、`C:/a/b/`、`\\wsl$\U\a\b` 这类写法落到同一个 key。
 */
export function normalizeWorkspace(workspace: string | null | undefined): string | null {
  if (workspace == null) return null;
  const raw = String(workspace).trim();
  if (!raw) return null;

  let path = raw.replace(/\\/g, '/');
  const isUnc = path.startsWith('//');
  path = path.replace(/\/{2,}/g, '/');
  if (isUnc && !path.startsWith('//')) path = `/${path}`;
  if (path.length > 1 && !DRIVE_ROOT_RE.test(path)) path = path.replace(/\/+$/, '');
  return path || null;
}

function basenameOf(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : path;
}

function parentHintOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '';
  return trimmed.slice(0, idx);
}

/** 把任意 cwd 变成「分组 key + 友好名 + 辅助说明」。 */
export function describeWorkspace(workspace: string | null | undefined): WorkspaceInfo {
  const normalized = normalizeWorkspace(workspace);
  if (!normalized) {
    return {
      key: UNKNOWN_WORKSPACE_KEY,
      label: UNKNOWN_WORKSPACE_LABEL,
      hint: '',
      workspace: null,
    };
  }

  const wsl = WSL_UNC_RE.exec(normalized);
  if (wsl) {
    const distro = wsl[1];
    const rest = (wsl[2] || '').replace(/\/+$/, '');
    const segments = rest.split('/').filter(Boolean);
    return {
      key: normalized,
      label: segments.length ? segments[segments.length - 1] : distro,
      hint: `WSL · ${distro}`,
      workspace: normalized,
    };
  }

  return {
    key: normalized,
    label: basenameOf(normalized),
    hint: parentHintOf(normalized),
    workspace: normalized,
  };
}

// ── 排序 ────────────────────────────────────────────────────────────────────

function timeOf(row: SessionRow): number {
  return typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0;
}

function idOf(row: SessionRow): string {
  return typeof row.sessionId === 'string' ? row.sessionId : '';
}

/**
 * 组内排序：**运行中排前**（带呼吸点，用户最关心），其次 updatedAt 倒序，
 * 最后用 sessionId 升序兜底，保证同一份输入永远得到同一份输出。
 */
export function compareSessions(a: SessionRow, b: SessionRow): number {
  const ar = !!a.running;
  const br = !!b.running;
  if (ar !== br) return ar ? -1 : 1;
  const at = timeOf(a);
  const bt = timeOf(b);
  if (at !== bt) return bt - at;
  const ai = idOf(a);
  const bi = idOf(b);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/** 不就地修改输入（render 期间绝不允许改 props 数组）。 */
export function sortSessions<T extends SessionRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareSessions);
}

// ── 归档 id 集合 ────────────────────────────────────────────────────────────

const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

export function toIdSet(
  ids: ReadonlySet<string> | readonly string[] | null | undefined,
): ReadonlySet<string> {
  if (!ids) return EMPTY_ID_SET;
  if (ids instanceof Set) return ids;
  const set = new Set<string>();
  for (const id of ids) if (typeof id === 'string' && id) set.add(id);
  return set;
}

// ── 分组 ────────────────────────────────────────────────────────────────────

/**
 * 把主会话 + 子代理会话按工作区分组，剔除归档项，合并远端搜索结果。
 * 复杂度：O(n) 分桶 + O(n log n) 组内排序，不会随 render 次数放大。
 */
export function groupSessions(
  sessions: readonly SessionRow[] | null | undefined,
  subagentSessions: readonly SessionRow[] | null | undefined,
  options: GroupSessionsOptions = {},
): SessionGrouping {
  const main = Array.isArray(sessions) ? sessions : [];
  const subs = Array.isArray(subagentSessions) ? subagentSessions : [];
  const archivedSet = toIdSet(options.archivedIds);

  const buckets = new Map<string, SessionGroup>();
  const archived: SessionRow[] = [];
  let hiddenCount = 0;
  let visibleCount = 0;
  let runningCount = 0;

  const accept = (row: SessionRow | null | undefined, isSubagent: boolean) => {
    if (!row || typeof row.sessionId !== 'string' || !row.sessionId) return;
    if (archivedSet.has(row.sessionId)) {
      archived.push(row);
      hiddenCount += 1;
      return;
    }

    const info = describeWorkspace(row.workspace);
    let group = buckets.get(info.key);
    if (!group) {
      group = {
        ...info,
        kind: 'workspace',
        sessions: [],
        subagents: [],
        total: 0,
        runningCount: 0,
        latestAt: 0,
        hiddenDuplicateCount: 0,
      };
      buckets.set(info.key, group);
    }

    if (isSubagent) group.subagents.push(row);
    else group.sessions.push(row);

    const at = timeOf(row);
    if (at > group.latestAt) group.latestAt = at;
    if (row.running) {
      group.runningCount += 1;
      runningCount += 1;
    }
    visibleCount += 1;
  };

  for (const row of main) accept(row, false);
  for (const row of subs) accept(row, true);

  const localIds = new Set<string>();
  for (const group of buckets.values()) {
    group.sessions = sortSessions(group.sessions);
    group.subagents = sortSessions(group.subagents);
    group.total = group.sessions.length + group.subagents.length;
    for (const row of group.sessions) localIds.add(row.sessionId);
    for (const row of group.subagents) localIds.add(row.sessionId);
  }

  const workspaceGroups = [...buckets.values()].sort((a, b) => {
    if (a.latestAt !== b.latestAt) return b.latestAt - a.latestAt;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  // ── 远端搜索结果合并 ──
  const query = typeof options.searchQuery === 'string' ? options.searchQuery.trim() : '';
  const remote = Array.isArray(options.searchResults) ? options.searchResults : [];
  let searchGroup: SessionGroup | null = null;
  let searchDuplicateCount = 0;

  if (query && remote.length) {
    const seen = new Set<string>();
    const unique: SessionRow[] = [];
    let runningRemote = 0;
    let latestRemote = 0;
    for (const row of remote) {
      if (!row || typeof row.sessionId !== 'string' || !row.sessionId) continue;
      if (localIds.has(row.sessionId) || seen.has(row.sessionId)) {
        searchDuplicateCount += 1;
        continue;
      }
      seen.add(row.sessionId);
      unique.push(row);
      if (row.running) runningRemote += 1;
      const at = timeOf(row);
      if (at > latestRemote) latestRemote = at;
    }

    if (unique.length) {
      const sorted = sortSessions(unique);
      searchGroup = {
        key: SEARCH_GROUP_KEY,
        label: SEARCH_GROUP_LABEL,
        hint: `“${query}”`,
        workspace: null,
        kind: 'search',
        sessions: sorted,
        subagents: [],
        total: sorted.length,
        runningCount: runningRemote,
        latestAt: latestRemote,
        hiddenDuplicateCount: searchDuplicateCount,
      };
    }
  }

  return {
    groups: searchGroup ? [searchGroup, ...workspaceGroups] : workspaceGroups,
    archived: sortSessions(archived),
    archivedCount: archived.length,
    hiddenCount,
    visibleCount,
    runningCount,
    workspaceCount: workspaceGroups.length,
    searchDuplicateCount,
  };
}

// ── 折叠状态 ────────────────────────────────────────────────────────────────

/** 组内「子代理 (N)」子节的折叠 key 后缀。 */
export const SUBAGENT_SECTION_SUFFIX = '::subagents';

/** 子代理子节的折叠 key（与工作区组的 key 共用同一份状态）。 */
export function subagentSectionKey(groupKey: string): string {
  return `${groupKey}${SUBAGENT_SECTION_SUFFIX}`;
}

/**
 * 默认折叠：**只展开含最新会话的那个工作区组**，其余折叠
 * （这正是「翻累死了」的解药）。搜索组永远展开，因为它是当前动作的上下文；
 * 子代理子节默认折叠，主会话列表才是用户第一眼要看的。
 */
export function defaultCollapsedState(groups: readonly SessionGroup[]): CollapseState {
  let newestKey: string | null = null;
  let newestAt = -Infinity;
  for (const group of groups) {
    if (group.kind !== 'workspace') continue;
    if (group.latestAt > newestAt) {
      newestAt = group.latestAt;
      newestKey = group.key;
    }
  }

  const state: CollapseState = {};
  for (const group of groups) {
    state[group.key] = group.kind === 'workspace' && group.key !== newestKey;
    if (group.subagents.length > 0) state[subagentSectionKey(group.key)] = true;
  }
  return state;
}

/** 持久化的显式选择优先，未记录的组回落到默认值。 */
export function resolveCollapseState(
  groups: readonly SessionGroup[],
  stored: CollapseState | null | undefined,
): CollapseState {
  const fallback = defaultCollapsedState(groups);
  const resolved: CollapseState = {};
  const keys = new Set<string>();
  for (const group of groups) {
    keys.add(group.key);
    if (group.subagents.length > 0) keys.add(subagentSectionKey(group.key));
  }
  for (const key of keys) {
    const explicit = stored ? stored[key] : undefined;
    resolved[key] = typeof explicit === 'boolean' ? explicit : fallback[key] === true;
  }
  return resolved;
}

function parseStored(storage: StorageLike | null | undefined, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 读折叠状态；坏 JSON / 空值 / 非对象一律当「没有记录」，绝不抛异常。 */
export function readCollapseState(
  storage: StorageLike | null | undefined,
  key: string = COLLAPSE_STORAGE_KEY,
): CollapseState {
  const parsed = parseStored(storage, key);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const state: CollapseState = {};
  for (const [groupKey, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'boolean') state[groupKey] = value;
  }
  return state;
}

/** 写折叠状态；配额满 / 隐私模式抛错时静默失败（返回 false）。 */
export function writeCollapseState(
  state: CollapseState,
  storage: StorageLike | null | undefined,
  key: string = COLLAPSE_STORAGE_KEY,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

// ── 本机归档 ────────────────────────────────────────────────────────────────

/** 读归档 id：过滤非字符串/空串并去重。 */
export function readArchivedIds(
  storage: StorageLike | null | undefined,
  key: string = ARCHIVE_STORAGE_KEY,
): string[] {
  const parsed = parseStored(storage, key);
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of parsed) {
    if (typeof value === 'string' && value && !seen.has(value)) {
      seen.add(value);
      ids.push(value);
    }
  }
  return ids;
}

export function writeArchivedIds(
  ids: readonly string[],
  storage: StorageLike | null | undefined,
  key: string = ARCHIVE_STORAGE_KEY,
): boolean {
  if (!storage) return false;
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const id of ids) {
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id);
      clean.push(id);
    }
  }
  try {
    storage.setItem(key, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

/** 归档 / 取消归档一个 id（幂等：来回切换不会产生重复项）。 */
export function toggleArchivedId(ids: readonly string[], id: string): string[] {
  if (!id) return [...ids];
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** 显式设置某个会话的归档态。 */
export function setArchivedId(ids: readonly string[], id: string, archived: boolean): string[] {
  if (!id) return [...ids];
  const has = ids.includes(id);
  if (archived) return has ? [...ids] : [...ids, id];
  return has ? ids.filter((x) => x !== id) : [...ids];
}

// ── 时间显示 ────────────────────────────────────────────────────────────────

/**
 * 相对时间。手写而不是 toLocaleDateString —— 后者输出随 Node/浏览器 locale 变，
 * 测试会飘。纯函数，now 可注入。
 */
export function formatSessionTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '';
  const diff = Math.floor((now - ts) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  const d = new Date(ts);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return sameYear ? `${month}月${day}日` : `${d.getFullYear()}年${month}月${day}日`;
}

/** 关键词本地过滤（标题 / 摘要 / 工作区），大小写不敏感；空词返回原数组引用。 */
export function filterSessionsByQuery<T extends SessionRow>(
  rows: readonly T[],
  query: string | null | undefined,
): T[] {
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!q) return [...rows];
  return rows.filter((row) => {
    const haystack = `${row.title || ''}\n${row.preview || ''}\n${row.workspace || ''}`.toLowerCase();
    return haystack.includes(q);
  });
}