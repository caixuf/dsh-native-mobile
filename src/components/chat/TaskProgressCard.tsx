import React, { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, ListChecks } from 'lucide-react';
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
    <div className="my-2.5 rounded-xl border border-[#e5e5e5] bg-[#ffffff] overflow-hidden shadow-2xs">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-3.5 py-2.5 bg-[#fafafa] border-b border-[#f1f3f5] cursor-pointer hover:bg-[#f5f5f5] transition-colors select-none"
      >
        <div className="flex items-center gap-2">
          <ListChecks size={15} className="text-[#0060df]" />
          <span className="font-semibold text-xs text-[#151517]">
            任务步骤规划
          </span>
          <span className="text-[11px] text-[#717182]">
            {completedCount}/{steps.length} 已完成 ({progressPercent}%)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {running && (
            <div className="flex items-center gap-1 text-[11px] font-medium text-[#0060df]">
              <Loader2 size={12} className="animate-spin" />
              <span>电脑执行中</span>
            </div>
          )}
          {expanded ? (
            <ChevronDown size={14} className="text-[#717182]" />
          ) : (
            <ChevronRight size={14} className="text-[#717182]" />
          )}
        </div>
      </div>

      {/* Mini Progress Bar */}
      <div className="h-0.5 w-full bg-[#f1f3f5]">
        <div
          className="h-full bg-[#0060df] transition-all duration-300"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {expanded && (
        <div className="p-3 divide-y divide-[#f5f5f5] space-y-2">
          {steps.map((step, idx) => (
            <div key={idx} className="flex items-start gap-2.5 pt-2 first:pt-0">
              <div className="mt-0.5 shrink-0">
                {step.status === 'COMPLETED' ? (
                  <CheckCircle2 size={15} className="text-[#22c55e]" />
                ) : step.status === 'RUNNING' ? (
                  <Loader2 size={15} className="text-[#0060df] animate-spin" />
                ) : (
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-[#d4d4d4]" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-xs ${
                    step.status === 'COMPLETED'
                      ? 'text-[#717182] line-through'
                      : step.status === 'RUNNING'
                      ? 'text-[#0060df] font-semibold'
                      : 'text-[#151517]'
                  }`}
                >
                  {step.title}
                </p>
                {step.detail && (
                  <p className="text-[11px] text-[#717182] font-mono truncate mt-0.5">
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
