import React from 'react';
import { FolderOpen, Search } from 'lucide-react';
import type { SessionRow } from '../../types';
import type { SessionGroup } from '../../lib/session-groups';
import { CollapsibleSection } from './CollapsibleSection';
import { SessionCard } from './SessionCard';

/**
 * 一个工作区组（或远端「搜索结果」组）：
 *   折叠头（工作区名 · 会话数 · 运行中数 · 箭头）
 *     └ 主会话卡片（运行中排前 + 时间倒序）
 *     └ 「子代理 (N)」子节（默认折叠）
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
}

export const SessionGroupSection: React.FC<Props> = ({
  group,
  collapsed,
  onToggleGroup,
  subagentsCollapsed,
  onToggleSubagents,
  onOpen,
  onArchive,
  onUnarchive,
}) => {
  const isSearch = group.kind === 'search';

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
          <p className="px-1 text-[11px] text-[#64748b]">
            已与本地列表合并 {group.hiddenDuplicateCount} 条重复结果
          </p>
        )}

        {group.sessions.map((session) => (
          <SessionCard
            key={session.sessionId}
            session={session}
            onOpen={onOpen}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
          />
        ))}

        {isSearch && group.sessions.length === 0 && (
          <p className="px-1 py-2 text-[12px] text-[#64748b]">没有新的远端结果（都已在上面的分组里）</p>
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
              {group.subagents.map((session) => (
                <SessionCard
                  key={session.sessionId}
                  session={session}
                  onOpen={onOpen}
                  onArchive={onArchive}
                  onUnarchive={onUnarchive}
                  compact
                />
              ))}
            </div>
          </CollapsibleSection>
        )}
      </div>
    </CollapsibleSection>
  );
};