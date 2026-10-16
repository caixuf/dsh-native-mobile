import React, { useState } from 'react';
import { X, ChevronRight, Monitor, Settings, ShieldCheck, HardDrive, Info, LogOut, Sparkles, Palette } from 'lucide-react';
import { DeepSeekMascot } from './DeepSeekMascot';
import { ConnectionDot } from './ConnectionDot';
import { triggerHaptic } from '../../utils/haptics';
import { ThemeStore, THEME_PRESETS } from '../../services/theme';
import { SkinCenterModal } from './SkinCenterModal';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  username?: string;
  hostName?: string;
  isOnline?: boolean;
  onManageHosts?: () => void;
  onDisconnect?: () => void;
}

export const UserCenterModal: React.FC<Props> = ({
  isOpen,
  onClose,
  username = 'caixuf',
  hostName = 'caixuf.Windows',
  isOnline = true,
  onManageHosts,
  onDisconnect,
}) => {
  const [skinModalOpen, setSkinModalOpen] = useState(false);
  const [themeId, setThemeId] = useState(() => ThemeStore.getThemeId());

  if (!isOpen) return null;

  const currentTheme = THEME_PRESETS.find((t) => t.id === themeId) || THEME_PRESETS[0];

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Dimmed Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity animate-in fade-in"
        onClick={onClose}
      />

      {/* Sheet Container */}
      <div className="relative z-50 w-full max-w-lg bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[90vh] flex flex-col overflow-hidden animate-in slide-in-from-bottom-6 duration-200">
        {/* Header with Close */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2 border-b border-gray-100">
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="w-9 h-9 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-700 transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
          <span className="text-[15px] font-semibold text-gray-900">个人中心</span>
          <div className="w-9" />
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto px-5 py-6 space-y-6">
          {/* Avatar & User Header */}
          <div className="flex flex-col items-center text-center">
            <div className="w-20 h-20 rounded-full bg-blue-50 border-2 border-blue-100 flex items-center justify-center shadow-xs mb-3 relative">
              <DeepSeekMascot size={64} className="scale-110" />
              <span className="absolute bottom-0 right-0 w-5 h-5 rounded-full bg-green-500 border-2 border-white shadow-xs" />
            </div>
            <h2 className="text-[20px] font-bold text-gray-900">{username}</h2>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 mt-2 rounded-full bg-gray-100 text-[12px] font-medium text-gray-600">
              <ConnectionDot status={isOnline ? 'online' : 'offline'} size={6} />
              <span>{hostName}</span>
            </div>
          </div>

          {/* Quick Connection Card */}
          <div className="p-4 rounded-2xl bg-[#f4f4f6] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-blue-600 shadow-xs">
                <Monitor size={20} />
              </div>
              <div>
                <div className="text-[14px] font-semibold text-gray-900">工作站连接</div>
                <div className="text-[12px] text-[#52525b] mt-0.5">
                  {isOnline ? '端到端加密通道正常运行' : '未连接到电脑端'}
                </div>
              </div>
            </div>
            {onManageHosts && (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  onManageHosts();
                  onClose();
                }}
                className="px-3 py-1.5 rounded-full bg-white hover:bg-gray-50 border border-gray-200 text-xs font-semibold text-gray-800 shadow-2xs transition-colors cursor-pointer"
              >
                切换主机
              </button>
            )}
          </div>

          {/* Settings Section 1 */}
          <div className="rounded-2xl bg-[#f4f4f6] overflow-hidden divide-y divide-gray-200/60">
            {/* 个性装扮 · 皮肤中心 (现代 QQ / DeepSeek 配色) */}
            <div
              onClick={() => {
                triggerHaptic('light');
                setSkinModalOpen(true);
              }}
              className="flex items-center justify-between px-4 py-3.5 hover:bg-gray-200/50 cursor-pointer transition-colors"
            >
              <div className="flex items-center gap-3">
                <Palette size={18} className="text-[#0c7ff2]" />
                <span className="text-[14px] font-medium text-gray-800">个性装扮 · 皮肤中心</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] font-medium px-2 py-0.5 rounded-md bg-blue-100/70 text-[#0c7ff2]">
                  {currentTheme.name}
                </span>
                <ChevronRight size={16} className="text-[#52525b]" />
              </div>
            </div>

            <div
              onClick={() => {
                triggerHaptic('light');
                if (onManageHosts) {
                  onManageHosts();
                  onClose();
                }
              }}
              className="flex items-center justify-between px-4 py-3.5 hover:bg-gray-200/50 cursor-pointer transition-colors"
            >
              <div className="flex items-center gap-3">
                <HardDrive size={18} className="text-gray-600" />
                <span className="text-[14px] font-medium text-gray-800">已配对的远程设备</span>
              </div>
              <ChevronRight size={16} className="text-[#52525b]" />
            </div>

            <div
              onClick={() => triggerHaptic('light')}
              className="flex items-center justify-between px-4 py-3.5 hover:bg-gray-200/50 cursor-pointer transition-colors"
            >
              <div className="flex items-center gap-3">
                <Settings size={18} className="text-gray-600" />
                <span className="text-[14px] font-medium text-gray-800">模型推理与偏好设置</span>
              </div>
              <ChevronRight size={16} className="text-[#52525b]" />
            </div>

            <div
              onClick={() => triggerHaptic('light')}
              className="flex items-center justify-between px-4 py-3.5 hover:bg-gray-200/50 cursor-pointer transition-colors"
            >
              <div className="flex items-center gap-3">
                <ShieldCheck size={18} className="text-gray-600" />
                <span className="text-[14px] font-medium text-gray-800">权限与自动化审批</span>
              </div>
              <ChevronRight size={16} className="text-[#52525b]" />
            </div>
          </div>

          {/* Settings Section 2 */}
          <div className="rounded-2xl bg-[#f4f4f6] overflow-hidden divide-y divide-gray-200/60">
            <div
              onClick={() => triggerHaptic('light')}
              className="flex items-center justify-between px-4 py-3.5 hover:bg-gray-200/50 cursor-pointer transition-colors"
            >
              <div className="flex items-center gap-3">
                <Info size={18} className="text-gray-600" />
                <span className="text-[14px] font-medium text-gray-800">关于 DSH Remote 移动遥控伴侣</span>
              </div>
              <span className="text-[12px] text-[#52525b] font-mono">v1.1.1</span>
            </div>
          </div>

          {/* Disconnect Button */}
          {onDisconnect && (
            <button
              type="button"
              onClick={() => {
                triggerHaptic('medium');
                onDisconnect();
                onClose();
              }}
              className="w-full py-3.5 rounded-2xl bg-red-50 hover:bg-red-100 text-red-600 font-medium text-[14px] flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <LogOut size={16} />
              <span>断开当前远程连接</span>
            </button>
          )}
        </div>

        {/* 皮肤选择弹窗 */}
        <SkinCenterModal
          isOpen={skinModalOpen}
          onClose={() => setSkinModalOpen(false)}
          currentThemeId={themeId}
          onSelectTheme={(id) => {
            ThemeStore.setTheme(id);
            setThemeId(id);
          }}
        />
      </div>
    </div>
  );
};
