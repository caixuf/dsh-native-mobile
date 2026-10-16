import React, { useState } from 'react';
import { X, ShieldCheck, CheckCircle2, Bell, Vibrate, Trash2 } from 'lucide-react';
import { createAnsweredLedger } from '../../services/store';
import { triggerHaptic } from '../../utils/haptics';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const APPROVAL_CONFIG_KEY = 'dsh_approval_config';

export interface ApprovalConfig {
  autoApproveReadOnly: boolean;
  hapticFeedback: boolean;
  notifySound: boolean;
}

export const loadApprovalConfig = (): ApprovalConfig => {
  try {
    const raw = localStorage.getItem(APPROVAL_CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    autoApproveReadOnly: false,
    hapticFeedback: true,
    notifySound: true,
  };
};

export const saveApprovalConfig = (c: ApprovalConfig) => {
  try {
    localStorage.setItem(APPROVAL_CONFIG_KEY, JSON.stringify(c));
  } catch {}
};

export const ApprovalSettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [config, setConfig] = useState<ApprovalConfig>(loadApprovalConfig);
  const [clearedNotice, setClearedNotice] = useState(false);

  if (!isOpen) return null;

  const update = (partial: Partial<ApprovalConfig>) => {
    triggerHaptic('light');
    const next = { ...config, ...partial };
    setConfig(next);
    saveApprovalConfig(next);
  };

  const handleClearLedger = () => {
    triggerHaptic('medium');
    const ledger = createAnsweredLedger(localStorage);
    ledger.clear();
    setClearedNotice(true);
    setTimeout(() => setClearedNotice(false), 2500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-xs transition-opacity" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in slide-in-from-bottom-6 duration-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full theme-bg-light theme-text-accent flex items-center justify-center">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900 leading-tight">权限与自动化审批</h3>
              <p className="text-[11px] text-gray-500">配置安全放行规则与远端交互提醒</p>
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
          {/* Security automation */}
          <div className="space-y-2.5">
            <div className="text-[12px] font-semibold text-gray-600 px-1 uppercase tracking-wider">
              <span>审批自动化策略</span>
            </div>

            <div
              onClick={() => update({ autoApproveReadOnly: !config.autoApproveReadOnly })}
              className="flex items-center justify-between p-3.5 rounded-2xl bg-gray-50 border border-gray-200/80 cursor-pointer"
            >
              <div className="pr-2">
                <div className="text-sm font-semibold text-gray-900">自动放行只读安全命令</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  对 <code>git status</code>、<code>ls</code> 等只读命令免弹窗直接执行
                </div>
              </div>
              <input
                type="checkbox"
                checked={config.autoApproveReadOnly}
                onChange={() => {}}
                className="w-5 h-5 accent-[#0c7ff2] rounded cursor-pointer shrink-0"
              />
            </div>
          </div>

          {/* Feedback & Notifications */}
          <div className="pt-2 border-t border-gray-100 space-y-2.5">
            <div className="text-[12px] font-semibold text-gray-600 px-1 uppercase tracking-wider">
              <span>审批触感与声音</span>
            </div>

            <div
              onClick={() => update({ hapticFeedback: !config.hapticFeedback })}
              className="flex items-center justify-between p-3.5 rounded-2xl bg-gray-50 border border-gray-200/80 cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <Vibrate size={18} className="text-gray-600" />
                <div>
                  <div className="text-sm font-semibold text-gray-900">按键触觉震动反馈</div>
                  <div className="text-xs text-gray-500 mt-0.5">点击允许/拒绝或切换选项时轻触震动</div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={config.hapticFeedback}
                onChange={() => {}}
                className="w-5 h-5 accent-[#0c7ff2] rounded cursor-pointer shrink-0"
              />
            </div>

            <div
              onClick={() => update({ notifySound: !config.notifySound })}
              className="flex items-center justify-between p-3.5 rounded-2xl bg-gray-50 border border-gray-200/80 cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <Bell size={18} className="text-gray-600" />
                <div>
                  <div className="text-sm font-semibold text-gray-900">审批通知提示音</div>
                  <div className="text-xs text-gray-500 mt-0.5">收到新的人工审批请求时响铃提醒</div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={config.notifySound}
                onChange={() => {}}
                className="w-5 h-5 accent-[#0c7ff2] rounded cursor-pointer shrink-0"
              />
            </div>
          </div>

          {/* Ledger Cleanup */}
          <div className="pt-2 border-t border-gray-100">
            <div className="text-[12px] font-semibold text-gray-600 px-1 mb-2 uppercase tracking-wider">
              <span>已应答记录与免打扰台账</span>
            </div>
            <div className="p-3.5 rounded-2xl bg-gray-50 border border-gray-200/80 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-gray-900">清空已应答历史缓存</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {clearedNotice ? '已成功重置台账记录' : '重置本地已应答事件去重账本'}
                </div>
              </div>
              <button
                type="button"
                onClick={handleClearLedger}
                className="px-3 py-1.5 rounded-xl bg-white hover:bg-gray-100 border border-gray-200 text-xs font-semibold text-red-600 shadow-2xs transition-colors cursor-pointer flex items-center gap-1.5 shrink-0"
              >
                <Trash2 size={13} />
                <span>清空</span>
              </button>
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-gray-100 bg-gray-50/60">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-3 rounded-xl theme-btn-primary font-semibold text-sm transition-all shadow-md shadow-blue-500/20 active:scale-[0.99] cursor-pointer"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};
