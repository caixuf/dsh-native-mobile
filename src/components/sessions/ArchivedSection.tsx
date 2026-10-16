import React from 'react';
import { Archive } from 'lucide-react';
import type { SessionRow } from '../../types';
import { ARCHIVE_NOTE } from '../../lib/session-groups';
import { CollapsibleSection } from './CollapsibleSection';
import { SessionCard } from './SessionCard';

/**
 * 列表底部的「已归档 (N)」区。
 *
 * ⚠️ 归档是**仅本机**的：真主机的 session 端点里没有 archive，
 * 所以我们只能在本 App 内隐藏它。文案必须如实说明，否则用户会以为
 * 电脑上那份也被收起来了。
 */

interface Props {
  items: SessionRow[];
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (session: SessionRow) => void;
  onUnarchive?: (session: SessionRow) => void;
}

export const ArchivedSection: React.FC<Props> = ({
  items,
  collapsed,
  onToggle,
  onOpen,
  onUnarchive,
}) => {
  if (items.length === 0) return null;

  return (
    <CollapsibleSection
      collapsed={collapsed}
      onToggle={onToggle}
      level="archive"
      count={items.length}
      controlsLabel="已归档会话（仅本机）"
      title={
        <span className="flex items-center gap-2">
          <Archive size={14} className="shrink-0 text-[#52525b]" />
          <span className="truncate">已归档</span>
        </span>
      }
    >
      <p className="px-1 pb-2 text-[11px] leading-relaxed text-[#52525b]">{ARCHIVE_NOTE}</p>
      <div className="space-y-2">
        {items.map((session) => (
          <SessionCard
            key={session.sessionId}
            session={session}
            archived
            compact
            showWorkspace={true}
            onOpen={onOpen}
            onUnarchive={onUnarchive}
          />
        ))}
      </div>
    </CollapsibleSection>
  );
};