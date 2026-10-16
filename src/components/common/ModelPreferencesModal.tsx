import React, { useState } from 'react';
import { X, Cpu, Sparkles, Check, Flame } from 'lucide-react';
import { triggerHaptic } from '../../utils/haptics';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const PREF_KEY = 'dsh_model_preferences';

export interface ModelPreferences {
  defaultModel: string;
  deepThinking: boolean;
  streamingAnimation: boolean;
}

export const loadModelPreferences = (): ModelPreferences => {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    defaultModel: 'MiniMax-M3.1',
    deepThinking: true,
    streamingAnimation: true,
  };
};

export const saveModelPreferences = (p: ModelPreferences) => {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {}
};

export const ModelPreferencesModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [prefs, setPrefs] = useState<ModelPreferences>(loadModelPreferences);

  if (!isOpen) return null;

  const update = (partial: Partial<ModelPreferences>) => {
    triggerHaptic('light');
    const next = { ...prefs, ...partial };
    setPrefs(next);
    saveModelPreferences(next);
  };

  const models = [
    { id: 'MiniMax-M3.1', name: 'MiniMax M3.1 Flash', desc: '极速响应，智能全能，超大上下文' },
    { id: 'DeepSeek-V3', name: 'DeepSeek V3 (MoE)', desc: '强大指令遵循与工程编码能力' },
    { id: 'DeepSeek-R1', name: 'DeepSeek R1 (Reasoning)', desc: '深度思考推理，擅长严密逻辑分析' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-xs transition-opacity" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in slide-in-from-bottom-6 duration-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full theme-bg-light theme-text-accent flex items-center justify-center">
              <Cpu size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900 leading-tight">模型推理与偏好设置</h3>
              <p className="text-[11px] text-gray-500">定制移动端的推理策略与呈现效果</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          {/* Default Model */}
          <div>
            <div className="text-[12px] font-semibold text-gray-600 px-1 mb-2 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles size={13} className="theme-text-accent" />
              <span>默认会话模型</span>
            </div>
            <div className="space-y-2">
              {models.map((m) => {
                const isSelected = prefs.defaultModel === m.id;
                return (
                  <div
                    key={m.id}
                    onClick={() => update({ defaultModel: m.id })}
                    className={`flex items-center justify-between p-3 rounded-2xl border transition-all cursor-pointer ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500/20'
                        : 'border-gray-200 bg-gray-50/50 hover:bg-white'
                    }`}
                  >
                    <div>
                      <div className="text-sm font-bold text-gray-900">{m.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{m.desc}</div>
                    </div>
                    {isSelected && (
                      <div className="w-5 h-5 rounded-full theme-bg-accent text-white flex items-center justify-center">
                        <Check size={12} strokeWidth={3} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Reasoning & Display Toggles */}
          <div className="pt-2 border-t border-gray-100 space-y-3">
            <div className="text-[12px] font-semibold text-gray-600 px-1 uppercase tracking-wider">
              <span>交互与输出呈现</span>
            </div>

            <div
              onClick={() => update({ deepThinking: !prefs.deepThinking })}
              className="flex items-center justify-between p-3 rounded-2xl bg-gray-50 border border-gray-200/80 cursor-pointer"
            >
              <div>
                <div className="text-sm font-semibold text-gray-900">显示完整思考推理过程</div>
                <div className="text-xs text-gray-500 mt-0.5">实时展开模型在生成答案前的思维链</div>
              </div>
              <input
                type="checkbox"
                checked={prefs.deepThinking}
                onChange={() => {}}
                className="w-5 h-5 accent-[#0c7ff2] rounded cursor-pointer"
              />
            </div>

            <div
              onClick={() => update({ streamingAnimation: !prefs.streamingAnimation })}
              className="flex items-center justify-between p-3 rounded-2xl bg-gray-50 border border-gray-200/80 cursor-pointer"
            >
              <div>
                <div className="text-sm font-semibold text-gray-900">流式打字平滑光标</div>
                <div className="text-xs text-gray-500 mt-0.5">文本增量到达时显示优雅呼吸光标</div>
              </div>
              <input
                type="checkbox"
                checked={prefs.streamingAnimation}
                onChange={() => {}}
                className="w-5 h-5 accent-[#0c7ff2] rounded cursor-pointer"
              />
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-gray-100 bg-gray-50/60">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-3 rounded-xl theme-btn-primary font-semibold text-sm transition-all shadow-md shadow-blue-500/20 active:scale-[0.99] cursor-pointer"
          >
            保存并返回
          </button>
        </div>
      </div>
    </div>
  );
};
