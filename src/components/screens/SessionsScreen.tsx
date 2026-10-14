import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Menu, Search, X, RefreshCw, Plus, Monitor, Cpu, Sparkles, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { SessionRow, LinkState } from '../../types';
import { StatusPill } from '../common/StatusPill';
import { DeepSeekLogo } from '../common/DeepSeekLogo';
import { ConnectionDot } from '../common/ConnectionDot';
import { SessionGroupSection } from '../sessions/SessionGroupSection';
import { ArchivedSection } from '../sessions/ArchivedSection';
import {
  type CollapseState,
  type StorageLike,
  filterSessionsByQuery,
  groupSessions,
  readArchivedIds,
  readCollapseState,
  resolveCollapseState,
  setArchivedId,
  subagentSectionKey,
  writeArchivedIds,
  writeCollapseState,
} from '../../lib/session-groups';

/**
 * 会话列表：**按工作区分组 + 可折叠 + 本机归档**。
 *
 * 改造动机（用户原话）：「会话全部列出来，给人翻累死了，而且没有桌面的归档什么的，
 * 就像管理文件夹一样啊」。所以形态对齐 DSH 桌面侧边栏：顶层按工作区（cwd）分组，
 * 组可折叠，组内挂会话；子代理收进组内的「子代理 (N)」子节；归档项沉到底部。
 *
 * 分组 / 排序 / 折叠 / 归档的全部判定都在 `src/lib/session-groups.ts`（纯函数、可测），
 * 本文件只负责：把 props 喂进去 → 渲染 → 把用户选择写回 localStorage。
 *
 * props 契约：
 *  - 已有 props 语义不变（linkState/sessions/…/onOpenDrawer）。
 *  - `archivedIds` 传入 = **受控**（组件不再自持该状态，由调用方回写）；
 *    不传 = 非受控，组件自己从 localStorage 读写。
 *  - `onArchive` / `onUnarchive` 是「用户点了归档/恢复」的通知回调（可选）。
 *  - `searchResults` 传入远端 session.search 的原始结果时，会在顶部单独成
 *    「搜索结果」组，并与本地列表去重；不传则只做本地即时过滤。
 */

/** 归档区自己的折叠 key（和分组共用一份持久化记录）。 */
const ARCHIVE_SECTION_KEY = '::archived-section::';

const ALL_EXPANDED = false;

interface Props {
  linkState: LinkState;
  sessions: SessionRow[];
  subagentSessions: SessionRow[];
  loading: boolean;
  onOpen: (session: SessionRow) => void;
  onRefresh: () => void;
  onSearch: (q: string) => void;
  onCreate: (cwd?: string) => void;
  onOpenDrawer: () => void;
  /** 已归档会话 id（传入即受控：组件只通知，不回写内部状态）。 */
  archivedIds?: string[];
  onArchive?: (s: SessionRow) => void;
  onUnarchive?: (s: SessionRow) => void;
  /** 远端搜索结果（session.search 原始 items），单独成组。 */
  searchResults?: SessionRow[];
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
  onOpenDrawer,
  archivedIds,
  onArchive,
  onUnarchive,
  searchResults,
}) => {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [customCwd, setCustomCwd] = useState('~/Developer/workspaces/nexus-ecommerce');

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

  // ── 分组（memo 化：会话多时绝不在每次 render 重算）──
  const localMain = useMemo(() => filterSessionsByQuery(sessions, query), [sessions, query]);
  const localSubagents = useMemo(() => filterSessionsByQuery(subagentSessions, query), [subagentSessions, query]);

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

  const archiveCollapsed = storedCollapse[ARCHIVE_SECTION_KEY] ?? true;
  const isCollapsed = (key: string) => collapsed[key] === true;

  const setSectionCollapsed = (key: string, value: boolean) => {
    persistCollapse({ ...storedCollapse, ...collapsed, [key]: value });
  };

  const toggleSection = (key: string) => setSectionCollapsed(key, !isCollapsed(key));

  const setAllSections = (collapseAll: boolean) => {
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

  const hasContent = grouping.groups.length > 0 || grouping.archivedCount > 0;
  const showEmptyState = !hasContent && !loading;

  return (
    <div className="flex flex-col h-full bg-[#090a0f] text-[#f8fafc] mesh-glow-bg select-none">
      {/* Studio Top Navigation Bar */}
      <header className="sticky top-0 z-30 studio-glass border-b border-white/[0.08] px-4 py-3 transition-all">
        <div className="flex items-center justify-between max-w-2xl mx-auto w-full">
          <div className="flex items-center gap-3">
            <button
              onClick={onOpenDrawer}
              type="button"
              aria-label="打开菜单"
              className="w-9 h-9 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-[#e2e8f0] transition-colors cursor-pointer studio-tap"
            >
              <Menu size={18} />
            </button>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#1e293b] to-[#0f172a] border border-white/10 shadow-inner flex items-center justify-center p-1.5">
                <DeepSeekLogo size={22} variant="brand" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-[17px] font-bold tracking-tight text-white flex items-center gap-1.5">
                    遥控会话
                  </h1>
                  <StatusPill linkState={linkState} onClick={onOpenDrawer} />
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                setSearchOpen(!searchOpen);
                if (searchOpen) handleSearchChange('');
              }}
              type="button"
              aria-label={searchOpen ? '关闭搜索' : '搜索会话'}
              className="w-9 h-9 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-[#94a3b8] hover:text-white transition-colors cursor-pointer studio-tap"
            >
              {searchOpen ? <X size={17} /> : <Search size={17} />}
            </button>
            <button
              onClick={onRefresh}
              type="button"
              aria-label="刷新会话列表"
              className="w-9 h-9 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-[#94a3b8] hover:text-white transition-colors cursor-pointer studio-tap"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin text-[#3b82f6]' : ''} />
            </button>
          </div>
        </div>

        {/* Studio Dark Search Bar */}
        {searchOpen && (
          <div className="mt-2.5 pt-2 border-t border-white/[0.06] max-w-2xl mx-auto w-full animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="relative flex items-center">
              <Search size={15} className="absolute left-3.5 text-[#64748b]" />
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="搜索会话标题、摘要或工作区…"
                aria-label="搜索会话"
                className="w-full pl-10 pr-3 py-2 text-[13px] bg-[#141824] border border-white/10 rounded-xl focus:outline-hidden focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/40 text-white placeholder:text-[#64748b] transition-all"
              />
            </div>
          </div>
        )}
      </header>

      {/* Main Sessions List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3.5 max-w-2xl w-full mx-auto pb-32">
        {/* Bento Remote Host Status Overview Card */}
        <div className="specular-card p-4 rounded-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 -mt-4 -mr-4 w-28 h-28 bg-[#3b82f6]/10 rounded-full blur-2xl pointer-events-none" />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#1e2538] border border-white/10 flex items-center justify-center text-[#38bdf8] shadow-inner">
                <Monitor size={20} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-bold text-white">
                    {linkState.type === 'ready' ? linkState.hostName || '远程工作站' : '远程工作站'}
                  </span>
                  <span className="flex items-center gap-1 text-[11px] font-medium text-[#10b981] bg-[#10b981]/10 px-2 py-0.5 rounded-md border border-[#10b981]/20">
                    <ConnectionDot status={linkState.type === 'ready' ? 'online' : 'offline'} size={5} pulse={false} />
                    {linkState.type === 'ready' ? '双向流就绪' : '等待连接'}
                  </span>
                </div>
                <p className="text-[12px] text-[#94a3b8] mt-0.5 font-mono flex items-center gap-1.5">
                  <Cpu size={12} className="text-[#3b82f6]" />
                  <span>DeepSeek Agent 守护进程 · 延迟 ~18ms</span>
                </p>
              </div>
            </div>

            <button
              onClick={() => setCreateDialogOpen(true)}
              type="button"
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#3b82f6]/20 hover:bg-[#3b82f6]/30 border border-[#3b82f6]/40 text-[#60a5fa] hover:text-white text-[12px] font-semibold transition-all cursor-pointer studio-tap"
            >
              <Plus size={14} />
              <span>新建</span>
            </button>
          </div>
        </div>

        {/* 分组概览 + 全展开/全折叠 */}
        {hasContent && (
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="min-w-0 truncate text-[12px] text-[#94a3b8]">
              <span className="font-semibold text-[#cbd5e1]">{grouping.workspaceCount}</span> 个工作区 ·{' '}
              <span className="font-semibold text-[#cbd5e1]">{grouping.visibleCount}</span> 个会话
              {grouping.runningCount > 0 && (
                <span className="text-[#38bdf8]"> · {grouping.runningCount} 个执行中</span>
              )}
              {grouping.archivedCount > 0 && (
                <span className="text-[#64748b]"> · {grouping.archivedCount} 个已归档</span>
              )}
            </p>
            {grouping.groups.length > 1 && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setAllSections(false)}
                  title="展开全部"
                  aria-label="展开全部工作区"
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.10] border border-white/[0.08] text-[11px] text-[#94a3b8] hover:text-white transition-colors cursor-pointer studio-tap"
                >
                  <ChevronsUpDown size={13} />
                  展开
                </button>
                <button
                  type="button"
                  onClick={() => setAllSections(true)}
                  title="折叠全部"
                  aria-label="折叠全部工作区"
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.10] border border-white/[0.08] text-[11px] text-[#94a3b8] hover:text-white transition-colors cursor-pointer studio-tap"
                >
                  <ChevronsDownUp size={13} />
                  折叠
                </button>
              </div>
            )}
          </div>
        )}

        {/* Empty State */}
        {showEmptyState && (
          <div className="flex flex-col items-center justify-center p-8 mt-8 text-center specular-card rounded-3xl">
            <div className="w-14 h-14 rounded-2xl bg-[#1e2538] border border-white/10 text-[#3b82f6] flex items-center justify-center mb-3 p-2.5 shadow-inner">
              <DeepSeekLogo size={32} variant="brand" />
            </div>
            <h3 className="text-[16px] font-bold text-white">
              {query.trim() ? '没有匹配的会话' : '暂无匹配的遥控会话'}
            </h3>
            <p className="text-[13px] text-[#94a3b8] mt-1.5 max-w-xs leading-relaxed">
              {query.trim()
                ? '换个关键词，或清空搜索看看全部工作区。'
                : '随时发起指令，通过端到端加密双向流遥控你的远程开发电脑。'}
            </p>
            <button
              onClick={() => setCreateDialogOpen(true)}
              type="button"
              className="mt-5 px-5 py-2.5 bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white rounded-xl text-[13px] font-semibold transition-transform cursor-pointer studio-tap shadow-[0_0_20px_rgba(59,130,246,0.35)]"
            >
              发起新会话
            </button>
          </div>
        )}

        {/* 全部会话都被归档时，别让首屏看起来是空的 */}
        {!showEmptyState && grouping.groups.length === 0 && grouping.archivedCount > 0 && (
          <p className="px-1 py-2 text-[12px] text-[#64748b]">
            当前没有活跃会话，{grouping.archivedCount} 个已归档的会话在列表底部（仅本机归档）。
          </p>
        )}

        {/* 分组列表 */}
        <div className="space-y-2.5">
          {grouping.groups.map((group) => (
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

      {/* Floating Action Button (Raycast Glowing Pill) */}
      <div className="fixed bottom-6 right-6 z-20">
        <button
          onClick={() => setCreateDialogOpen(true)}
          type="button"
          className="flex items-center gap-2 px-5 py-3.5 rounded-full bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white text-[14px] font-semibold shadow-[0_0_25px_rgba(59,130,246,0.5)] hover:shadow-[0_0_35px_rgba(59,130,246,0.7)] transition-all hover:scale-105 cursor-pointer studio-tap"
        >
          <Sparkles size={17} className="text-white animate-pulse" />
          <span>新建会话</span>
        </button>
      </div>

      {/* Studio Modal Dialog */}
      {createDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in">
          <div className="w-full max-w-sm rounded-3xl specular-card p-6 shadow-2xl border border-white/10 animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-2.5 mb-2">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#1e293b] to-[#0f172a] border border-white/10 flex items-center justify-center p-1.5 shadow-inner">
                <DeepSeekLogo size={20} variant="brand" />
              </div>
              <h3 className="text-[16px] font-bold text-white">新建遥控会话</h3>
            </div>
            <p className="text-[13px] text-[#94a3b8] leading-relaxed">
              可指定在远程工作电脑上关联的工作区目录 (CWD)。
            </p>

            <div className="mt-4">
              <label className="block text-[12px] font-medium text-[#94a3b8] mb-1.5">
                电脑工作区路径 (cwd)
              </label>
              <input
                type="text"
                value={customCwd}
                onChange={(e) => setCustomCwd(e.target.value)}
                placeholder="例如：~/Developer/projects/my-app"
                className="w-full px-3.5 py-2.5 text-[13px] font-mono bg-[#141824] border border-white/10 rounded-xl focus:outline-hidden focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/40 text-white placeholder:text-[#64748b]"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 mt-6">
              <button
                onClick={() => setCreateDialogOpen(false)}
                type="button"
                className="px-4 py-2 text-[13px] font-medium text-[#94a3b8] hover:text-white rounded-xl transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onCreate(customCwd.trim());
                  setCreateDialogOpen(false);
                }}
                type="button"
                className="px-5 py-2 text-[13px] font-semibold text-white bg-gradient-to-r from-[#3b82f6] to-[#2563eb] rounded-xl shadow-[0_0_20px_rgba(59,130,246,0.35)] transition-transform cursor-pointer studio-tap"
              >
                创建会话
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};