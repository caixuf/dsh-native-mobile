import React, { useState } from 'react';
import { Menu, Search, X, RefreshCw, Plus, Folder, MessageSquare, ChevronRight } from 'lucide-react';
import { SessionRow, LinkState } from '../../types';
import { StatusPill } from '../common/StatusPill';
import { DeepSeekLogo } from '../common/DeepSeekLogo';

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
    <div className="flex flex-col h-full bg-[#f2f2f7]">
      {/* iOS Frosted Glass Top Navigation Bar */}
      <header className="sticky top-0 z-30 ios-glass border-b border-[rgba(60,60,67,0.12)] px-4 py-3 transition-all">
        <div className="flex items-center justify-between max-w-2xl mx-auto w-full">
          <div className="flex items-center gap-2.5">
            <button
              onClick={onOpenDrawer}
              type="button"
              className="w-9 h-9 rounded-full bg-[rgba(118,118,128,0.12)] hover:bg-[rgba(118,118,128,0.2)] flex items-center justify-center text-[#000000] transition-colors cursor-pointer ios-spring-tap"
            >
              <Menu size={18} />
            </button>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-[#ffffff] border border-[rgba(60,60,67,0.08)] shadow-2xs flex items-center justify-center p-1">
                <DeepSeekLogo size={20} variant="brand" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-[17px] font-bold tracking-tight text-[#000000]">会话</h1>
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
              className="w-9 h-9 rounded-full bg-[rgba(118,118,128,0.12)] hover:bg-[rgba(118,118,128,0.2)] flex items-center justify-center text-[#1c1c1e] transition-colors cursor-pointer ios-spring-tap"
            >
              {searchOpen ? <X size={17} /> : <Search size={17} />}
            </button>
            <button
              onClick={onRefresh}
              type="button"
              className="w-9 h-9 rounded-full bg-[rgba(118,118,128,0.12)] hover:bg-[rgba(118,118,128,0.2)] flex items-center justify-center text-[#1c1c1e] transition-colors cursor-pointer ios-spring-tap"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin text-[#3964fe]' : ''} />
            </button>
          </div>
        </div>

        {/* iOS Style Search Bar with subtle animation */}
        {searchOpen && (
          <div className="mt-2.5 pt-2 border-t border-[rgba(60,60,67,0.08)] max-w-2xl mx-auto w-full animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="relative flex items-center">
              <Search size={15} className="absolute left-3 text-[#8e8e93]" />
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="搜索会话标题、摘要或工作区…"
                className="w-full pl-9 pr-3 py-2 text-[13px] bg-[rgba(118,118,128,0.12)] rounded-xl focus:outline-hidden focus:bg-[#ffffff] focus:ring-2 focus:ring-[#3964fe]/30 text-[#000000] placeholder:text-[#8e8e93] transition-all"
              />
            </div>
          </div>
        )}
      </header>

      {/* Main Sessions List (iOS Grouped Layout) */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 max-w-2xl w-full mx-auto pb-28">
        {/* iOS Segmented Filter for Subagents */}
        {subagentSessions.length > 0 && (
          <div className="flex justify-center my-1">
            <div className="p-0.5 bg-[rgba(118,118,128,0.12)] rounded-xl flex items-center text-[12px] font-medium text-[#8e8e93]">
              <button
                type="button"
                onClick={() => setShowSubagents(false)}
                className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                  !showSubagents
                    ? 'bg-[#ffffff] text-[#000000] shadow-xs font-semibold'
                    : 'hover:text-[#000000]'
                }`}
              >
                主会话 ({sessions.length})
              </button>
              <button
                type="button"
                onClick={() => setShowSubagents(true)}
                className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                  showSubagents
                    ? 'bg-[#ffffff] text-[#000000] shadow-xs font-semibold'
                    : 'hover:text-[#000000]'
                }`}
              >
                全部含子代理 ({sessions.length + subagentSessions.length})
              </button>
            </div>
          </div>
        )}

        {/* Empty State */}
        {displayedSessions.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center p-8 mt-12 text-center bg-[#ffffff] rounded-3xl border border-[rgba(60,60,67,0.08)] shadow-xs">
            <div className="w-14 h-14 rounded-2xl bg-[#edf2ff] text-[#3964fe] flex items-center justify-center mb-3 p-2">
              <DeepSeekLogo size={32} variant="brand" />
            </div>
            <h3 className="text-[16px] font-bold text-[#000000]">暂无匹配的遥控会话</h3>
            <p className="text-[13px] text-[#8e8e93] mt-1 max-w-xs leading-relaxed">
              随时发起指令，通过端到端加密连接遥控你的远程电脑。
            </p>
            <button
              onClick={() => setCreateDialogOpen(true)}
              type="button"
              className="mt-5 px-5 py-2.5 bg-[#3964fe] hover:bg-[#2b4ec9] text-white rounded-2xl text-[13px] font-semibold transition-transform cursor-pointer ios-spring-tap shadow-sm"
            >
              新建会话
            </button>
          </div>
        )}

        {/* iOS Grouped Cards */}
        <div className="space-y-2.5">
          {displayedSessions.map((session) => (
            <div
              key={session.sessionId}
              onClick={() => onOpen(session)}
              className="p-4 rounded-2xl bg-[#ffffff] border border-[rgba(60,60,67,0.08)] shadow-2xs hover:shadow-xs transition-all cursor-pointer ios-spring-tap group"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[15px] font-semibold tracking-tight text-[#000000] group-hover:text-[#3964fe] transition-colors truncate">
                      {session.title}
                    </h3>
                    {session.isSubagent && (
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-[#f2f2f7] text-[#8e8e93]">
                        子代理
                      </span>
                    )}
                    {session.running && (
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-[#3964fe] bg-[#edf2ff] px-2 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#3964fe] animate-ping" />
                        运行中
                      </span>
                    )}
                  </div>

                  <p className="text-[13px] text-[#8e8e93] line-clamp-2 mt-1 leading-relaxed">
                    {session.preview || '暂无消息摘要'}
                  </p>

                  <div className="flex items-center gap-2 mt-2.5 text-[11.5px] text-[#8e8e93]">
                    {session.workspace && (
                      <>
                        <div className="flex items-center gap-1 font-mono text-[#3a3a3c] truncate max-w-[260px]">
                          <Folder size={12} className="text-[#3964fe]" />
                          <span className="truncate">{session.workspace}</span>
                        </div>
                        <span>·</span>
                      </>
                    )}
                    <span>{formatTime(session.updatedAt)}</span>
                  </div>
                </div>

                <div className="pt-1 text-[#c7c7cc] group-hover:text-[#3964fe] transition-colors">
                  <ChevronRight size={16} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Floating Action Button (iOS Black Pill) */}
      <div className="fixed bottom-6 right-6 z-20">
        <button
          onClick={() => setCreateDialogOpen(true)}
          type="button"
          className="flex items-center gap-2 px-5 py-3.5 rounded-full bg-[#000000] hover:bg-[#1c1c1e] text-white text-[14px] font-semibold shadow-xl transition-transform hover:scale-105 cursor-pointer ios-spring-tap"
        >
          <Plus size={18} />
          <span>新建会话</span>
        </button>
      </div>

      {/* iOS Modal Action Sheet Dialog */}
      {createDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-sm rounded-3xl bg-[#ffffff] p-6 shadow-2xl border border-[rgba(60,60,67,0.08)] animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-2.5 mb-2">
              <div className="w-8 h-8 rounded-xl bg-[#edf2ff] flex items-center justify-center p-1">
                <DeepSeekLogo size={20} variant="brand" />
              </div>
              <h3 className="text-[16px] font-bold text-[#000000]">新建遥控会话</h3>
            </div>
            <p className="text-[13px] text-[#8e8e93] leading-relaxed">
              可指定在工作电脑上关联的工作区目录 (CWD)。
            </p>

            <div className="mt-4">
              <label className="block text-[12px] font-medium text-[#8e8e93] mb-1.5">
                电脑工作区路径 (cwd)
              </label>
              <input
                type="text"
                value={customCwd}
                onChange={(e) => setCustomCwd(e.target.value)}
                placeholder="例如：~/Developer/projects/my-app"
                className="w-full px-3.5 py-2.5 text-[13px] font-mono bg-[#f2f2f7] border border-[rgba(60,60,67,0.1)] rounded-xl focus:outline-hidden focus:bg-[#ffffff] focus:ring-2 focus:ring-[#3964fe]/30"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 mt-6">
              <button
                onClick={() => setCreateDialogOpen(false)}
                type="button"
                className="px-4 py-2 text-[13px] font-medium text-[#8e8e93] hover:text-[#000000] rounded-xl transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onCreate(customCwd.trim());
                  setCreateDialogOpen(false);
                }}
                type="button"
                className="px-5 py-2 text-[13px] font-semibold text-white bg-[#3964fe] hover:bg-[#2b4ec9] rounded-xl shadow-xs transition-transform cursor-pointer ios-spring-tap"
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
