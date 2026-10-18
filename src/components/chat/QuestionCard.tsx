import React, { useState } from 'react';
import { HelpCircle, Check, Send } from 'lucide-react';
import { PendingPrompt, PromptQuestion } from '../../types';

export interface QuestionAnswerItem {
  id: string;
  selected: string[];
  text?: string;
}

interface QuestionCardProps {
  prompt: PendingPrompt;
  onSubmit: (selected: QuestionAnswerItem[] | string[], customText?: string) => void;
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
    if (questions.length > 1) {
      const answers: QuestionAnswerItem[] = questions.map((q) => ({
        id: q.id,
        selected: selectedMap[q.id] || [],
        ...(customText.trim() ? { text: customText.trim() } : {}),
      }));
      onSubmit(answers, customText.trim() || undefined);
    } else {
      onSubmit(allSelected, customText.trim() || undefined);
    }
  };

  return (
    <div className="p-5 rounded-3xl bg-[#f4f4f6] border border-gray-200/80 shadow-xs animate-in zoom-in-95 duration-200">
      <div className="flex items-center gap-2 text-[14px] font-bold text-[#18181b]">
        <HelpCircle size={18} className="text-blue-600 shrink-0" />
        <span className="truncate">{prompt.title}</span>
        {isMulti && (
          <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-semibold ml-auto shrink-0">
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
                <p className="text-[13px] text-gray-700 leading-relaxed whitespace-pre-wrap">
                  {q.question}
                </p>
              )}
              {q.detail && (
                <p className="text-[12px] text-gray-600 bg-white p-3 rounded-xl border border-gray-200 leading-relaxed font-mono">
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
                        className={`min-h-[44px] px-3.5 py-2.5 rounded-2xl text-[13px] font-medium text-left flex items-start gap-2.5 transition-all cursor-pointer border ${
                          isChecked
                            ? 'bg-white border-2 border-black text-[#18181b] shadow-xs'
                            : 'bg-white border border-gray-200/80 text-gray-800 hover:border-gray-400'
                        }`}
                      >
                        <div
                          className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 mt-0.5 transition-all ${
                            isChecked
                              ? 'bg-black text-white'
                              : 'border border-gray-300 bg-white'
                          }`}
                        >
                          {isChecked && <Check size={13} strokeWidth={3} />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium leading-tight">{opt.label}</div>
                          {opt.description && (
                            <div className="text-[11px] text-[#52525b] mt-1 leading-normal font-normal">
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

        {/* 自定义输入框（可选补充说明） */}
        <div className="pt-2">
          <input
            type="text"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="补充说明或自定义要求（可选）..."
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                handleSubmit();
              }
            }}
            className="w-full px-3.5 py-2.5 text-[13px] bg-white border border-gray-200 rounded-xl focus:outline-hidden focus:border-black focus:ring-1 focus:ring-black/20 text-[#18181b] placeholder:text-[#52525b]"
          />
        </div>

        {/* 底部提交/取消操作栏 */}
        <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-gray-200/60">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="min-h-[44px] px-4 py-2 rounded-full text-[12.5px] font-medium text-[#52525b] hover:text-black hover:bg-gray-200 transition-colors cursor-pointer"
            >
              取消
            </button>
          )}
          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className={`min-h-[44px] px-5 py-2 rounded-full text-[13px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              canSubmit
                ? 'bg-black text-white hover:bg-neutral-800 shadow-xs'
                : 'bg-gray-200 text-[#52525b] cursor-not-allowed'
            }`}
          >
            <span>确定提交</span>
            <Send size={13} />
          </button>
        </div>
      </div>
    </div>
  );
};
