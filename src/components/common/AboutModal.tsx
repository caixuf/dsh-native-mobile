import React, { useState } from 'react';
import { X, Info, Shield, Smartphone, RefreshCw, CheckCircle2 } from 'lucide-react';
import { APP_VERSION, APP_VERSION_CODE, APP_BUILD_DATE, APP_NAME } from '../../version';
import { DeepSeekMascot } from './DeepSeekMascot';
import { triggerHaptic } from '../../utils/haptics';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const AboutModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [checking, setChecking] = useState(false);
  const [checkedOk, setCheckedOk] = useState(false);

  if (!isOpen) return null;

  const handleCheckUpdate = () => {
    triggerHaptic('light');
    setChecking(true);
    setCheckedOk(false);
    setTimeout(() => {
      setChecking(false);
      setCheckedOk(true);
      triggerHaptic('medium');
    }, 800);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-xs transition-opacity" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in slide-in-from-bottom-6 duration-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full theme-bg-light theme-text-accent flex items-center justify-center">
              <Info size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900 leading-tight">关于软件</h3>
              <p className="text-[11px] text-gray-500">版本信息与系统架构</p>
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

        <div className="p-5 flex flex-col items-center text-center overflow-y-auto">
          {/* Logo */}
          <div className="w-20 h-20 rounded-3xl bg-blue-50/70 border border-blue-100 flex items-center justify-center p-2 mb-3 shadow-sm">
            <DeepSeekMascot size={64} />
          </div>

          <h2 className="text-lg font-bold text-gray-900">{APP_NAME}</h2>
          <div className="flex items-center gap-2 mt-1">
            <span className="px-2.5 py-0.5 rounded-full theme-badge text-xs font-mono font-semibold">
              v{APP_VERSION} (Build {APP_VERSION_CODE})
            </span>
            <span className="text-xs text-gray-400 font-mono">{APP_BUILD_DATE}</span>
          </div>

          <p className="text-xs text-gray-600 mt-3 max-w-xs leading-relaxed">
            基于 DeepSeek 智能引擎与本地大模型打造的端到端安全遥控伴侣。
            手机与电脑直连，全程端到端加密，零云端中转。
          </p>

          {/* Architecture Features */}
          <div className="w-full mt-5 space-y-2 text-left">
            <div className="p-3 rounded-2xl bg-gray-50 border border-gray-200/80 flex items-center gap-3">
              <Shield size={18} className="theme-text-accent shrink-0" />
              <div className="text-xs">
                <div className="font-bold text-gray-900">端到端加密通道</div>
                <div className="text-gray-500 text-[11px]">局域网安全直连，指令与会话不经第三方服务器</div>
              </div>
            </div>

            <div className="p-3 rounded-2xl bg-gray-50 border border-gray-200/80 flex items-center gap-3">
              <Smartphone size={18} className="theme-text-accent shrink-0" />
              <div className="text-xs">
                <div className="font-bold text-gray-900">原生前台保活中继</div>
                <div className="text-gray-500 text-[11px]">息屏与切后台仍可接收远端通知与一键回执</div>
              </div>
            </div>
          </div>

          {/* Check update button */}
          <div className="w-full mt-4">
            <button
              type="button"
              onClick={handleCheckUpdate}
              disabled={checking}
              className="w-full py-2.5 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 text-gray-800 text-xs font-semibold flex items-center justify-center gap-2 shadow-2xs transition-colors cursor-pointer"
            >
              {checking ? (
                <>
                  <RefreshCw size={14} className="animate-spin text-blue-600" />
                  <span>正在检查新版本…</span>
                </>
              ) : checkedOk ? (
                <>
                  <CheckCircle2 size={14} className="text-emerald-600" />
                  <span>当前已是最新版本 (v{APP_VERSION})</span>
                </>
              ) : (
                <>
                  <RefreshCw size={14} className="text-gray-500" />
                  <span>检查版本更新</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div className="p-4 border-t border-gray-100 bg-gray-50/60">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-3 rounded-xl theme-btn-primary font-semibold text-sm transition-all shadow-md shadow-blue-500/20 active:scale-[0.99] cursor-pointer"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
