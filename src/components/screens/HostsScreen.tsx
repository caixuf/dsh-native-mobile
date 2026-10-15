import React, { useState } from 'react';
import { Plus, RefreshCw, Trash2, Edit2, Monitor, ArrowRight, ArrowLeft, Laptop, ScanLine, QrCode } from 'lucide-react';
import { HostRecord, LinkState } from '../../types';
import { ConnectionDot } from '../common/ConnectionDot';
import { MiniMaxMascot } from '../common/MiniMaxMascot';

interface Props {
  hosts: HostRecord[];
  activeId: string | null;
  linkState: LinkState;
  onOpen: (id: string) => void;
  onForget: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onReconnect: () => void;
  onAdd: () => void;
  onBack?: () => void;
}

export const HostsScreen: React.FC<Props> = ({
  hosts,
  activeId,
  linkState,
  onOpen,
  onForget,
  onRename,
  onReconnect,
  onAdd,
  onBack,
}) => {
  const [forgetTarget, setForgetTarget] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<HostRecord | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const formatTime = (ts: number) => {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  return (
    <div className="flex flex-col h-full bg-white text-[#18181b] select-none">
      {/* Studio Top Navigation Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-gray-100 px-4 py-3">
        <div className="flex items-center justify-between max-w-2xl mx-auto w-full gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            {onBack && (
              <button
                onClick={onBack}
                type="button"
                aria-label="返回会话"
                className="w-9 h-9 rounded-full bg-[#f4f4f6] hover:bg-gray-200 text-[#18181b] flex items-center justify-center mr-1 transition-colors cursor-pointer shrink-0 min-h-[44px]"
              >
                <ArrowLeft size={18} />
              </button>
            )}
            <MiniMaxMascot size={32} />
            <div className="min-w-0">
              <h1 className="text-[16px] font-bold tracking-tight text-[#18181b] whitespace-nowrap truncate">连接电脑</h1>
              <p className="text-[11px] text-[#52525b] whitespace-nowrap truncate">已配对的远程工作站与守护进程</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onAdd}
              type="button"
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[#f4f4f6] hover:bg-gray-200 border border-gray-200/80 text-[#18181b] text-[12px] font-medium transition-colors cursor-pointer min-h-[44px]"
            >
              <ScanLine size={14} />
              <span>扫码配对</span>
            </button>
            <button
              onClick={onReconnect}
              type="button"
              title="重新连接"
              className="w-9 h-9 rounded-full bg-[#f4f4f6] hover:bg-gray-200 text-gray-700 flex items-center justify-center transition-colors cursor-pointer min-h-[44px]"
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3.5 max-w-2xl w-full mx-auto pb-[calc(8rem+var(--sab))]">
        {/* Connection Status Card */}
        <div className="flex items-center justify-between p-4 rounded-2xl bg-[#f4f4f6] border border-gray-200/60">
          <div className="flex items-center gap-3">
            <ConnectionDot
              status={linkState.type === 'ready' ? 'online' : linkState.type === 'connecting' ? 'connecting' : 'offline'}
              size={10}
            />
            <div>
              <div className="text-[13.5px] font-semibold text-[#18181b]">
                {linkState.type === 'ready'
                  ? `已就绪: ${linkState.hostName || '远程主机'}`
                  : linkState.type === 'connecting'
                  ? `正在连接主机…`
                  : '未建立活跃连接'}
              </div>
              <div className="text-[11.5px] text-[#52525b]">
                {linkState.type === 'ready'
                  ? 'WebSocket 双向流通道正常 · RPC 桥接就绪'
                  : '选择下方电脑即可进入会话'}
              </div>
            </div>
          </div>
          {linkState.type === 'ready' && (
            <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">
              在线
            </span>
          )}
        </div>

        {/* Empty State */}
        {hosts.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 mt-12 text-center bg-[#f4f4f6] rounded-3xl border border-gray-200/60">
            <div className="w-14 h-14 rounded-2xl bg-white border border-gray-200 text-gray-700 flex items-center justify-center mb-3 shadow-xs">
              <Laptop size={28} />
            </div>
            <h3 className="text-[16px] font-bold text-[#18181b]">还没有配对任何电脑</h3>
            <p className="text-[13px] text-[#52525b] mt-1.5 max-w-sm leading-relaxed">
              在电脑端打开 DSH 移动网关管理面板，刷新配对码，或使用账号密码完成快速绑定。
            </p>
            <button
              onClick={onAdd}
              type="button"
              className="mt-5 px-6 py-2.5 bg-black text-white hover:bg-neutral-800 rounded-full text-[13px] font-medium shadow-sm transition-transform cursor-pointer min-h-[44px]"
            >
              立即配对工作电脑
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {hosts.map((host) => {
              const isActive = host.id === activeId;
              return (
                <div
                  key={host.id}
                  className={`p-4 rounded-2xl bg-[#f4f4f6] border transition-all ${
                    isActive
                      ? 'border-gray-900 shadow-xs'
                      : 'border-gray-200/60'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="w-11 h-11 rounded-2xl bg-white border border-gray-200/80 flex items-center justify-center text-blue-600 shrink-0 mt-0.5 shadow-2xs">
                        <Monitor size={22} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-[15px] font-bold text-[#18181b] truncate">{host.label}</h3>
                          {isActive && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#18181b] text-white">
                              当前使用
                            </span>
                          )}
                        </div>
                        <p className="text-[12px] font-mono text-[#52525b] mt-0.5 truncate">{host.baseUrl}</p>
                        <div className="flex items-center gap-2 text-[11.5px] text-[#52525b] mt-1.5">
                          <span>实例: {host.instanceName || '未知主机'}</span>
                          <span>·</span>
                          <span>最近活跃: {formatTime(host.lastUsedAt)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      <button
                        onClick={() => {
                          setRenameTarget(host);
                          setRenameValue(host.label);
                        }}
                        type="button"
                        title="修改名称"
                        className="w-9 h-9 rounded-full bg-white text-gray-600 hover:text-black hover:bg-gray-100 border border-gray-200/60 flex items-center justify-center transition-colors cursor-pointer min-h-[44px]"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => setForgetTarget(host.id)}
                        type="button"
                        title="解绑电脑"
                        className="w-9 h-9 rounded-full bg-red-50 text-red-600 hover:bg-red-100 border border-red-100 flex items-center justify-center transition-colors cursor-pointer min-h-[44px]"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="mt-3.5 pt-3 border-t border-gray-200/60 flex items-center justify-end">
                    <button
                      onClick={() => onOpen(host.id)}
                      type="button"
                      className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-black text-white hover:bg-neutral-800 text-[12.5px] font-medium shadow-xs transition-transform cursor-pointer min-h-[44px]"
                    >
                      <span>进入遥控</span>
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Floating Action Button (Matching MiniMax [+ 聊天] style) */}
      <div className="fixed bottom-[calc(1.5rem+var(--sab))] right-6 z-20">
        <button
          onClick={onAdd}
          type="button"
          className="flex items-center gap-2 px-5 py-3 rounded-full bg-black text-white hover:bg-neutral-800 text-[14px] font-semibold shadow-lg hover:scale-105 transition-all cursor-pointer min-h-[44px]"
        >
          <QrCode size={18} className="text-white" />
          <span>扫码 / 配对新电脑</span>
        </button>
      </div>

      {/* Delete Confirmation Modal */}
      {forgetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pt-[calc(1rem+var(--sat))] pb-[calc(1rem+var(--sab))] bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl border border-gray-200 animate-in zoom-in-95 duration-200">
            <h3 className="text-[16px] font-bold text-[#18181b]">解除电脑配对</h3>
            <p className="text-[13px] text-[#52525b] mt-2 leading-relaxed">
              确定要删除此电脑的凭据吗？删除后手机无法继续遥控该工作站，需重新配对。
            </p>
            <div className="flex items-center justify-end gap-2.5 mt-6">
              <button
                onClick={() => setForgetTarget(null)}
                type="button"
                className="px-4 py-2 text-[13px] font-medium text-gray-600 hover:text-black rounded-xl transition-colors cursor-pointer min-h-[44px]"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onForget(forgetTarget);
                  setForgetTarget(null);
                }}
                type="button"
                className="px-4 py-2 text-[13px] font-medium text-white bg-red-600 hover:bg-red-700 rounded-full transition-transform cursor-pointer shadow-xs min-h-[44px]"
              >
                确认解除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pt-[calc(1rem+var(--sat))] pb-[calc(1rem+var(--sab))] bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl border border-gray-200 animate-in zoom-in-95 duration-200">
            <h3 className="text-[16px] font-bold text-[#18181b]">修改电脑备注名</h3>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full mt-3.5 px-3.5 py-2.5 text-[13px] bg-[#f4f4f6] border border-gray-200 rounded-xl focus:outline-hidden focus:border-black focus:ring-1 focus:ring-black/20 text-[#18181b] placeholder:text-[#52525b]"
              placeholder="例如：办公室台式机 / 随身 MacBook"
            />
            <div className="flex items-center justify-end gap-2.5 mt-5">
              <button
                onClick={() => setRenameTarget(null)}
                type="button"
                className="px-4 py-2 text-[13px] font-medium text-gray-600 hover:text-black rounded-xl transition-colors cursor-pointer min-h-[44px]"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (renameValue.trim()) {
                    onRename(renameTarget.id, renameValue.trim());
                  }
                  setRenameTarget(null);
                }}
                type="button"
                className="px-5 py-2 text-[13px] font-medium text-white bg-black hover:bg-neutral-800 rounded-full transition-transform cursor-pointer shadow-xs min-h-[44px]"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
