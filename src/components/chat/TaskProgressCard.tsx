import React, { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, ListChecks, Sparkles } from 'lucide-react';
import { TaskStep } from '../../types';

interface Props {
  steps: TaskStep[];
  running: boolean;
}

export const TaskProgressCard: React.FC<Props> = ({ steps, running }) => {
  const [expanded, setExpanded] = useState(true);

  if (steps.length === 0) return null;

  const completedCount = steps.filter((s) => s.status === 'COMPLETED').length;
  const progressPercent = Math.round((completedCount / steps.length) * 100);

  return (
    <div className="my-3 rounded-2xl specular-card overflow-hidden shadow-xl border border-white/10">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-4 py-3 bg-[#151926]/90 border-b border-white/[0.06] cursor-pointer hover:bg-[#1c2233] transition-colors select-none"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-lg bg-[#3b82f6]/15 border border-[#3b82f6]/30 flex items-center justify-center text-[#60a5fa]">
            <ListChecks size={14} />
          </div>
          <span className="font-semibold text-xs tracking-wide text-white">
            规划执行步骤
          </span>
          <span className="text-[11px] font-mono text-[#94a3b8] bg-white/[0.06] px-2 py-0.5 rounded-full border border-white/[0.06]">
            {completedCount}/{steps.length} ({progressPercent}%)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {running && (
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#38bdf8] bg-[#38bdf8]/10 px-2 py-0.5 rounded-full border border-[#38bdf8]/20">
              <Loader2 size={12} className="animate-spin" />
              <span>电脑执行中</span>
            </div>
          )}
          <div className="text-[#64748b] hover:text-white transition-colors">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
        </div>
      </div>

      {/* Sleek Gradient Progress Line */}
      <div className="h-1 w-full bg-[#10141f]">
        <div
          className="h-full bg-gradient-to-r from-[#3b82f6] to-[#60a5fa] transition-all duration-300 shadow-[0_0_10px_rgba(59,130,246,0.5)]"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {expanded && (
        <div className="p-3.5 space-y-2.5 bg-[#0e121c]/70">
          {steps.map((step, idx) => (
            <div key={idx} className="flex items-start gap-2.5 group">
              <div className="mt-0.5 shrink-0">
                {step.status === 'COMPLETED' ? (
                  <CheckCircle2 size={15} className="text-[#10b981]" />
                ) : step.status === 'RUNNING' ? (
                  <Loader2 size={15} className="text-[#38bdf8] animate-spin" />
                ) : (
                  <div className="w-3.5 h-3.5 rounded-full border border-white/20 bg-white/[0.03]" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-xs leading-relaxed ${
                    step.status === 'COMPLETED'
                      ? 'text-[#64748b] line-through'
                      : step.status === 'RUNNING'
                      ? 'text-[#60a5fa] font-semibold'
                      : 'text-[#e2e8f0]'
                  }`}
                >
                  {step.title}
                </p>
                {step.detail && (
                  <p className="text-[11px] text-[#94a3b8] font-mono truncate mt-0.5 bg-black/30 px-2 py-0.5 rounded border border-white/[0.04]">
                    {step.detail}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
