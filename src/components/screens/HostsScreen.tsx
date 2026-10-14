import React, { useState } from 'react';
import { Plus, RefreshCw, Trash2, Edit2, Monitor, ArrowRight, Laptop, Sparkles } from 'lucide-react';
import { HostRecord, LinkState } from '../../types';
import { ConnectionDot } from '../common/ConnectionDot';
import { DeepSeekLogo } from '../common/DeepSeekLogo';

interface Props {
  hosts: HostRecord[];
  activeId: string | null;
  linkState: LinkState;
  onOpen: (id: string) => void;
  onForget: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onReconnect: () => void;
  onAdd: () => void;
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
    <div className="flex flex-col h-full bg-[#090a0f] text-[#f8fafc] mesh-glow-bg select-none">
      {/* Studio Top Navigation Bar */}
      <header className="sticky top-0 z-30 studio-glass border-b border-white/[0.08] px-4 py-3">
        <div className="flex items-center justify-between max-w-2xl mx-auto w-full">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#1e293b] to-[#0f172a] border border-white/10 shadow-inner flex items-center justify-center p-1.5">
              <DeepSeekLogo size={22} variant="brand" />
            </div>
            <div>
              <h1 className="text-[17px] font-bold tracking-tight text-white">我的工作电脑</h1>
              <p className="text-[11px] text-[#94a3b8]">已配对的远程工作站与守护进程</p>
            </div>
          </div>
          <button
            onClick={onReconnect}
            type="button"
            title="重新连接"
            className="w-9 h-9 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-[#94a3b8] hover:text-white flex items-center justify-center transition-colors cursor-pointer studio-tap"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3.5 max-w-2xl w-full mx-auto pb-32">
        {/* Connection Status Card */}
        <div className="flex items-center justify-between p-4 rounded-2xl specular-card border border-white/10">
          <div className="flex items-center gap-3">
            <ConnectionDot
              status={linkState.type === 'ready' ? 'online' : linkState.type === 'connecting' ? 'connecting' : 'offline'}
              size={10}
            />
            <div>
              <div className="text-[13.5px] font-semibold text-white">
                {linkState.type === 'ready'
                  ? `已就绪: ${linkState.hostName || '远程主机'}`
                  : linkState.type === 'connecting'
                  ? `正在连接主机…`
                  : '未建立活跃连接'}
              </div>
              <div className="text-[11.5px] text-[#94a3b8]">
                {linkState.type === 'ready'
                  ? 'WebSocket 双向流通道正常 · RPC 桥接就绪'
                  : '选择下方电脑即可进入会话'}
              </div>
            </div>
          </div>
          {linkState.type === 'ready' && (
            <span className="text-[11px] font-semibold text-[#10b981] bg-[#10b981]/15 border border-[#10b981]/30 px-2.5 py-0.5 rounded-full">
              在线
            </span>
          )}
        </div>

        {/* Empty State */}
        {hosts.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 mt-12 text-center specular-card rounded-3xl">
            <div className="w-14 h-14 rounded-2xl bg-[#1e2538] border border-white/10 text-[#38bdf8] flex items-center justify-center mb-3 shadow-inner">
              <Laptop size={28} />
            </div>
            <h3 className="text-[16px] font-bold text-white">还没有配对任何电脑</h3>
            <p className="text-[13px] text-[#94a3b8] mt-1.5 max-w-sm leading-relaxed">
              在电脑端打开 DSH 移动网关管理面板，刷新配对码，或使用账号密码完成快速绑定。
            </p>
            <button
              onClick={onAdd}
              type="button"
              className="mt-5 px-5 py-2.5 bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white rounded-xl text-[13px] font-semibold shadow-[0_0_20px_rgba(59,130,246,0.35)] transition-transform cursor-pointer studio-tap"
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
                  className={`p-4 rounded-2xl specular-card-interactive border transition-all ${
                    isActive
                      ? 'border-[#3b82f6] shadow-[0_0_25px_rgba(59,130,246,0.2)]'
                      : 'border-white/[0.08]'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="w-11 h-11 rounded-2xl bg-[#1e2538] border border-white/10 flex items-center justify-center text-[#38bdf8] shrink-0 mt-0.5 shadow-inner">
                        <Monitor size={22} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-[15px] font-bold text-white truncate">{host.label}</h3>
                          {isActive && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#3b82f6] text-white">
                              当前使用
                            </span>
                          )}
                        </div>
                        <p className="text-[12px] font-mono text-[#94a3b8] mt-0.5 truncate">{host.baseUrl}</p>
                        <div className="flex items-center gap-2 text-[11.5px] text-[#64748b] mt-1.5">
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
                        className="w-8 h-8 rounded-xl bg-white/[0.04] text-[#94a3b8] hover:text-white hover:bg-white/[0.08] flex items-center justify-center transition-colors cursor-pointer studio-tap"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => setForgetTarget(host.id)}
                        type="button"
                        title="解绑电脑"
                        className="w-8 h-8 rounded-xl bg-[#f43f5e]/10 text-[#fb7185] hover:bg-[#f43f5e]/20 flex items-center justify-center transition-colors cursor-pointer studio-tap"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="mt-3.5 pt-3 border-t border-white/[0.06] flex items-center justify-end">
                    <button
                      onClick={() => onOpen(host.id)}
                      type="button"
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white text-[12.5px] font-semibold shadow-[0_0_15px_rgba(59,130,246,0.35)] transition-transform cursor-pointer studio-tap"
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

      {/* Floating Action Button */}
      <div className="fixed bottom-6 right-6 z-20">
        <button
          onClick={onAdd}
          type="button"
          className="flex items-center gap-2 px-5 py-3.5 rounded-full bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white text-[14px] font-semibold shadow-[0_0_25px_rgba(59,130,246,0.5)] hover:scale-105 transition-all cursor-pointer studio-tap"
        >
          <Sparkles size={17} className="text-white animate-pulse" />
          <span>配对新电脑</span>
        </button>
      </div>

      {/* Delete Confirmation Modal */}
      {forgetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in">
          <div className="w-full max-w-sm rounded-3xl specular-card p-6 shadow-2xl border border-white/10 animate-in zoom-in-95 duration-200">
            <h3 className="text-[16px] font-bold text-white">解除电脑配对</h3>
            <p className="text-[13px] text-[#94a3b8] mt-2 leading-relaxed">
              确定要删除此电脑的凭据吗？删除后手机无法继续遥控该工作站，需重新配对。
            </p>
            <div className="flex items-center justify-end gap-2.5 mt-6">
              <button
                onClick={() => setForgetTarget(null)}
                type="button"
                className="px-4 py-2 text-[13px] font-medium text-[#94a3b8] hover:text-white rounded-xl transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onForget(forgetTarget);
                  setForgetTarget(null);
                }}
                type="button"
                className="px-4 py-2 text-[13px] font-semibold text-white bg-[#f43f5e] hover:bg-[#e11d48] rounded-xl transition-transform cursor-pointer studio-tap shadow-xs"
              >
                确认解除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in">
          <div className="w-full max-w-sm rounded-3xl specular-card p-6 shadow-2xl border border-white/10 animate-in zoom-in-95 duration-200">
            <h3 className="text-[16px] font-bold text-white">修改电脑备注名</h3>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full mt-3.5 px-3.5 py-2.5 text-[13px] bg-[#141824] border border-white/10 rounded-xl focus:outline-hidden focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/40 text-white placeholder:text-[#64748b]"
              placeholder="例如：办公室台式机 / 随身 MacBook"
            />
            <div className="flex items-center justify-end gap-2.5 mt-5">
              <button
                onClick={() => setRenameTarget(null)}
                type="button"
                className="px-4 py-2 text-[13px] font-medium text-[#94a3b8] hover:text-white rounded-xl transition-colors cursor-pointer"
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
                className="px-5 py-2 text-[13px] font-semibold text-white bg-gradient-to-r from-[#3b82f6] to-[#2563eb] rounded-xl transition-transform cursor-pointer studio-tap shadow-[0_0_20px_rgba(59,130,246,0.35)]"
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
