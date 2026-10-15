import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Gauge, Database, Layers } from 'lucide-react';
import { triggerHaptic } from '../../utils/haptics';

/**
 * 会话统计栏 —— 顶部紧凑诊断指示条（对齐桌面版 `StatsPills.tsx`）。
 *
 * 手机端优化：
 *  - 锚定在顶部 Header 下方，绝不常驻在底部输入栏遮挡审批/操作按钮；
 *  - 紧凑单行胶囊设计，极小纵向高度（32px），超窄屏自然横滑；
 *  - 点击平滑展开完整指标面板（模型耗时、工具耗时、首字延迟、各 token 桶、上下文构成）；
 *  - 🔴 铁律：任一读数为 null 就整段不渲染，绝不显示 0 冒充真实值。
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

  const handleToggle = () => {
    triggerHaptic('selection');
    setOpen((v) => !v);
  };

  const seg = (label: string, value: string | null, icon?: React.ReactNode) =>
    value ? (
      <span className="inline-flex items-center gap-1.5 min-w-0 text-[11px]">
        {icon}
        {label && <span className="text-[#64748b] shrink-0 font-medium">{label}</span>}
        <span className="text-[#94a3b8] font-mono truncate">{value}</span>
      </span>
    ) : null;

  return (
    <div
      className="w-full bg-[#0d111c]/90 border-b border-white/[0.06] backdrop-blur-md px-4 py-1.5 transition-all select-none"
      data-testid="session-stats"
    >
      <div className="max-w-2xl mx-auto">
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={open}
          aria-label={open ? '收起会话性能统计' : '展开会话性能统计明细'}
          className="w-full flex items-center justify-between gap-3 text-left py-1 px-2.5 rounded-lg bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.04] transition-colors cursor-pointer studio-tap"
        >
          <div className="flex items-center gap-3 overflow-x-auto no-scrollbar py-0.5">
            {seg('', activity, <Gauge size={12} className="text-[#38bdf8] shrink-0" />)}
            {activity && (usage || context) && <span className="text-[#334155] shrink-0">·</span>}
            {seg('', usage, <Database size={12} className="text-[#818cf8] shrink-0" />)}
            {usage && context && <span className="text-[#334155] shrink-0">·</span>}
            {seg('上下文', context, <Layers size={11} className="text-[#a78bfa] shrink-0" />)}
          </div>
          {detail.length > 0 && (
            <span className="flex items-center gap-1 text-[10.5px] text-[#64748b] hover:text-[#94a3b8] shrink-0 pl-1">
              <span>{open ? '收起' : '明细'}</span>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </button>

        {open && detail.length > 0 && (
          <dl
            data-testid="session-stats-detail"
            className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2.5 rounded-xl bg-black/40 border border-white/[0.08] animate-in fade-in-50 duration-150"
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
    </div>
  );
};

export default SessionStatsBar;

