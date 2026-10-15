import React, { useState } from 'react';
import { HelpCircle, Check, Send } from 'lucide-react';
import { PendingPrompt, PromptQuestion } from '../../types';

interface QuestionCardProps {
  prompt: PendingPrompt;
  onSubmit: (selected: string[], customText?: string) => void;
  onCancel?: () => void;
}

export const QuestionCard: React.FC<QuestionCardProps> = ({ prompt, onSubmit, onCancel }) => {
  const isMulti = !!prompt.multiSelect;
  const questions: PromptQuestion[] = prompt.questions && prompt.questions.length > 0
    ? prompt.questions
    : [
        {
          id: prompt.questionId || 'q1',
          question: prompt.body,
          options: prompt.options.map((o) => ({ label: o })),
          multiSelect: isMulti,
        },
      ];

  // 记录每个问题的选中项
  const [selectedMap, setSelectedMap] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    questions.forEach((q) => {
      init[q.id] = [];
    });
    return init;
  });

  const [customText, setCustomText] = useState('');

  const toggleOption = (qId: string, label: string, qMulti: boolean) => {
    setSelectedMap((prev) => {
      const current = prev[qId] || [];
      if (qMulti) {
        const next = current.includes(label)
          ? current.filter((x) => x !== label)
          : [...current, label];
        return { ...prev, [qId]: next };
      } else {
        // 单选：若已选中则取消，或切换为当前项
        const next = current.includes(label) ? [] : [label];
        return { ...prev, [qId]: next };
      }
    });
  };

  // 统计所有选中的项
  const allSelected = Object.values(selectedMap).flat();
  const canSubmit = allSelected.length > 0 || customText.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(allSelected, customText.trim() || undefined);
  };

  return (
    <div className="p-5 rounded-3xl specular-card border-2 border-[#3b82f6] shadow-[0_0_30px_rgba(59,130,246,0.25)] animate-in zoom-in-95 duration-200">
      <div className="flex items-center gap-2 text-[14px] font-bold text-white">
        <HelpCircle size={18} className="text-[#38bdf8] shrink-0" />
        <span className="truncate">{prompt.title}</span>
        {isMulti && (
          <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-[#38bdf8]/15 text-[#38bdf8] font-medium ml-auto shrink-0">
            可多选
          </span>
        )}
      </div>

      <div className="mt-3.5 space-y-4">
        {questions.map((q) => {
          const selected = selectedMap[q.id] || [];
          return (
            <div key={q.id} className="space-y-2">
              {q.question && (
                <p className="text-[13px] text-[#cbd5e1] leading-relaxed whitespace-pre-wrap">
                  {q.question}
                </p>
              )}
              {q.detail && (
                <p className="text-[12px] text-[#94a3b8] bg-[#0c101a] p-3 rounded-xl border border-white/5 leading-relaxed font-mono">
                  {q.detail}
                </p>
              )}

              {/* 选项组 */}
              {q.options && q.options.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  {q.options.map((opt, i) => {
                    const isChecked = selected.includes(opt.label);
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => toggleOption(q.id, opt.label, !!q.multiSelect || isMulti)}
                        className={`min-h-[44px] px-3.5 py-2.5 rounded-xl text-[13px] font-medium text-left flex items-start gap-2.5 transition-all cursor-pointer border studio-tap ${
                          isChecked
                            ? 'bg-[#3b82f6]/20 border-[#3b82f6] text-white shadow-[0_0_15px_rgba(59,130,246,0.3)]'
                            : 'bg-[#141824] border-white/10 text-[#cbd5e1] hover:bg-[#1a2234] hover:border-white/20'
                        }`}
                      >
                        <div
                          className={`w-4 h-4 mt-0.5 rounded flex items-center justify-center shrink-0 transition-colors ${
                            q.multiSelect || isMulti ? 'rounded-[4px]' : 'rounded-full'
                          } ${
                            isChecked
                              ? 'bg-[#3b82f6] text-white'
                              : 'border border-white/30 bg-black/20'
                          }`}
                        >
                          {isChecked && <Check size={12} strokeWidth={3} />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="leading-snug break-words">{opt.label}</div>
                          {opt.description && (
                            <div className="text-[11px] text-[#94a3b8] mt-0.5 leading-tight font-normal">
                              {opt.description}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* 自由自定义输入框 */}
        <div className="pt-2">
          <textarea
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="自定义作答或补充说明（可选）..."
            rows={2}
            className="w-full px-3.5 py-2.5 rounded-xl bg-[#0c101a] border border-white/10 text-[13px] text-white placeholder-[#64748b] focus:outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6] transition-all resize-none leading-relaxed"
          />
        </div>
      </div>

      {/* 底部操作条 */}
      <div className="flex items-center justify-between gap-3 mt-4 pt-3 border-t border-white/10">
        <span className="text-[12px] text-[#94a3b8]">
          {allSelected.length > 0 ? `已选 ${allSelected.length} 项` : '可直接输入文本提交'}
        </span>
        <div className="flex items-center gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="min-h-[40px] px-3.5 py-1.5 rounded-xl border border-white/10 text-[12.5px] font-medium text-[#94a3b8] hover:bg-white/5 transition-colors cursor-pointer studio-tap"
            >
              稍后处理
            </button>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={`min-h-[40px] px-4 py-1.5 rounded-xl text-[12.5px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer studio-tap ${
              canSubmit
                ? 'bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white shadow-[0_0_20px_rgba(59,130,246,0.4)] active:scale-95'
                : 'bg-white/5 text-[#64748b] cursor-not-allowed border border-white/5'
            }`}
          >
            <span>确认提交</span>
            <Send size={13} />
          </button>
        </div>
      </div>
    </div>
  );
};
