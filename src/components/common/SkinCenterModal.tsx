import React, { useState, useRef } from 'react';
import { X, Check, Palette, Sparkles, Image as ImageIcon, Sliders, Trash2, UploadCloud } from 'lucide-react';
import { THEME_PRESETS, ThemeStore, ThemeConfig } from '../../services/theme';
import { triggerHaptic } from '../../utils/haptics';

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
  const [wallpaper, setWallpaper] = useState(() => ThemeStore.getCustomWallpaper());
  const [compressing, setCompressing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleSelectFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setCompressing(true);
      triggerHaptic('light');
      const dataUrl = await ThemeStore.compressImage(file);
      ThemeStore.setCustomWallpaper(dataUrl, wallpaper.blur, wallpaper.opacity);
      setWallpaper({ ...wallpaper, data: dataUrl });
      triggerHaptic('medium');
    } catch (err) {
      console.error('Wallpaper compression failed:', err);
      alert('壁纸图片处理失败，请重试');
    } finally {
      setCompressing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleClearWallpaper = () => {
    triggerHaptic('light');
    ThemeStore.clearCustomWallpaper();
    setWallpaper({ data: null, blur: 0, opacity: 15 });
  };

  const handleBlurChange = (val: number) => {
    const next = { ...wallpaper, blur: val };
    setWallpaper(next);
    ThemeStore.setCustomWallpaper(next.data, next.blur, next.opacity);
  };

  const handleOpacityChange = (val: number) => {
    const next = { ...wallpaper, opacity: val };
    setWallpaper(next);
    ThemeStore.setCustomWallpaper(next.data, next.blur, next.opacity);
  };

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
            <div className="w-8 h-8 rounded-full theme-bg-light theme-text-accent flex items-center justify-center">
              <Palette size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900 leading-tight">个性装扮 · 皮肤中心</h3>
              <p className="text-[11px] text-gray-500">仿照现代主流体验，精选 QQ / DeepSeek 配色与自定义壁纸</p>
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

        {/* 滚动内容区域 */}
        <div className="p-4 space-y-4 overflow-y-auto">
          {/* 1. 配色预设 */}
          <div>
            <div className="text-[12px] font-semibold text-gray-600 px-1 mb-2.5 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles size={13} className="theme-text-accent" />
              <span>官方精选配色</span>
            </div>

            <div className="space-y-2.5">
              {THEME_PRESETS.map((theme) => {
                const isSelected = theme.id === currentThemeId;
                return (
                  <div
                    key={theme.id}
                    onClick={() => {
                      triggerHaptic('light');
                      onSelectTheme(theme.id);
                    }}
                    className={`relative flex items-center gap-3.5 p-3.5 rounded-2xl border transition-all cursor-pointer ${
                      isSelected
                        ? 'theme-border-accent theme-bg-light border-blue-500 bg-blue-50/50 shadow-sm ring-1 ring-blue-500/20'
                        : 'border-gray-200 hover:border-gray-300 bg-gray-50/50 hover:bg-white'
                    }`}
                  >
                    {/* 渐变色块预览 */}
                    <div
                      style={{ background: theme.gradient }}
                      className="w-11 h-11 rounded-xl shrink-0 shadow-sm flex items-center justify-center text-white"
                    >
                      <Sparkles size={16} className="opacity-90" />
                    </div>

                    {/* 皮肤信息 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-gray-900">{theme.name}</span>
                        {isSelected && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold theme-btn-primary rounded-md">
                            使用中
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 line-clamp-1 mt-0.5">{theme.description}</p>
                    </div>

                    {/* 勾选图标 */}
                    <div
                      className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                        isSelected ? 'theme-bg-accent text-white' : 'border border-gray-300'
                      }`}
                    >
                      {isSelected && <Check size={14} strokeWidth={2.5} />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 2. 自定义背景壁纸 (Issue #5) */}
          <div className="pt-2 border-t border-gray-100">
            <div className="text-[12px] font-semibold text-gray-600 px-1 mb-2.5 uppercase tracking-wider flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <ImageIcon size={13} className="theme-text-accent" />
                <span>自定义背景壁纸</span>
              </div>
              {wallpaper.data && (
                <button
                  type="button"
                  onClick={handleClearWallpaper}
                  className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1 cursor-pointer"
                >
                  <Trash2 size={12} />
                  <span>移除壁纸</span>
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleSelectFile}
            />

            {!wallpaper.data ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={compressing}
                className="w-full py-5 rounded-2xl border-2 border-dashed border-gray-200 hover:border-blue-400 bg-gray-50/70 hover:bg-blue-50/30 flex flex-col items-center justify-center gap-2 transition-all cursor-pointer group"
              >
                <div className="w-10 h-10 rounded-full bg-white shadow-2xs flex items-center justify-center text-gray-500 group-hover:text-blue-600">
                  <UploadCloud size={20} />
                </div>
                <div className="text-center">
                  <span className="text-xs font-semibold text-gray-800">
                    {compressing ? '正在压缩处理图片…' : '从相册上传图片设为背景'}
                  </span>
                  <p className="text-[11px] text-gray-400 mt-0.5">自动压缩与缩放，丝滑运行不占内存</p>
                </div>
              </button>
            ) : (
              <div className="p-3.5 rounded-2xl bg-gray-50 border border-gray-200/80 space-y-3.5">
                <div className="flex items-center gap-3">
                  <div
                    className="w-14 h-14 rounded-xl bg-cover bg-center shrink-0 border border-gray-200 shadow-2xs"
                    style={{ backgroundImage: `url(${wallpaper.data})` }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-gray-900">当前壁纸已生效</div>
                    <p className="text-[11px] text-gray-500 mt-0.5">已作为主界面与聊天页背景</p>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="mt-1 text-[11px] font-semibold theme-text-accent hover:underline cursor-pointer"
                    >
                      更换其他图片
                    </button>
                  </div>
                </div>

                {/* 调节滑块 */}
                <div className="space-y-2 pt-2 border-t border-gray-200/60 text-xs text-gray-600">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Sliders size={13} />
                      <span>背景透明度</span>
                    </span>
                    <span className="font-mono font-medium text-gray-900">{wallpaper.opacity}%</span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="60"
                    step="5"
                    value={wallpaper.opacity}
                    onChange={(e) => handleOpacityChange(Number(e.target.value))}
                    className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-[#0c7ff2]"
                  />

                  <div className="flex items-center justify-between pt-1">
                    <span className="flex items-center gap-1.5">
                      <Sliders size={13} />
                      <span>背景模糊度</span>
                    </span>
                    <span className="font-mono font-medium text-gray-900">{wallpaper.blur}px</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="16"
                    step="2"
                    value={wallpaper.blur}
                    onChange={(e) => handleBlurChange(Number(e.target.value))}
                    className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-[#0c7ff2]"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 底部确认栏 */}
        <div className="p-4 border-t border-gray-100 bg-gray-50/60">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-3 rounded-xl theme-btn-primary font-semibold text-sm transition-all shadow-md shadow-blue-500/20 active:scale-[0.99] cursor-pointer"
          >
            完成并应用
          </button>
        </div>
      </div>
    </div>
  );
};
