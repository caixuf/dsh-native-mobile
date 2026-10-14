import React, { useState } from 'react';
import { Menu, Search, X, RefreshCw, Plus, Folder, MessageSquare, ChevronRight, Monitor, Cpu, Sparkles, Terminal } from 'lucide-react';
import { SessionRow, LinkState } from '../../types';
import { StatusPill } from '../common/StatusPill';
import { DeepSeekLogo } from '../common/DeepSeekLogo';
import { ConnectionDot } from '../common/ConnectionDot';

interface Props {
  linkState: LinkState;
  sessions: SessionRow[];
  subagentSessions: SessionRow[];
  loading: boolean;
  onOpen: (session: SessionRow) => void;
  onRefresh: () => void;
  onSearch: (q: string) => void;
  onCreate: (cwd?: string) => void;
  onOpenDrawer: () => void;
}

export const SessionsScreen: React.FC<Props> = ({
  linkState,
  sessions,
  subagentSessions,
  loading,
  onOpen,
  onRefresh,
  onSearch,
  onCreate,
  onOpenDrawer,
}) => {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showSubagents, setShowSubagents] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [customCwd, setCustomCwd] = useState('~/Developer/workspaces/nexus-ecommerce');

  const handleSearchChange = (val: string) => {
    setQuery(val);
    onSearch(val);
  };

  const formatTime = (ts: number) => {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  const displayedSessions = showSubagents ? [...sessions, ...subagentSessions] : sessions;

  return (
    <div className="flex flex-col h-full bg-[#090a0f] text-[#f8fafc] mesh-glow-bg select-none">
      {/* Studio Top Navigation Bar */}
      <header className="sticky top-0 z-30 studio-glass border-b border-white/[0.08] px-4 py-3 transition-all">
        <div className="flex items-center justify-between max-w-2xl mx-auto w-full">
          <div className="flex items-center gap-3">
            <button
              onClick={onOpenDrawer}
              type="button"
              className="w-9 h-9 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-[#e2e8f0] transition-colors cursor-pointer studio-tap"
            >
              <Menu size={18} />
            </button>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#1e293b] to-[#0f172a] border border-white/10 shadow-inner flex items-center justify-center p-1.5">
                <DeepSeekLogo size={22} variant="brand" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-[17px] font-bold tracking-tight text-white flex items-center gap-1.5">
                    遥控会话
                  </h1>
                  <StatusPill linkState={linkState} onClick={onOpenDrawer} />
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                setSearchOpen(!searchOpen);
                if (searchOpen) handleSearchChange('');
              }}
              type="button"
              className="w-9 h-9 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-[#94a3b8] hover:text-white transition-colors cursor-pointer studio-tap"
            >
              {searchOpen ? <X size={17} /> : <Search size={17} />}
            </button>
            <button
              onClick={onRefresh}
              type="button"
              className="w-9 h-9 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-[#94a3b8] hover:text-white transition-colors cursor-pointer studio-tap"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin text-[#3b82f6]' : ''} />
            </button>
          </div>
        </div>

        {/* Studio Dark Search Bar */}
        {searchOpen && (
          <div className="mt-2.5 pt-2 border-t border-white/[0.06] max-w-2xl mx-auto w-full animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="relative flex items-center">
              <Search size={15} className="absolute left-3.5 text-[#64748b]" />
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="搜索会话指令、工作区或摘要…"
                className="w-full pl-10 pr-3 py-2 text-[13px] bg-[#141824] border border-white/10 rounded-xl focus:outline-hidden focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/40 text-white placeholder:text-[#64748b] transition-all"
              />
            </div>
          </div>
        )}
      </header>

      {/* Main Sessions List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3.5 max-w-2xl w-full mx-auto pb-32">
        {/* Bento Remote Host Status Overview Card */}
        <div className="specular-card p-4 rounded-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 -mt-4 -mr-4 w-28 h-28 bg-[#3b82f6]/10 rounded-full blur-2xl pointer-events-none" />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#1e2538] border border-white/10 flex items-center justify-center text-[#38bdf8] shadow-inner">
                <Monitor size={20} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-bold text-white">
                    {linkState.type === 'ready' ? (linkState.hostName || '远程工作站') : '远程工作站'}
                  </span>
                  <span className="flex items-center gap-1 text-[11px] font-medium text-[#10b981] bg-[#10b981]/10 px-2 py-0.5 rounded-md border border-[#10b981]/20">
                    <ConnectionDot status={linkState.type === 'ready' ? 'online' : 'offline'} size={5} pulse={false} />
                    {linkState.type === 'ready' ? '双向流就绪' : '等待连接'}
                  </span>
                </div>
                <p className="text-[12px] text-[#94a3b8] mt-0.5 font-mono flex items-center gap-1.5">
                  <Cpu size={12} className="text-[#3b82f6]" />
                  <span>DeepSeek Agent 守护进程 · 延迟 ~18ms</span>
                </p>
              </div>
            </div>

            <button
              onClick={() => setCreateDialogOpen(true)}
              type="button"
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#3b82f6]/20 hover:bg-[#3b82f6]/30 border border-[#3b82f6]/40 text-[#60a5fa] hover:text-white text-[12px] font-semibold transition-all cursor-pointer studio-tap"
            >
              <Plus size={14} />
              <span>新建</span>
            </button>
          </div>
        </div>

        {/* Subagent Segmented Switcher */}
        {subagentSessions.length > 0 && (
          <div className="flex justify-center my-1">
            <div className="p-1 bg-[#141824] border border-white/[0.08] rounded-xl flex items-center text-[12px] font-medium text-[#94a3b8]">
              <button
                type="button"
                onClick={() => setShowSubagents(false)}
                className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                  !showSubagents
                    ? 'bg-[#1e2538] text-white border border-white/10 font-semibold shadow-xs'
                    : 'hover:text-white'
                }`}
              >
                主会话 ({sessions.length})
              </button>
              <button
                type="button"
                onClick={() => setShowSubagents(true)}
                className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                  showSubagents
                    ? 'bg-[#1e2538] text-white border border-white/10 font-semibold shadow-xs'
                    : 'hover:text-white'
                }`}
              >
                含子代理 ({sessions.length + subagentSessions.length})
              </button>
            </div>
          </div>
        )}

        {/* Empty State */}
        {displayedSessions.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center p-8 mt-8 text-center specular-card rounded-3xl">
            <div className="w-14 h-14 rounded-2xl bg-[#1e2538] border border-white/10 text-[#3b82f6] flex items-center justify-center mb-3 p-2.5 shadow-inner">
              <DeepSeekLogo size={32} variant="brand" />
            </div>
            <h3 className="text-[16px] font-bold text-white">暂无匹配的遥控会话</h3>
            <p className="text-[13px] text-[#94a3b8] mt-1.5 max-w-xs leading-relaxed">
              随时发起指令，通过端到端加密双向流遥控你的远程开发电脑。
            </p>
            <button
              onClick={() => setCreateDialogOpen(true)}
              type="button"
              className="mt-5 px-5 py-2.5 bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white rounded-xl text-[13px] font-semibold transition-transform cursor-pointer studio-tap shadow-[0_0_20px_rgba(59,130,246,0.35)]"
            >
              发起新会话
            </button>
          </div>
        )}

        {/* Specular Session Cards */}
        <div className="space-y-2.5">
          {displayedSessions.map((session) => (
            <div
              key={session.sessionId}
              onClick={() => onOpen(session)}
              className="p-4 rounded-2xl specular-card-interactive cursor-pointer group relative overflow-hidden"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[15px] font-semibold tracking-tight text-white group-hover:text-[#60a5fa] transition-colors truncate">
                      {session.title}
                    </h3>
                    {session.isSubagent && (
                      <span className="text-[10.5px] font-medium px-2 py-0.5 rounded-md bg-[#a855f7]/15 text-[#c084fc] border border-[#a855f7]/25">
                        子代理
                      </span>
                    )}
                    {session.running && (
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[#38bdf8] bg-[#38bdf8]/15 px-2.5 py-0.5 rounded-full border border-[#38bdf8]/30">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#38bdf8] animate-ping" />
                        电脑执行中
                      </span>
                    )}
                  </div>

                  <p className="text-[13px] text-[#94a3b8] line-clamp-2 mt-1.5 leading-relaxed font-normal">
                    {session.preview || '暂无消息摘要'}
                  </p>

                  <div className="flex items-center gap-2 mt-3 text-[11.5px] text-[#64748b]">
                    {session.workspace && (
                      <>
                        <div className="flex items-center gap-1 font-mono text-[#cbd5e1] truncate max-w-[260px] bg-white/[0.04] px-2 py-0.5 rounded-md border border-white/[0.06]">
                          <Folder size={11} className="text-[#3b82f6]" />
                          <span className="truncate">{session.workspace}</span>
                        </div>
                        <span>·</span>
                      </>
                    )}
                    <span>{formatTime(session.updatedAt)}</span>
                  </div>
                </div>

                <div className="pt-1 text-[#475569] group-hover:text-[#60a5fa] group-hover:translate-x-0.5 transition-all">
                  <ChevronRight size={17} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Floating Action Button (Raycast Glowing Pill) */}
      <div className="fixed bottom-6 right-6 z-20">
        <button
          onClick={() => setCreateDialogOpen(true)}
          type="button"
          className="flex items-center gap-2 px-5 py-3.5 rounded-full bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white text-[14px] font-semibold shadow-[0_0_25px_rgba(59,130,246,0.5)] hover:shadow-[0_0_35px_rgba(59,130,246,0.7)] transition-all hover:scale-105 cursor-pointer studio-tap"
        >
          <Sparkles size={17} className="text-white animate-pulse" />
          <span>新建会话</span>
        </button>
      </div>

      {/* Studio Modal Dialog */}
      {createDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in">
          <div className="w-full max-w-sm rounded-3xl specular-card p-6 shadow-2xl border border-white/10 animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-2.5 mb-2">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#1e293b] to-[#0f172a] border border-white/10 flex items-center justify-center p-1.5 shadow-inner">
                <DeepSeekLogo size={20} variant="brand" />
              </div>
              <h3 className="text-[16px] font-bold text-white">新建遥控会话</h3>
            </div>
            <p className="text-[13px] text-[#94a3b8] leading-relaxed">
              可指定在远程工作电脑上关联的工作区目录 (CWD)。
            </p>

            <div className="mt-4">
              <label className="block text-[12px] font-medium text-[#94a3b8] mb-1.5">
                电脑工作区路径 (cwd)
              </label>
              <input
                type="text"
                value={customCwd}
                onChange={(e) => setCustomCwd(e.target.value)}
                placeholder="例如：~/Developer/projects/my-app"
                className="w-full px-3.5 py-2.5 text-[13px] font-mono bg-[#141824] border border-white/10 rounded-xl focus:outline-hidden focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/40 text-white placeholder:text-[#64748b]"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 mt-6">
              <button
                onClick={() => setCreateDialogOpen(false)}
                type="button"
                className="px-4 py-2 text-[13px] font-medium text-[#94a3b8] hover:text-white rounded-xl transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onCreate(customCwd.trim());
                  setCreateDialogOpen(false);
                }}
                type="button"
                className="px-5 py-2 text-[13px] font-semibold text-white bg-gradient-to-r from-[#3b82f6] to-[#2563eb] rounded-xl shadow-[0_0_20px_rgba(59,130,246,0.35)] transition-transform cursor-pointer studio-tap"
              >
                创建会话
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
