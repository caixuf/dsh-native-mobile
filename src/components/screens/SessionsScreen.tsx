import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Menu, Search, X, RefreshCw, Plus, Monitor, Cpu, Sparkles, ChevronsDownUp, ChevronsUpDown, FolderOpen, ChevronDown } from 'lucide-react';
import { SessionRow, LinkState } from '../../types';
import { StatusPill } from '../common/StatusPill';
import { DeepSeekLogo } from '../common/DeepSeekLogo';
import { MiniMaxMascot } from '../common/MiniMaxMascot';
import { ConnectionDot } from '../common/ConnectionDot';
import { triggerHaptic } from '../../utils/haptics';
import { SessionGroupSection } from '../sessions/SessionGroupSection';
import { ArchivedSection } from '../sessions/ArchivedSection';
import {
  type CollapseState,
  type RenameEchoState,
  type StorageLike,
  applyRenameEcho,
  filterSessionsByQuery,
  groupSessions,
  listWorkspaceOptions,
  normalizeSessionTitle,
  readArchivedIds,
  readCollapseState,
  resolveCollapseState,
  setArchivedId,
  setRenameEcho,
  subagentSectionKey,
  writeArchivedIds,
  writeCollapseState,
} from '../../lib/session-groups';

/**
 * 会话列表：**按工作区分组 + 可折叠 + 组内限量 + 本机归档 + 会话管理**。
 *
 * 改造动机（用户原话）：「会话全部列出来，给人翻累死了，而且没有桌面的归档什么的，
 * 就像管理文件夹一样啊」。所以形态对齐 DSH 桌面侧边栏：顶层按工作区（cwd）分组，
 * 组可折叠，组内挂会话；子代理收进组内的「子代理 (N)」子节；归档项沉到底部。
 * T6 又补了两处真痛点：组内**一次全渲染**（真主机 desktop 组 41 条）→ 每组 12 条 +
 * 「显示更多」；以及真主机有 rename/fork 却没用上 → 卡片「⋯」/长按操作菜单。
 *
 * 分组 / 排序 / 折叠 / 归档 / 限量 / 菜单条目 / 工作区候选的**全部判定**都在
 * `src/lib/session-groups.ts`（纯函数、可测），本文件只负责：
 * 把 props 喂进去 → 渲染 → 把用户选择写回 localStorage。
 *
 * props 契约：
 *  - 已有 props 语义不变（linkState/sessions/…/onOpenDrawer）。
 *  - `archivedIds` 传入 = **受控**（组件不再自持该状态，由调用方回写）；
 *    不传 = 非受控，组件自己从 localStorage 读写。
 *  - `onArchive` / `onUnarchive` 是「用户点了归档/恢复」的通知回调（可选）。
 *  - `searchResults` 传入远端 session.search 的原始结果时，会在顶部单独成
 *    「搜索结果」组，并与本地列表去重；不传则只做本地即时过滤。
 *  - T6 新增（**全部可选**，不传则菜单里对应动作置灰）：
 *      `onRenameSession(session, title) => void | Promise<unknown>`
 *      `onForkSession(session)          => void | Promise<unknown>`
 *      `onCancelSession(session)        => void | Promise<unknown>`
 *    重命名成功后组件只叠一层**本地 echo**（行标题一变就自动失效），
 *    真正落库由调用方写回 sessions；失败（reject）会把错误显示在菜单里。
 */

/** 归档区自己的折叠 key（和分组共用一份持久化记录）。 */
const ARCHIVE_SECTION_KEY = '::archived-section::';

const ALL_EXPANDED = false;

/** 建会话时没有已知工作区可选的兜底路径（保持老行为）。 */
const FALLBACK_CWD = '~/Developer/workspaces/nexus-ecommerce';

interface Props {
  linkState: LinkState;
  sessions: SessionRow[];
  subagentSessions: SessionRow[];
  loading: boolean;
  onOpen: (session: SessionRow) => void;
  onRefresh: () => void;
  onSearch: (q: string) => void;
  onCreate: (cwd?: string) => void;
  /**
   * 建会话后的一次性提示。用来如实告诉用户两件他一定会困惑的事：
   * ① 会话建在哪个工作区；② 桌面版会隐藏"还没说过话"的空白会话，
   * 发出第一条消息后电脑端才看得见（桌面 `tree.ts:233-245` 按设计如此）。
   */
  createNotice?: { kind: 'info' | 'error'; text: string } | null;
  onDismissCreateNotice?: () => void;
  onOpenDrawer: () => void;
  /** 已归档会话 id（传入即受控：组件只通知，不回写内部状态）。 */
  archivedIds?: string[];
  onArchive?: (s: SessionRow) => void;
  onUnarchive?: (s: SessionRow) => void;
  /** 远端搜索结果（session.search 原始 items），单独成组。 */
  searchResults?: SessionRow[];
  /** T6：重命名（session.rename，args `{request:{sessionId,title}}`）。 */
  onRenameSession?: (session: SessionRow, title: string) => void | Promise<unknown>;
  /** T6：在电脑上分叉（session.fork，args `{request:{sessionId}}`）。 */
  onForkSession?: (session: SessionRow) => void | Promise<unknown>;
  /** T6：取消当前轮（session.cancel，args `{request:{sessionId}}`）。 */
  onCancelSession?: (session: SessionRow) => void | Promise<unknown>;
}

export const SessionsScreen: React.FC<Props> = ({
  linkState,
  sessions,
  subagentSessions,
  loading,
  onOpen,
  onRefresh,
  onSearch,
  onCreate,
  createNotice,
  onDismissCreateNotice,
  onOpenDrawer,
  archivedIds,
  onArchive,
  onUnarchive,
  searchResults,
  onRenameSession,
  onForkSession,
  onCancelSession,
}) => {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [workspaceSheetOpen, setWorkspaceSheetOpen] = useState(false);
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<string | null>(null);
  const [customCwd, setCustomCwd] = useState('');
  const [renameEcho, setRenameEchoState] = useState<RenameEchoState>({});

  // 先绑成 const：TS 只在 const 上保留「已判空」的收窄，闭包里直接读 props 会被还原。
  const renameSession = onRenameSession;
  const forkSession = onForkSession;
  const cancelSession = onCancelSession;

  // localStorage 在隐私模式 / SSR 下可能直接抛异常 —— 这里一次性兜住。
  const storage = useMemo<StorageLike | null>(() => {
    try {
      return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
      return null;
    }
  }, []);

  const [storedCollapse, setStoredCollapse] = useState<CollapseState>(() => readCollapseState(storage));
  const [internalArchived, setInternalArchived] = useState<string[]>(() => readArchivedIds(storage));

  const archiveControlled = Array.isArray(archivedIds);
  const archivedList = archiveControlled ? (archivedIds as string[]) : internalArchived;

  const persistCollapse = (next: CollapseState) => {
    setStoredCollapse(next);
    writeCollapseState(next, storage);
  };

  // ── 搜索：本地即时过滤 + 远端结果合并 ──
  const searchTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    },
    [],
  );

  const handleSearchChange = (value: string) => {
    setQuery(value);
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    if (!value.trim()) {
      onSearch('');
      return;
    }
    // 防抖：别每敲一个字就打一次主机的 session.search。
    searchTimer.current = window.setTimeout(() => onSearch(value), 250);
  };

  // ── 本地过滤（叠加重命名 echo：调用方还没回写时也能"就地"看到新标题）──
  const localMain = useMemo(
    () => applyRenameEcho(filterSessionsByQuery(sessions, query), renameEcho),
    [sessions, query, renameEcho],
  );
  const localSubagents = useMemo(
    () => applyRenameEcho(filterSessionsByQuery(subagentSessions, query), renameEcho),
    [subagentSessions, query, renameEcho],
  );

  // ── 分组（memo 化：会话多时绝不在每次 render 重算）──
  const grouping = useMemo(
    () =>
      groupSessions(localMain, localSubagents, {
        archivedIds: archivedList,
        searchResults,
        searchQuery: query,
      }),
    [localMain, localSubagents, archivedList, searchResults, query],
  );

  const collapsed = useMemo(
    () => resolveCollapseState(grouping.groups, storedCollapse),
    [grouping.groups, storedCollapse],
  );

  /**
   * 必须留在组内上限里的 id：搜索命中（本地过滤后剩下的就是命中）+ 远端结果。
   * running 项由 `capSessions` 自己兜，不必列进来。
   */
  const priorityIds = useMemo(() => {
    const set = new Set<string>();
    if (query.trim()) {
      for (const row of localMain) set.add(row.sessionId);
      for (const row of localSubagents) set.add(row.sessionId);
    }
    if (Array.isArray(searchResults)) {
      for (const row of searchResults) if (row && row.sessionId) set.add(row.sessionId);
    }
    return set;
  }, [query, localMain, localSubagents, searchResults]);

  /** 新建会话可选的工作区（来自已知分组，不让用户手打路径）。 */
  const workspaceChoices = useMemo(() => listWorkspaceOptions(grouping.groups), [grouping.groups]);

  /** 筛选后的展示分组（支持单个工作区专注视图） */
  const displayGroups = useMemo(() => {
    if (!selectedWorkspaceKey) return grouping.groups;
    const filtered = grouping.groups.filter((g) => g.kind === 'search' || g.key === selectedWorkspaceKey);
    return filtered.length > 0 ? filtered : grouping.groups;
  }, [grouping.groups, selectedWorkspaceKey]);

  const currentWorkspaceGroup = useMemo(() => {
    if (!selectedWorkspaceKey) return null;
    return grouping.groups.find((g) => g.key === selectedWorkspaceKey) || null;
  }, [grouping.groups, selectedWorkspaceKey]);

  const activeWorkspaceTitle = currentWorkspaceGroup
    ? currentWorkspaceGroup.label
    : (grouping.groups.length === 1 && grouping.groups[0]?.label)
      ? grouping.groups[0].label
      : '全部工作区';

  const archiveCollapsed = storedCollapse[ARCHIVE_SECTION_KEY] ?? true;
  const isCollapsed = (key: string) => collapsed[key] === true;

  const setSectionCollapsed = (key: string, value: boolean) => {
    persistCollapse({ ...storedCollapse, ...collapsed, [key]: value });
  };

  const toggleSection = (key: string) => {
    triggerHaptic('selection');
    setSectionCollapsed(key, !isCollapsed(key));
  };

  const setAllSections = (collapseAll: boolean) => {
    triggerHaptic('selection');
    const next: CollapseState = { ...storedCollapse };
    for (const group of grouping.groups) {
      // 搜索组是当前动作的上下文，永远保持展开
      next[group.key] = collapseAll ? group.kind === 'workspace' : ALL_EXPANDED;
      if (group.subagents.length > 0) next[subagentSectionKey(group.key)] = collapseAll;
    }
    next[ARCHIVE_SECTION_KEY] = collapseAll;
    persistCollapse(next);
  };

  // ── 归档（仅本机）──
  const applyArchive = (session: SessionRow, archived: boolean) => {
    const next = setArchivedId(archivedList, session.sessionId, archived);
    if (archiveControlled) {
      // 🔴 受控模式：**只通知，不落盘**。
      // 旧实现无条件 writeArchivedIds(...)，于是组件与调用方成了**两个写入方**：
      // 外部（比如清空 localStorage、或另一台设备的状态）被覆盖回组件内存里的旧值，
      // 表现为"删掉的归档 id 自己又回来了"（真机 E2E 实测到）。
      // 单一写入方是调用方的责任（App.tsx 的 applyArchive 会 setState + 落盘）。
      if (archived) onArchive?.(session);
      else onUnarchive?.(session);
      return;
    }
    setInternalArchived(next);
    writeArchivedIds(next, storage);
    if (archived) onArchive?.(session);
    else onUnarchive?.(session);
  };

  // ── 重命名：调调用方 → 成功后叠 echo（失败抛回菜单里显示）──
  const handleRenameSession = async (session: SessionRow, title: string) => {
    const clean = normalizeSessionTitle(title);
    if (!clean) throw new Error('标题不能为空');
    if (!renameSession) throw new Error('未接线 session.rename');
    await renameSession(session, clean);
    // from 取"用户当时看到的标题"；连续改名时 setRenameEcho 会保留最早的 from
    setRenameEchoState((prev) => setRenameEcho(prev, session.sessionId, session.title, clean));
  };

  const openCreateDialog = () => {
    triggerHaptic('light');
    // 组内已有的工作区优先填入，用户不用手打；一个都没有才退回老默认值。
    const fallback = workspaceChoices[0]?.workspace || FALLBACK_CWD;
    setCustomCwd((prev) => (prev.trim() ? prev : fallback));
    setCreateDialogOpen(true);
  };

  const hasContent = grouping.groups.length > 0 || grouping.archivedCount > 0;
  const showEmptyState = !hasContent && !loading;

  return (
    <div className="flex flex-col h-full bg-white text-[#18181b] select-none">
      {/* MiniMax Top Navigation Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-gray-100 px-4 py-3 transition-all">
        <div className="flex items-center justify-between max-w-2xl mx-auto w-full gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              onClick={() => {
                triggerHaptic('light');
                onOpenDrawer();
              }}
              type="button"
              aria-label="打开菜单"
              className="w-9 h-9 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-700 transition-colors cursor-pointer shrink-0"
            >
              <Menu size={18} />
            </button>
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-[17px] font-bold tracking-tight text-gray-900 whitespace-nowrap shrink-0">
                连接电脑
              </h1>
              <div className="min-w-0 shrink">
                <StatusPill linkState={linkState} onClick={onOpenDrawer} />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                triggerHaptic('selection');
                setSearchOpen(!searchOpen);
                if (searchOpen) handleSearchChange('');
              }}
              type="button"
              aria-label={searchOpen ? '关闭搜索' : '搜索会话'}
              className="w-9 h-9 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-600 hover:text-black transition-colors cursor-pointer"
            >
              {searchOpen ? <X size={17} /> : <Search size={17} />}
            </button>
            <button
              onClick={() => {
                triggerHaptic('light');
                onRefresh();
              }}
              type="button"
              aria-label="刷新会话列表"
              className="w-9 h-9 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-600 hover:text-black transition-colors cursor-pointer"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin text-blue-600' : ''} />
            </button>
          </div>
        </div>

        {/* MiniMax Light Search Bar */}
        {searchOpen && (
          <div className="mt-2.5 pt-2 border-t border-gray-100 max-w-2xl mx-auto w-full animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="relative flex items-center">
              <Search size={15} className="absolute left-3.5 text-[#52525b]" />
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="搜索会话标题、摘要或工作区…"
                aria-label="搜索会话"
                className="w-full pl-10 pr-3 py-2 text-[13px] bg-gray-100 border border-gray-200 rounded-xl focus:outline-hidden focus:border-gray-400 text-gray-900 placeholder:text-[#52525b] transition-all"
              />
            </div>
          </div>
        )}
      </header>

      {/* Main Sessions List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3.5 max-w-2xl w-full mx-auto pb-32">
        {createNotice && (
          <div
            data-testid="create-notice"
            className={`flex items-start gap-2.5 p-3 rounded-2xl border text-[12.5px] leading-relaxed ${
              createNotice.kind === 'error'
                ? 'bg-[#f43f5e]/10 border-[#f43f5e]/25 text-[#fda4af]'
                : 'bg-[#3b82f6]/10 border-[#3b82f6]/25 text-[#bfdbfe]'
            }`}
          >
            <Sparkles size={15} className="shrink-0 mt-0.5" />
            <span className="flex-1 min-w-0">{createNotice.text}</span>
            {onDismissCreateNotice && (
              <button
                type="button"
                onClick={onDismissCreateNotice}
                aria-label="关闭提示"
                className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-current/70 hover:text-[#18181b] hover:bg-black/[0.05] cursor-pointer studio-tap"
              >
                <X size={13} />
              </button>
            )}
          </div>
        )}

        {/* Screenshot 3 MiniMax Workspace Row */}
        <div className="flex items-center justify-between px-1 py-1">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setWorkspaceSheetOpen(true);
            }}
            className="flex items-center gap-1.5 text-[15px] font-bold text-gray-900 hover:text-black cursor-pointer group"
          >
            <FolderOpen size={17} className="text-gray-700 group-hover:text-black" />
            <span className="truncate max-w-[220px]">{activeWorkspaceTitle}</span>
            <ChevronDown size={14} className="text-[#52525b] group-hover:text-black" />
          </button>

          <button
            onClick={openCreateDialog}
            type="button"
            aria-label="在当前工作区新建会话"
            className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-700 transition-colors cursor-pointer"
          >
            <Plus size={16} />
          </button>
        </div>

        {/* 分组概览 + 全展开/全折叠 */}
        {hasContent && (
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="min-w-0 flex-1 text-[12px] text-[#52525b] whitespace-nowrap overflow-hidden text-ellipsis">
              {selectedWorkspaceKey && currentWorkspaceGroup ? (
                <>
                  已筛选：<span className="font-semibold text-gray-800">{currentWorkspaceGroup.label}</span> ·{' '}
                  <span className="font-semibold text-gray-800">{currentWorkspaceGroup.total}</span> 个会话
                  <button
                    type="button"
                    onClick={() => setSelectedWorkspaceKey(null)}
                    className="ml-2 text-blue-600 hover:underline cursor-pointer font-medium"
                  >
                    显示全部
                  </button>
                </>
              ) : (
                <>
                  <span className="font-semibold text-gray-800">{grouping.workspaceCount}</span> 个工作区 ·{' '}
                  <span className="font-semibold text-gray-800">{grouping.visibleCount}</span> 个会话
                  {grouping.runningCount > 0 && (
                    <span className="text-blue-600 font-medium"> · {grouping.runningCount} 个执行中</span>
                  )}
                  {grouping.archivedCount > 0 && (
                    <span className="text-[#52525b]"> · {grouping.archivedCount} 个已归档</span>
                  )}
                </>
              )}
            </p>
            {displayGroups.length > 1 && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setAllSections(false)}
                  title="展开全部"
                  aria-label="展开全部工作区"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-gray-100 hover:bg-gray-200 border border-gray-200/60 text-[11px] text-gray-600 hover:text-black transition-colors cursor-pointer"
                >
                  <ChevronsUpDown size={13} />
                  展开
                </button>
                <button
                  type="button"
                  onClick={() => setAllSections(true)}
                  title="折叠全部"
                  aria-label="折叠全部工作区"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-gray-100 hover:bg-gray-200 border border-gray-200/60 text-[11px] text-gray-600 hover:text-black transition-colors cursor-pointer"
                >
                  <ChevronsDownUp size={13} />
                  折叠
                </button>
              </div>
            )}
          </div>
        )}

        {/* Empty State matching MiniMax Screenshot 1 */}
        {showEmptyState && (
          <div className="flex flex-col items-center justify-center p-8 mt-12 text-center">
            <MiniMaxMascot size={110} />
            <h2 className="text-[22px] font-bold text-gray-900 mt-4 tracking-tight">
              有什么可以帮忙的
            </h2>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 mt-3 rounded-full bg-[#f4f4f6] text-[12px] font-medium text-gray-600 border border-gray-200/60 shadow-2xs">
              <Monitor size={13} className="text-[#52525b]" />
              <span>{linkState.hostName || 'caixuf'}</span>
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            </div>

            <div className="w-full max-w-sm mt-8 space-y-2">
              <button
                type="button"
                onClick={openCreateDialog}
                className="w-full py-3.5 px-5 rounded-2xl bg-[#f4f4f6] hover:bg-[#eaeaea] text-left text-[14px] text-gray-800 font-medium flex items-center justify-between transition-colors shadow-2xs cursor-pointer"
              >
                <span>新建遥控会话开始聊天</span>
                <Plus size={16} className="text-[#52525b]" />
              </button>
            </div>
          </div>
        )}

        {/* 全部会话都被归档时，别让首屏看起来是空的 */}
        {!showEmptyState && grouping.groups.length === 0 && grouping.archivedCount > 0 && (
          <p className="px-1 py-2 text-[12px] text-[#52525b]">
            当前没有活跃会话，{grouping.archivedCount} 个已归档的会话在列表底部（仅本机归档）。
          </p>
        )}

        {/* 分组列表 */}
        <div className="space-y-2.5">
          {displayGroups.map((group) => (
            <SessionGroupSection
              key={group.key}
              group={group}
              collapsed={isCollapsed(group.key)}
              onToggleGroup={() => toggleSection(group.key)}
              subagentsCollapsed={storedCollapse[subagentSectionKey(group.key)] ?? true}
              onToggleSubagents={() =>
                setSectionCollapsed(
                  subagentSectionKey(group.key),
                  !(storedCollapse[subagentSectionKey(group.key)] ?? true),
                )
              }
              onOpen={onOpen}
              onArchive={onArchive}
              onUnarchive={onUnarchive}
              priorityIds={priorityIds}
              onRename={renameSession ? handleRenameSession : undefined}
              onFork={forkSession}
              onCancel={cancelSession}
            />
          ))}
        </div>

        {/* 本机归档区 */}
        <ArchivedSection
          items={grouping.archived}
          collapsed={archiveCollapsed}
          onToggle={() => setSectionCollapsed(ARCHIVE_SECTION_KEY, !archiveCollapsed)}
          onOpen={onOpen}
          onUnarchive={onUnarchive}
        />
      </div>

      {/* MiniMax Iconic Black Pill Button: [+ 聊天] */}
      <div className="fixed bottom-[calc(1.5rem+var(--sab))] right-5 z-20">
        <button
          onClick={openCreateDialog}
          type="button"
          aria-label="新建聊天"
          className="flex items-center gap-2 px-5 py-3 rounded-full bg-black hover:bg-gray-800 text-white text-[14px] font-medium shadow-lg hover:shadow-xl active:scale-95 transition-all cursor-pointer"
        >
          <Plus size={17} />
          <span>聊天</span>
        </button>
      </div>

      {/* MiniMax Modal Dialog */}
      {createDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pt-[calc(1rem+var(--sat))] pb-[calc(1rem+var(--sab))] bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl border border-gray-200 text-gray-900 animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-2.5 mb-2">
              <div className="w-9 h-9 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center p-1 shadow-2xs">
                <MiniMaxMascot size={26} />
              </div>
              <h3 className="text-[16px] font-bold text-gray-900">新建遥控会话</h3>
            </div>
            <p className="text-[13px] text-[#52525b] leading-relaxed">
              选择这台电脑上的工作区（cwd），或直接用主机默认工作区。
            </p>

            {workspaceChoices.length > 0 && (
              <div className="mt-4">
                <label className="block text-[12px] font-medium text-gray-600 mb-1.5">
                  已知工作区（点一下填入，共 {workspaceChoices.length} 个）
                </label>
                <div
                  role="radiogroup"
                  aria-label="已知工作区"
                  className="flex flex-col gap-1.5 max-h-44 overflow-y-auto pr-0.5"
                >
                  {workspaceChoices.map((option) => {
                    const active = customCwd.trim() === option.workspace;
                    return (
                      <button
                        key={option.workspace}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        title={option.workspace}
                        data-workspace={option.workspace}
                        onClick={() => setCustomCwd(option.workspace)}
                        className={`flex items-center gap-2 px-2.5 py-2 rounded-xl border text-left transition-colors cursor-pointer ${
                          active
                            ? 'bg-blue-50 border-blue-200 text-blue-700'
                            : 'bg-gray-50 border-gray-200/60 text-gray-700 hover:bg-gray-100'
                        }`}
                      >
                        <FolderOpen size={13} className="shrink-0 text-blue-500" />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{option.label}</span>
                        <span className="shrink-0 text-[10.5px] font-mono text-[#52525b]">
                          {option.sessionCount}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mt-4">
              <label className="block text-[12px] font-medium text-gray-600 mb-1.5" htmlFor="dsh-create-cwd">
                电脑工作区路径 (cwd)
              </label>
              <input
                id="dsh-create-cwd"
                type="text"
                value={customCwd}
                onChange={(e) => setCustomCwd(e.target.value)}
                placeholder="例如：~/Developer/projects/my-app（留空 = 主机默认工作区）"
                className="w-full px-3.5 py-2.5 text-[13px] font-mono bg-gray-50 border border-gray-200 rounded-xl focus:outline-hidden focus:border-gray-400 text-gray-900 placeholder:text-[#52525b]"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 mt-6">
              <button
                onClick={() => setCreateDialogOpen(false)}
                type="button"
                className="px-4 py-2 text-[13px] font-medium text-[#52525b] hover:text-gray-900 rounded-xl transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const cwd = customCwd.trim();
                  onCreate(cwd || undefined);
                  setCreateDialogOpen(false);
                }}
                type="button"
                className="px-5 py-2.5 rounded-full bg-black hover:bg-gray-800 text-white text-[13px] font-semibold transition-all shadow-sm cursor-pointer"
              >
                开始会话
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MiniMax Workspace Switcher Sheet */}
      {workspaceSheetOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div
            className="fixed inset-0"
            onClick={() => setWorkspaceSheetOpen(false)}
          />
          <div className="relative z-10 w-full max-w-sm rounded-t-3xl sm:rounded-3xl bg-white p-5 shadow-2xl border border-gray-200 text-gray-900 animate-in slide-in-from-bottom sm:zoom-in-95 duration-200 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center p-1">
                  <MiniMaxMascot size={22} />
                </div>
                <h3 className="text-[15px] font-bold text-gray-900">选择工作区</h3>
              </div>
              <button
                type="button"
                onClick={() => setWorkspaceSheetOpen(false)}
                aria-label="关闭"
                className="w-8 h-8 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500 cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-3 space-y-1.5 pr-0.5">
              {/* Option: 全部工作区 */}
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('selection');
                  setSelectedWorkspaceKey(null);
                  setWorkspaceSheetOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border text-left transition-colors cursor-pointer ${
                  selectedWorkspaceKey === null
                    ? 'bg-blue-50 border-blue-200 text-blue-700 font-semibold'
                    : 'bg-gray-50/80 hover:bg-gray-100 border-gray-200/60 text-gray-800'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <FolderOpen size={16} className={selectedWorkspaceKey === null ? 'text-blue-600' : 'text-gray-500'} />
                  <span className="text-[13.5px] truncate">全部工作区</span>
                </div>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-white border border-gray-200/60 text-gray-600">
                  {grouping.visibleCount}
                </span>
              </button>

              {/* Individual Workspaces (Showing only clean human labels, no raw paths!) */}
              {grouping.groups
                .filter((g) => g.kind === 'workspace')
                .map((group) => {
                  const active = selectedWorkspaceKey === group.key;
                  return (
                    <button
                      key={group.key}
                      type="button"
                      title={group.workspace || undefined}
                      onClick={() => {
                        triggerHaptic('selection');
                        setSelectedWorkspaceKey(group.key);
                        setWorkspaceSheetOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border text-left transition-colors cursor-pointer ${
                        active
                          ? 'bg-blue-50 border-blue-200 text-blue-700 font-semibold'
                          : 'bg-gray-50/80 hover:bg-gray-100 border-gray-200/60 text-gray-800'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1 pr-2">
                        <FolderOpen size={16} className={active ? 'text-blue-600' : 'text-gray-500'} />
                        <span className="text-[13.5px] truncate">{group.label}</span>
                        {group.runningCount > 0 && (
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0" />
                        )}
                      </div>
                      <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-white border border-gray-200/60 text-gray-600 shrink-0">
                        {group.total}
                      </span>
                    </button>
                  );
                })}
            </div>

            <div className="pt-3 border-t border-gray-100 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setWorkspaceSheetOpen(false);
                  openCreateDialog();
                }}
                className="w-full py-2.5 px-4 rounded-xl bg-gray-100 hover:bg-gray-200 text-[13px] font-medium text-gray-800 flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <Plus size={15} />
                <span>新建工作区会话…</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};