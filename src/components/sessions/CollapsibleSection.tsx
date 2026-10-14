import React, { useId } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * 零依赖可折叠容器。
 *
 * 为什么不用现成组件库：本仓库的运行时代价很敏感（见 package.json 的依赖白名单），
 * 而原生 `<button aria-expanded aria-controls>` 已经能覆盖键盘 / 读屏的全部需求。
 *
 * 受控组件：折叠状态由调用方持有（这样折叠状态才能持久化到 localStorage，
 * 见 `src/lib/session-groups.ts` 的 read/writeCollapseState）。
 *
 * 折叠时**面板仍留在 DOM 里但 hidden**，同时子树不渲染 —— 既有合法的
 * aria-controls 目标，又不会因为几百条会话而付出渲染代价。
 */

type Level = 'group' | 'sub' | 'archive';

interface Props {
  /** 折叠头左侧内容（图标 + 名称等）。 */
  title: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  /** 会话数量徽标。 */
  count?: number;
  /** 运行中数量徽标（0 不显示）。 */
  runningCount?: number;
  /** 名称右侧的次要说明（父目录 / 搜索词）。 */
  hint?: string;
  level?: Level;
  /** panel 的可访问名。 */
  controlsLabel?: string;
  /** 额外的头部右侧内容（例如全选、刷新）。 */
  actions?: React.ReactNode;
  children: React.ReactNode;
}

const HEADER_CLASS: Record<Level, string> = {
  group:
    'px-3 py-2.5 rounded-2xl bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.08]',
  sub: 'px-3 py-2 rounded-xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.06]',
  archive:
    'px-3 py-2.5 rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-dashed border-white/[0.12]',
};

const TITLE_CLASS: Record<Level, string> = {
  group: 'text-[14px] font-semibold text-[#e2e8f0]',
  sub: 'text-[12.5px] font-medium text-[#cbd5e1]',
  archive: 'text-[13px] font-medium text-[#94a3b8]',
};

export const CollapsibleSection: React.FC<Props> = ({
  title,
  collapsed,
  onToggle,
  count,
  runningCount = 0,
  hint,
  level = 'group',
  controlsLabel,
  actions,
  children,
}) => {
  const panelId = useId();

  return (
    <section className="w-full">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={panelId}
          className={`flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer transition-colors studio-tap ${HEADER_CLASS[level]}`}
        >
          <span className="shrink-0 text-[#64748b]">
            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          </span>
          <span className={`truncate ${TITLE_CLASS[level]}`}>{title}</span>

          {typeof count === 'number' && (
            <span className="shrink-0 text-[11px] font-mono px-1.5 py-0.5 rounded-md bg-white/[0.06] border border-white/[0.08] text-[#94a3b8]">
              {count}
            </span>
          )}

          {runningCount > 0 && (
            <span className="shrink-0 flex items-center gap-1 text-[11px] font-semibold text-[#38bdf8] bg-[#38bdf8]/12 px-2 py-0.5 rounded-full border border-[#38bdf8]/25">
              <span className="w-1.5 h-1.5 rounded-full bg-[#38bdf8] animate-pulse" />
              {runningCount} 运行中
            </span>
          )}

          {hint && (
            <span className="hidden sm:block shrink min-w-0 truncate text-[11px] font-mono text-[#475569]">
              {hint}
            </span>
          )}
        </button>
        {actions}
      </div>

      <div id={panelId} role="region" aria-label={controlsLabel} hidden={collapsed}>
        {!collapsed && <div className="pt-2">{children}</div>}
      </div>
    </section>
  );
};