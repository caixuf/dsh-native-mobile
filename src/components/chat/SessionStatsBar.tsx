import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Gauge, Database } from 'lucide-react';

/**
 * 会话状态栏 —— 对齐桌面版 `StatsPills.tsx`。
 *
 * 桌面版是输入区上方的三个 pill：
 *   「20 轮 906 步 · 292 tok/s」 「334M tok · 缓存命中 94%」 「35.7%」
 * 点开各自弹出明细对话框。手机上改成**一行三段 + 点整行展开明细**（更符合窄屏）。
 *
 * 🔴 铁律：任一读数为 null 就**整段不渲染**。显示 "0 tok/s" 或 "0%" 是撒谎 ——
 * 用户会以为 agent 没干活 / 上下文没用。
 */
interface Props {
  activity: string | null;
  usage: string | null;
  context: string | null;
  detail: Array<{ label: string; value: string }>;
}

export const SessionStatsBar: React.FC<Props> = ({ activity, usage, context, detail }) => {
  const [open, setOpen] = useState(false);
  const hasAny = Boolean(activity || usage || context);
  if (!hasAny) return null;

  const seg = (label: string, value: string | null, icon?: React.ReactNode) =>
    value ? (
      <span className="flex items-center gap-1 min-w-0">
        {icon}
        <span className="text-[#64748b] shrink-0">{label}</span>
        <span className="text-[#94a3b8] font-mono truncate">{value}</span>
      </span>
    ) : null;

  return (
    <div className="px-4 pt-2 pb-1 select-none" data-testid="session-stats">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? '收起会话统计' : '展开会话统计明细'}
        className="w-full min-h-[44px] flex items-center gap-3 flex-wrap px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-left cursor-pointer studio-tap"
      >
        {seg('', activity, <Gauge size={12} className="text-[#64748b] shrink-0" />)}
        {seg('', usage, <Database size={12} className="text-[#64748b] shrink-0" />)}
        {seg('上下文', context)}
        {detail.length > 0 && (
          <span className="ml-auto text-[#475569] shrink-0">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        )}
      </button>
      {open && detail.length > 0 && (
        <dl
          data-testid="session-stats-detail"
          className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2.5 rounded-xl bg-black/25 border border-white/[0.06]"
        >
          {detail.map((d) => (
            <div key={d.label} className="flex items-baseline justify-between gap-2 min-w-0">
              <dt className="text-[11px] text-[#64748b] truncate">{d.label}</dt>
              <dd className="text-[11px] text-[#cbd5e1] font-mono shrink-0">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
};

export default SessionStatsBar;
