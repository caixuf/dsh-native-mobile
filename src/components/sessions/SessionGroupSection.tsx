import React, { useState } from 'react';
import { ChevronDown, ChevronUp, FolderOpen, Search } from 'lucide-react';
import type { SessionRow } from '../../types';
import type { SessionGroup } from '../../lib/session-groups';
import {
  DEFAULT_GROUP_LIMIT,
  SHOW_LESS_LABEL,
  capSessions,
  formatShowMoreLabel,
} from '../../lib/session-groups';
import { CollapsibleSection } from './CollapsibleSection';
import { SessionCard } from './SessionCard';

/**
 * 一个工作区组（或远端「搜索结果」组）：
 *   折叠头（工作区名 · 会话数 · 运行中数 · 箭头）
 *     └ 主会话卡片（运行中排前 + 时间倒序，**最多 12 条 + 显示更多**）
 *     └ 「子代理 (N)」子节（默认折叠，同样限 12 条）
 *
 * T6 的上限按**每个子列表**算（主会话 12 / 子代理 12）：真主机 desktop 组 41 条、
 * aiwork 组 35 条，全量渲染就是"滚不到底"。搜索命中与运行中的条目由 `capSessions`
 * 提到上限内，绝不把用户正在找的那条折叠掉。
 */

interface Props {
  group: SessionGroup;
  collapsed: boolean;
  onToggleGroup: () => void;
  /** 子代理子节是否折叠（默认 true）。 */
  subagentsCollapsed: boolean;
  onToggleSubagents: () => void;
  onOpen: (session: SessionRow) => void;
  onArchive?: (session: SessionRow) => void;
  onUnarchive?: (session: SessionRow) => void;
  /** 每组展示上限；缺省 DEFAULT_GROUP_LIMIT。 */
  limit?: number;
  /** 必须落在上限内的 id（搜索命中 / 远端结果）。 */
  priorityIds?: ReadonlySet<string>;
  /** T6：卡片操作菜单。均可选，不传则对应动作置灰。 */
  onRename?: (session: SessionRow, title: string) => void | Promise<unknown>;
  onFork?: (session: SessionRow) => void | Promise<unknown>;
  onCancel?: (session: SessionRow) => void | Promise<unknown>;
}

/** 「显示更多（还剩 N 条）」/「收起」——主会话与子代理子节共用。 */
const ExpandRow: React.FC<{
  hidden: number;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  label: string;
}> = ({ hidden, expanded, onExpand, onCollapse, label }) => {
  if (expanded) {
    return (
      <button
        type="button"
        onClick={onCollapse}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-dashed border-black/[0.12] bg-black/[0.02] hover:bg-black/[0.05] text-[12px] text-[#52525b] hover:text-[#3f3f46] transition-colors cursor-pointer studio-tap"
      >
        <ChevronUp size={13} />
        {SHOW_LESS_LABEL}
      </button>
    );
  }
  const text = formatShowMoreLabel(hidden);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`${text}（${label}）`}
      data-testid="show-more"
      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-dashed border-[#3b82f6]/30 bg-[#3b82f6]/[0.06] hover:bg-[#3b82f6]/[0.14] text-[12px] font-medium text-[#1d4ed8] transition-colors cursor-pointer studio-tap"
    >
      <ChevronDown size={13} />
      {text}
    </button>
  );
};

export const SessionGroupSection: React.FC<Props> = ({
  group,
  collapsed,
  onToggleGroup,
  subagentsCollapsed,
  onToggleSubagents,
  onOpen,
  onArchive,
  onUnarchive,
  limit = DEFAULT_GROUP_LIMIT,
  priorityIds,
  onRename,
  onFork,
  onCancel,
}) => {
  const isSearch = group.kind === 'search';
  const [mainExpanded, setMainExpanded] = useState(false);
  const [subExpanded, setSubExpanded] = useState(false);

  const main = capSessions(group.sessions, { limit, priorityIds, expanded: mainExpanded });
  const subs = capSessions(group.subagents, { limit, priorityIds, expanded: subExpanded });
  const mainHasMoreToCollapse = group.sessions.length > limit;

  return (
    <CollapsibleSection
      collapsed={collapsed}
      onToggle={onToggleGroup}
      level="group"
      count={group.total}
      runningCount={group.runningCount}
      hint={group.hint}
      controlsLabel={`${group.label} 的会话列表`}
      title={
        <span className="flex items-center gap-2">
          {isSearch ? (
            <Search size={14} className="shrink-0 text-[#a78bfa]" />
          ) : (
            <FolderOpen size={14} className="shrink-0 text-[#3b82f6]" />
          )}
          <span className="truncate">{group.label}</span>
          {isSearch && (
            <span className="shrink-0 text-[10.5px] font-medium px-1.5 py-0.5 rounded-md bg-[#a855f7]/15 text-[#c084fc] border border-[#a855f7]/25">
              远端
            </span>
          )}
        </span>
      }
    >
      <div className="space-y-2">
        {isSearch && group.hiddenDuplicateCount > 0 && (
          <p className="px-1 text-[11px] text-[#52525b]">
            已与本地列表合并 {group.hiddenDuplicateCount} 条重复结果
          </p>
        )}

        {main.visible.map((session) => (
          <SessionCard
            key={session.sessionId}
            session={session}
            showWorkspace={isSearch}
            onOpen={onOpen}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
            onRename={onRename}
            onFork={onFork}
            onCancel={onCancel}
          />
        ))}

        <ExpandRow
          hidden={main.hidden}
          expanded={mainExpanded && mainHasMoreToCollapse}
          onExpand={() => setMainExpanded(true)}
          onCollapse={() => setMainExpanded(false)}
          label={group.label}
        />

        {isSearch && group.sessions.length === 0 && (
          <p className="px-1 py-2 text-[12px] text-[#52525b]">没有新的远端结果（都已在上面的分组里）</p>
        )}

        {group.subagents.length > 0 && (
          <CollapsibleSection
            collapsed={subagentsCollapsed}
            onToggle={onToggleSubagents}
            level="sub"
            count={group.subagents.length}
            runningCount={group.subagents.filter((s) => s.running).length}
            controlsLabel={`${group.label} 的子代理会话`}
            title={<span className="truncate">子代理</span>}
          >
            <div className="space-y-2">
              {subs.visible.map((session) => (
                <SessionCard
                  key={session.sessionId}
                  session={session}
                  showWorkspace={isSearch}
                  onOpen={onOpen}
                  onArchive={onArchive}
                  onUnarchive={onUnarchive}
                  onRename={onRename}
                  onFork={onFork}
                  onCancel={onCancel}
                  compact
                />
              ))}

              <ExpandRow
                hidden={subs.hidden}
                expanded={subExpanded && group.subagents.length > limit}
                onExpand={() => setSubExpanded(true)}
                onCollapse={() => setSubExpanded(false)}
                label={`${group.label} 的子代理`}
              />
            </div>
          </CollapsibleSection>
        )}
      </div>
    </CollapsibleSection>
  );
};