import React, { useState } from 'react';
import { Plus, RefreshCw, Trash2, Edit2, Monitor, ArrowRight, Laptop } from 'lucide-react';
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
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  return (
    <div className="flex flex-col h-full bg-[#f2f2f7]">
      {/* iOS Frosted Navigation Bar */}
      <header className="sticky top-0 z-30 ios-glass border-b border-[rgba(60,60,67,0.12)] px-4 py-3">
        <div className="flex items-center justify-between max-w-2xl mx-auto w-full">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#ffffff] border border-[rgba(60,60,67,0.08)] shadow-2xs flex items-center justify-center p-1">
              <DeepSeekLogo size={20} variant="brand" />
            </div>
            <div>
              <h1 className="text-[17px] font-bold tracking-tight text-[#000000]">我的电脑</h1>
              <p className="text-[11px] text-[#8e8e93]">已配对的远程工作站与守护进程</p>
            </div>
          </div>
          <button
            onClick={onReconnect}
            type="button"
            title="重新连接"
            className="w-9 h-9 rounded-full bg-[rgba(118,118,128,0.12)] hover:bg-[rgba(118,118,128,0.2)] text-[#1c1c1e] flex items-center justify-center transition-colors cursor-pointer ios-spring-tap"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </header>

      {/* Main Content (iOS Grouped Layout) */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 max-w-2xl w-full mx-auto pb-28">
        {/* Connection Status Card */}
        <div className="flex items-center justify-between p-3.5 rounded-2xl bg-[#ffffff] border border-[rgba(60,60,67,0.08)] shadow-2xs">
          <div className="flex items-center gap-3">
            <ConnectionDot
              status={linkState.type === 'ready' ? 'online' : linkState.type === 'connecting' ? 'connecting' : 'offline'}
              size={10}
            />
            <div>
              <div className="text-[13px] font-semibold text-[#000000]">
                {linkState.type === 'ready'
                  ? `已就绪: ${linkState.hostName || '远程主机'}`
                  : linkState.type === 'connecting'
                  ? `正在连接主机…`
                  : '未建立活跃连接'}
              </div>
              <div className="text-[11.5px] text-[#8e8e93]">
                {linkState.type === 'ready'
                  ? 'WebSocket mux 通道正常 · RPC 桥接就绪'
                  : '选择下方电脑即可进入会话'}
              </div>
            </div>
          </div>
          {linkState.type === 'ready' && (
            <span className="text-[11px] font-semibold text-[#34c759] bg-[#eefdf3] px-2.5 py-0.5 rounded-full">
              在线
            </span>
          )}
        </div>

        {/* Empty State */}
        {hosts.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 mt-12 text-center bg-[#ffffff] rounded-3xl border border-[rgba(60,60,67,0.08)] shadow-xs">
            <div className="w-14 h-14 rounded-2xl bg-[#edf2ff] text-[#3964fe] flex items-center justify-center mb-3">
              <Laptop size={28} />
            </div>
            <h3 className="text-[16px] font-bold text-[#000000]">还没有配对任何电脑</h3>
            <p className="text-[13px] text-[#8e8e93] mt-1 max-w-sm leading-relaxed">
              在电脑端打开 DSH 移动网关管理面板，刷新配对码，或使用账号密码完成快速绑定。
            </p>
            <button
              onClick={onAdd}
              type="button"
              className="mt-5 px-5 py-2.5 bg-[#3964fe] text-white rounded-2xl text-[13px] font-semibold shadow-xs hover:bg-[#2b4ec9] transition-transform cursor-pointer ios-spring-tap"
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
                  className={`p-4 rounded-2xl bg-[#ffffff] border transition-all ios-spring-tap ${
                    isActive
                      ? 'border-[#3964fe] ring-2 ring-[#3964fe]/15 shadow-sm'
                      : 'border-[rgba(60,60,67,0.08)] shadow-2xs hover:shadow-xs'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className="w-11 h-11 rounded-2xl bg-[#f2f2f7] flex items-center justify-center text-[#1c1c1e] shrink-0 mt-0.5">
                        <Monitor size={22} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-[15px] font-bold text-[#000000]">{host.label}</h3>
                          {isActive && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#3964fe] text-white">
                              当前使用
                            </span>
                          )}
                        </div>
                        <p className="text-[12px] font-mono text-[#8e8e93] mt-0.5">{host.baseUrl}</p>
                        <div className="flex items-center gap-2 text-[11.5px] text-[#8e8e93] mt-1.5">
                          <span>实例: {host.instanceName || '未知主机'}</span>
                          <span>·</span>
                          <span>最近活跃: {formatTime(host.lastUsedAt)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          setRenameTarget(host);
                          setRenameValue(host.label);
                        }}
                        type="button"
                        title="修改名称"
                        className="w-8 h-8 rounded-full text-[#8e8e93] hover:text-[#000000] hover:bg-[#f2f2f7] flex items-center justify-center transition-colors cursor-pointer ios-spring-tap"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => setForgetTarget(host.id)}
                        type="button"
                        title="解绑电脑"
                        className="w-8 h-8 rounded-full text-[#ff3b30] hover:bg-[#ffe5e5] flex items-center justify-center transition-colors cursor-pointer ios-spring-tap"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="mt-3.5 pt-3 border-t border-[rgba(60,60,67,0.06)] flex items-center justify-end">
                    <button
                      onClick={() => onOpen(host.id)}
                      type="button"
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#3964fe] hover:bg-[#2b4ec9] text-white text-[12.5px] font-semibold transition-transform cursor-pointer shadow-xs ios-spring-tap"
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

      {/* iOS Floating Action Button */}
      <div className="fixed bottom-6 right-6 z-20">
        <button
          onClick={onAdd}
          type="button"
          className="flex items-center gap-2 px-5 py-3.5 rounded-full bg-[#3964fe] hover:bg-[#2b4ec9] text-white text-[14px] font-semibold shadow-xl transition-transform hover:scale-105 cursor-pointer ios-spring-tap"
        >
          <Plus size={18} />
          <span>配对电脑</span>
        </button>
      </div>

      {/* Delete Confirmation Modal */}
      {forgetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl border border-[rgba(60,60,67,0.08)] animate-in zoom-in-95 duration-200">
            <h3 className="text-[16px] font-bold text-[#000000]">解除电脑配对</h3>
            <p className="text-[13px] text-[#8e8e93] mt-2 leading-relaxed">
              确定要删除此电脑的凭据吗？删除后手机无法继续遥控该工作站，需重新配对。
            </p>
            <div className="flex items-center justify-end gap-2.5 mt-6">
              <button
                onClick={() => setForgetTarget(null)}
                type="button"
                className="px-4 py-2 text-[13px] font-medium text-[#8e8e93] hover:text-[#000000] rounded-xl transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onForget(forgetTarget);
                  setForgetTarget(null);
                }}
                type="button"
                className="px-4 py-2 text-[13px] font-semibold text-white bg-[#ff3b30] hover:bg-[#d72c23] rounded-xl transition-transform cursor-pointer ios-spring-tap shadow-xs"
              >
                确认解除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl border border-[rgba(60,60,67,0.08)] animate-in zoom-in-95 duration-200">
            <h3 className="text-[16px] font-bold text-[#000000]">修改电脑备注名</h3>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full mt-3.5 px-3.5 py-2.5 text-[13px] bg-[#f2f2f7] border border-[rgba(60,60,67,0.1)] rounded-xl focus:outline-hidden focus:bg-[#ffffff] focus:ring-2 focus:ring-[#3964fe]/30"
              placeholder="例如：办公室台式机 / 随身 MacBook"
            />
            <div className="flex items-center justify-end gap-2.5 mt-5">
              <button
                onClick={() => setRenameTarget(null)}
                type="button"
                className="px-4 py-2 text-[13px] font-medium text-[#8e8e93] hover:text-[#000000] rounded-xl transition-colors cursor-pointer"
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
                className="px-5 py-2 text-[13px] font-semibold text-white bg-[#3964fe] hover:bg-[#2b4ec9] rounded-xl transition-transform cursor-pointer ios-spring-tap shadow-xs"
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
