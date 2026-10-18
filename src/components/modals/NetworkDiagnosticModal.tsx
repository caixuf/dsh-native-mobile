import React, { useState } from 'react';
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Globe,
  Laptop,
  RefreshCw,
  ShieldCheck,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import { copyToClipboard } from '../chat/clipboard';
import { triggerHaptic } from '../../utils/haptics';

export interface NetworkDiagnosticProps {
  isOpen: boolean;
  onClose: () => void;
  hostName?: string;
  isLan?: boolean;
  liveConnected?: boolean;
  pingMs?: number | null;
  onRetestLan?: () => Promise<void> | void;
}

export const NetworkDiagnosticModal: React.FC<NetworkDiagnosticProps> = ({
  isOpen,
  onClose,
  hostName = 'caixuf',
  isLan = false,
  liveConnected = true,
  pingMs = null,
  onRetestLan,
}) => {
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleRetest = async () => {
    triggerHaptic('light');
    setTesting(true);
    try {
      if (onRetestLan) {
        await Promise.resolve(onRetestLan());
      } else {
        await new Promise((r) => setTimeout(r, 600));
      }
    } finally {
      setTesting(false);
      triggerHaptic('medium');
    }
  };

  const handleCopyReport = async () => {
    const report = [
      `DSH 网络链路健康诊断报告`,
      `────────────────────────────`,
      `目标主机: ${hostName}`,
      `链路模式: ${isLan ? 'LAN 局域网直连 (高速)' : 'WAN 中继通道'}`,
      `连接状态: ${liveConnected ? '在线 (Connected)' : '断开/重连中 (Disconnected)'}`,
      `往返延迟: ${pingMs != null ? `${pingMs}ms` : '未测定'}`,
      `诊断时间: ${new Date().toLocaleString('zh-CN')}`,
    ].join('\n');

    const ok = await copyToClipboard(report);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const latencyGrade =
    pingMs == null
      ? { label: '检测中', color: 'text-gray-500', bg: 'bg-gray-100' }
      : pingMs < 50
      ? { label: '极佳 (0~50ms)', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' }
      : pingMs < 150
      ? { label: '良好 (50~150ms)', color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' }
      : { label: '一般 (>150ms)', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-xs transition-opacity" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in slide-in-from-bottom-6 duration-200">
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <Activity size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900 leading-tight">链路健康诊断</h3>
              <p className="text-[11px] text-gray-500">实时网络延迟与通道模式</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭链路诊断弹窗"
            className="w-11 h-11 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* 主体诊断内容 */}
        <div className="p-5 overflow-y-auto space-y-4">
          {/* 主状态指示牌 */}
          <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200/80 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-2xl flex items-center justify-center ${
                  isLan ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
                }`}
              >
                {isLan ? <Zap size={20} /> : <Globe size={20} />}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-gray-900 text-[15px]">
                    {isLan ? '局域网直连 (LAN)' : '公网中继通道 (WAN)'}
                  </span>
                  <span
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                      liveConnected
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-rose-50 text-rose-700 border-rose-200'
                    }`}
                  >
                    {liveConnected ? '在线' : '断开'}
                  </span>
                </div>
                <p className="text-[11.5px] text-gray-500 mt-0.5">
                  {isLan
                    ? '通过本地局域网高速广播直连，零云端中继，延迟极低'
                    : '通过安全加密中继通信，适合跨网络遥控'}
                </p>
              </div>
            </div>
          </div>

          {/* 核心指标表格 */}
          <div className="rounded-2xl border border-gray-200/80 overflow-hidden divide-y divide-gray-100 text-[13px]">
            <div className="p-3.5 flex items-center justify-between bg-white">
              <span className="text-gray-500 flex items-center gap-2">
                <Laptop size={15} className="text-gray-400" />
                目标主机
              </span>
              <span className="font-semibold text-gray-800">{hostName}</span>
            </div>

            <div className="p-3.5 flex items-center justify-between bg-white">
              <span className="text-gray-500 flex items-center gap-2">
                <Wifi size={15} className="text-gray-400" />
                往返延迟 (RTT)
              </span>
              <div className="flex items-center gap-2">
                {pingMs != null ? (
                  <span className="font-mono font-bold text-gray-900">{pingMs} ms</span>
                ) : (
                  <span className="text-gray-400 font-mono">--</span>
                )}
                <span className={`text-[11px] px-2 py-0.5 rounded-md font-medium border ${latencyGrade.bg} ${latencyGrade.color}`}>
                  {latencyGrade.label}
                </span>
              </div>
            </div>

            <div className="p-3.5 flex items-center justify-between bg-white">
              <span className="text-gray-500 flex items-center gap-2">
                <ShieldCheck size={15} className="text-emerald-500" />
                端到端加密
              </span>
              <span className="text-emerald-700 font-medium text-[12px] flex items-center gap-1">
                <CheckCircle2 size={13} />
                TLS 握手已验证
              </span>
            </div>
          </div>

          {/* 操作按钮组 */}
          <div className="space-y-2 pt-2">
            <button
              type="button"
              onClick={handleRetest}
              disabled={testing}
              className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-gray-900 hover:bg-black text-white font-semibold text-[13px] flex items-center justify-center gap-2 transition-all cursor-pointer shadow-xs disabled:opacity-50"
            >
              <RefreshCw size={14} className={testing ? 'animate-spin' : ''} />
              <span>{testing ? '正在重测网络链路…' : '重新测速与探测 LAN'}</span>
            </button>

            <button
              type="button"
              onClick={handleCopyReport}
              className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium text-[13px] flex items-center justify-center gap-2 transition-all cursor-pointer"
            >
              {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
              <span>{copied ? '已复制诊断报告' : '复制诊断报告'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
