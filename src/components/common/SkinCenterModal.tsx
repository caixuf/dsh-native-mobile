import React from 'react';
import { X, Check, Palette, Sparkles } from 'lucide-react';
import { THEME_PRESETS, ThemeConfig } from '../../services/theme';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentThemeId: string;
  onSelectTheme: (id: string) => void;
}

export const SkinCenterModal: React.FC<Props> = ({
  isOpen,
  onClose,
  currentThemeId,
  onSelectTheme,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* 蒙层 */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-xs transition-opacity"
        onClick={onClose}
      />

      {/* 底部面板 */}
      <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh] animate-in slide-in-from-bottom-6 duration-200">
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
              <Palette size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900 leading-tight">个性装扮 · 皮肤中心</h3>
              <p className="text-[11px] text-gray-500">仿照现代主流体验，精选现代 QQ 与 DeepSeek 色彩</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 flex items-center justify-center transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* 皮肤选择网格 */}
        <div className="p-4 space-y-3 overflow-y-auto">
          {THEME_PRESETS.map((theme) => {
            const isSelected = theme.id === currentThemeId;
            return (
              <div
                key={theme.id}
                onClick={() => onSelectTheme(theme.id)}
                className={`relative flex items-center gap-3.5 p-3.5 rounded-2xl border transition-all cursor-pointer ${
                  isSelected
                    ? 'border-blue-500 bg-blue-50/40 shadow-sm ring-1 ring-blue-500/20'
                    : 'border-gray-200 hover:border-gray-300 bg-gray-50/50 hover:bg-white'
                }`}
              >
                {/* 渐变色块预览 */}
                <div
                  style={{ background: theme.gradient }}
                  className="w-12 h-12 rounded-xl shrink-0 shadow-sm flex items-center justify-center text-white"
                >
                  <Sparkles size={16} className="opacity-90" />
                </div>

                {/* 皮肤信息 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-gray-900">{theme.name}</span>
                    {isSelected && (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-blue-600 text-white rounded-md">
                        当前使用
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 line-clamp-1 mt-0.5">{theme.description}</p>
                </div>

                {/* 勾选图标 */}
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                    isSelected ? 'bg-blue-600 text-white' : 'border border-gray-300'
                  }`}
                >
                  {isSelected && <Check size={14} strokeWidth={2.5} />}
                </div>
              </div>
            );
          })}
        </div>

        {/* 底部确认栏 */}
        <div className="p-4 border-t border-gray-100 bg-gray-50/60">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-3 rounded-xl bg-[#0c7ff2] hover:bg-[#0066ff] text-white font-semibold text-sm transition-colors shadow-md shadow-blue-500/20 active:scale-[0.99]"
          >
            完成并应用
          </button>
        </div>
      </div>
    </div>
  );
};
