import React from 'react';
import { Archive, ArchiveRestore, ChevronRight, Folder } from 'lucide-react';
import type { SessionRow } from '../../types';
import { formatSessionTime } from '../../lib/session-groups';

/**
 * 单条会话卡片。
 *
 * 结构上刻意拆成两个并列的按钮：
 *  - 主体按钮 = 打开会话（键盘 Enter/Space 可用，不再依赖 div onClick）；
 *  - 归档按钮 = 本机归档 / 恢复，`stopPropagation` 之外还避免了
 *    「按钮套按钮」这种读屏器会报错的嵌套。
 */

interface Props {
  session: SessionRow;
  onOpen: (session: SessionRow) => void;
  /** 已归档样式（灰一档）+ 按钮语义变为「恢复」。 */
  archived?: boolean;
  onArchive?: (session: SessionRow) => void;
  onUnarchive?: (session: SessionRow) => void;
  /** 紧凑模式：子代理子节里用，省一点垂直空间。 */
  compact?: boolean;
}

export const SessionCard: React.FC<Props> = ({
  session,
  onOpen,
  archived = false,
  onArchive,
  onUnarchive,
  compact = false,
}) => {
  const canToggleArchive = archived ? !!onUnarchive : !!onArchive;
  const handleToggleArchive = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (archived) onUnarchive?.(session);
    else onArchive?.(session);
  };

  return (
    <div
      className={`specular-card-interactive group relative overflow-hidden rounded-2xl ${
        compact ? 'p-3' : 'p-3.5'
      } ${archived ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          onClick={() => onOpen(session)}
          className="min-w-0 flex-1 text-left cursor-pointer"
          aria-label={`打开会话 ${session.title || session.sessionId}`}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <h3
              className={`min-w-0 truncate font-semibold tracking-tight text-white group-hover:text-[#60a5fa] transition-colors ${
                compact ? 'text-[13.5px]' : 'text-[15px]'
              }`}
            >
              {session.title || '未命名会话'}
            </h3>

            {session.isSubagent && (
              <span className="shrink-0 text-[10.5px] font-medium px-2 py-0.5 rounded-md bg-[#a855f7]/15 text-[#c084fc] border border-[#a855f7]/25">
                子代理
              </span>
            )}

            {session.running && (
              <span className="shrink-0 flex items-center gap-1.5 text-[11px] font-semibold text-[#38bdf8] bg-[#38bdf8]/15 px-2.5 py-0.5 rounded-full border border-[#38bdf8]/30">
                <span className="w-1.5 h-1.5 rounded-full bg-[#38bdf8] animate-ping" />
                电脑执行中
              </span>
            )}
          </div>

          {session.preview && (
            <p
              className={`text-[#94a3b8] mt-1.5 leading-relaxed font-normal ${
                compact ? 'text-[12px] line-clamp-1' : 'text-[13px] line-clamp-2'
              }`}
            >
              {session.preview}
            </p>
          )}

          <div className="flex items-center gap-2 mt-2.5 text-[11.5px] text-[#64748b]">
            {session.workspace && (
              <>
                <span className="flex items-center gap-1 font-mono text-[#cbd5e1] truncate max-w-[220px] bg-white/[0.04] px-2 py-0.5 rounded-md border border-white/[0.06]">
                  <Folder size={11} className="shrink-0 text-[#3b82f6]" />
                  <span className="truncate">{session.workspace}</span>
                </span>
                <span>·</span>
              </>
            )}
            <span>{formatSessionTime(session.updatedAt)}</span>
          </div>
        </button>

        <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
          {canToggleArchive && (
            <button
              type="button"
              onClick={handleToggleArchive}
              aria-label={archived ? `恢复会话 ${session.title}` : `归档会话 ${session.title}（仅本机）`}
              title={archived ? '恢复（仅本机归档）' : '归档（仅本机，不会同步回电脑）'}
              className={`w-7 h-7 rounded-lg flex items-center justify-center border transition-colors cursor-pointer studio-tap ${
                archived
                  ? 'bg-[#10b981]/10 hover:bg-[#10b981]/20 border-[#10b981]/25 text-[#34d399]'
                  : 'bg-white/[0.04] hover:bg-white/[0.10] border-white/[0.08] text-[#64748b] hover:text-[#e2e8f0]'
              }`}
            >
              {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            </button>
          )}
          <span className="text-[#475569] group-hover:text-[#60a5fa] group-hover:translate-x-0.5 transition-all">
            <ChevronRight size={17} />
          </span>
        </div>
      </div>
    </div>
  );
};