import React from 'react';
import { X, Plus, Settings, MessageSquare, Folder, ChevronRight, Monitor, Search, Bell, MoreHorizontal, Laptop, Compass, Sparkles } from 'lucide-react';
import { SessionRow } from '../../types';
import { ConnectionDot } from '../common/ConnectionDot';
import { MiniMaxMascot } from '../common/MiniMaxMascot';
import { triggerHaptic } from '../../utils/haptics';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  activeHostName?: string;
  isHostOnline: boolean;
  sessions: SessionRow[];
  currentSessionId?: string;
  onSelectSession: (session: SessionRow) => void;
  onNewSession: () => void;
  onManageHosts: () => void;
  onOpenUserCenter?: () => void;
}

export const AppDrawer: React.FC<Props> = ({
  isOpen,
  onClose,
  activeHostName = 'caixuf.Windows',
  isHostOnline,
  sessions,
  currentSessionId,
  onSelectSession,
  onNewSession,
  onManageHosts,
  onOpenUserCenter,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Blurred soft backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* Pure Light MiniMax Drawer Sheet */}
      <div className="relative z-50 w-[300px] max-w-[85vw] h-full bg-white shadow-2xl flex flex-col text-[#18181b] transition-transform animate-in slide-in-from-left duration-250 ease-out border-r border-gray-100">
        {/* 1. Header with Mascot Avatar + Search + Close */}
        <div className="flex items-center justify-between px-4 pt-[calc(1rem+var(--sat))] pb-3 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center p-1 shadow-2xs">
              <MiniMaxMascot size={28} />
            </div>
            <span className="text-[15px] font-bold tracking-tight text-gray-900">DSH Remote</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onManageHosts}
              aria-label="管理电脑"
              className="w-8 h-8 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-600 transition-colors cursor-pointer"
            >
              <Search size={16} />
            </button>
            <button
              onClick={onClose}
              type="button"
              aria-label="关闭侧边栏"
              className="w-8 h-8 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-600 transition-colors cursor-pointer"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* 2. MiniMax Main Nav Tabs */}
        <div className="px-3 py-2 space-y-1">
          {/* 连接电脑 (Active) */}
          <div
            onClick={() => {
              triggerHaptic('light');
              onManageHosts();
              onClose();
            }}
            className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-[#f4f4f6] text-gray-900 font-medium text-[14px] cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <Laptop size={18} className="text-gray-900" />
              <span>连接电脑</span>
            </div>
            <span className="flex items-center gap-1 text-[11px] font-mono text-[#52525b]">
              <ConnectionDot status={isHostOnline ? 'online' : 'offline'} size={5} />
              <span className="truncate max-w-[80px]">{activeHostName}</span>
            </span>
          </div>

          {/* 资产 */}
          <div
            onClick={() => {
              triggerHaptic('light');
              onClose();
            }}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-50 text-gray-700 font-medium text-[14px] cursor-pointer transition-colors"
          >
            <Folder size={18} className="text-gray-600" />
            <span>资产</span>
          </div>

          {/* 更多 */}
          <div
            onClick={() => {
              triggerHaptic('light');
              onManageHosts();
              onClose();
            }}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-50 text-gray-700 font-medium text-[14px] cursor-pointer transition-colors"
          >
            <MoreHorizontal size={18} className="text-gray-600" />
            <span>更多</span>
          </div>
        </div>

        {/* 3. "最近" Recent Sessions List (Screenshot 4 style) */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <div className="text-[12px] font-medium text-[#52525b] px-3 py-1">
            最近
          </div>
          {sessions.length === 0 ? (
            <div className="text-center py-8 text-[12px] text-[#52525b]">暂无会话记录</div>
          ) : (
            <div className="space-y-0.5">
              {sessions.slice(0, 20).map((s) => {
                const isSelected = s.sessionId === currentSessionId;
                return (
                  <div
                    key={s.sessionId}
                    onClick={() => {
                      onSelectSession(s);
                      onClose();
                    }}
                    className={`flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-gray-100 text-black font-semibold'
                        : 'text-gray-700 hover:text-black hover:bg-gray-50'
                    }`}
                  >
                    <span className="text-[13.5px] truncate flex-1 min-w-0 pr-2">
                      {s.title || '新对话'}
                    </span>
                    {s.running && (
                      <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 4. Bottom Dock: User Avatar on Left + Black Pill Button [+ 聊天] on Right */}
        <div className="p-3.5 pb-[calc(1rem+var(--sab))] border-t border-gray-100 flex items-center justify-between bg-white">
          {/* User profile button */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              if (onOpenUserCenter) {
                onOpenUserCenter();
                onClose();
              }
            }}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer text-left"
          >
            <div className="w-8 h-8 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center p-0.5 shadow-2xs">
              <MiniMaxMascot size={26} />
            </div>
            <div className="flex flex-col">
              <span className="text-[13px] font-semibold text-gray-900 leading-tight">
                {activeHostName ? activeHostName.split('.')[0] : 'caixuf'}
              </span>
              <span className="text-[10px] text-[#52525b] leading-tight">用户设置</span>
            </div>
          </button>

          {/* MiniMax Iconic Black Pill: [+ 聊天] */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('medium');
              onNewSession();
              onClose();
            }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-black hover:bg-gray-800 text-white text-[13px] font-medium shadow-sm active:scale-95 transition-all cursor-pointer"
          >
            <Plus size={15} />
            <span>聊天</span>
          </button>
        </div>
      </div>
    </div>
  );
};
