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
    <div className="my-3 rounded-2xl bg-[#f4f4f6] border border-gray-200/80 overflow-hidden shadow-2xs">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors select-none"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-lg bg-[#f4f4f6] flex items-center justify-center text-blue-600">
            <ListChecks size={14} />
          </div>
          <span className="font-semibold text-xs tracking-wide text-[#18181b]">
            规划执行步骤
          </span>
          <span className="text-[11px] font-mono text-[#52525b] bg-[#f4f4f6] px-2 py-0.5 rounded-full border border-gray-200">
            {completedCount}/{steps.length} ({progressPercent}%)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {running && (
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-blue-700 bg-blue-50 px-2.5 py-0.5 rounded-full border border-blue-200">
              <Loader2 size={12} className="animate-spin" />
              <span>电脑执行中</span>
            </div>
          )}
          <div className="text-[#52525b] hover:text-black transition-colors">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
        </div>
      </div>

      {/* Progress Line */}
      <div className="h-1 w-full bg-gray-200">
        <div
          className="h-full bg-black transition-all duration-300"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {expanded && (
        <div className="p-3.5 space-y-2.5 bg-[#f4f4f6]">
          {steps.map((step, idx) => (
            <div key={idx} className="flex items-start gap-2.5 group">
              <div className="mt-0.5 shrink-0">
                {step.status === 'COMPLETED' ? (
                  <CheckCircle2 size={15} className="text-emerald-700" />
                ) : step.status === 'RUNNING' ? (
                  <Loader2 size={15} className="text-blue-600 animate-spin" />
                ) : (
                  <div className="w-3.5 h-3.5 rounded-full border border-gray-300 bg-white" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-xs leading-relaxed ${
                    step.status === 'COMPLETED'
                      ? 'text-[#52525b] line-through'
                      : step.status === 'RUNNING'
                      ? 'text-blue-700 font-semibold'
                      : 'text-[#18181b]'
                  }`}
                >
                  {step.title}
                </p>
                {step.detail && (
                  <p className="text-[11px] text-gray-600 font-mono truncate mt-0.5 bg-white px-2 py-0.5 rounded border border-gray-200">
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
