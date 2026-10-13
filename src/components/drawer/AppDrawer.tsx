import React from 'react';
import { X, Plus, Settings, MessageSquare, Folder, ChevronRight, Monitor } from 'lucide-react';
import { SessionRow } from '../../types';
import { ConnectionDot } from '../common/ConnectionDot';
import { DeepSeekLogo } from '../common/DeepSeekLogo';

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
}

export const AppDrawer: React.FC<Props> = ({
  isOpen,
  onClose,
  activeHostName = '我的电脑',
  isHostOnline,
  sessions,
  currentSessionId,
  onSelectSession,
  onNewSession,
  onManageHosts,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* iOS blurred backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm transition-opacity animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* iOS styled Drawer sheet */}
      <div className="relative z-50 w-[320px] max-w-[85vw] h-full ios-glass border-r border-[rgba(60,60,67,0.12)] shadow-2xl flex flex-col transition-transform animate-in slide-in-from-left duration-250 ease-out">
        {/* 1. Header with DeepSeek Logo & Title */}
        <div className="flex items-center justify-between px-5 pt-6 pb-4 border-b border-[rgba(60,60,67,0.08)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#ffffff] border border-[rgba(60,60,67,0.08)] shadow-xs flex items-center justify-center p-1.5">
              <DeepSeekLogo size={26} variant="brand" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h2 className="text-[15px] font-bold tracking-tight text-[#000000]">DeepSeek Harness</h2>
              </div>
              <p className="text-[11px] font-medium text-[#8e8e93]">移动遥控伴侣 · 原生端</p>
            </div>
          </div>
          <button
            onClick={onClose}
            type="button"
            className="w-8 h-8 rounded-full bg-[rgba(118,118,128,0.12)] text-[#8e8e93] hover:text-[#000000] flex items-center justify-center transition-colors cursor-pointer ios-spring-tap"
          >
            <X size={16} />
          </button>
        </div>

        {/* 2. Device Status Card (iOS Grouped Inset Card) */}
        <div className="p-4">
          <div
            onClick={onManageHosts}
            className="flex items-center justify-between p-3 rounded-2xl bg-[#ffffff] border border-[rgba(60,60,67,0.08)] shadow-xs hover:bg-[#fafafa] transition-all cursor-pointer ios-spring-tap group"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-[#f2f2f7] flex items-center justify-center text-[#1c1c1e] shrink-0">
                <Monitor size={18} />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-[#000000] truncate">
                  {activeHostName || '我的电脑'}
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-[#8e8e93] mt-0.5">
                  <ConnectionDot status={isHostOnline ? 'online' : 'offline'} size={6} />
                  <span>{isHostOnline ? '远程守护进程在线' : '离线 · 点击连接'}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 text-[#8e8e93]">
              <span className="text-[12px] font-medium text-[#3964fe]">管理</span>
              <ChevronRight size={14} />
            </div>
          </div>
        </div>

        {/* 3. Session Stream (iOS List Style) */}
        <div className="flex-1 overflow-y-auto px-4 pb-2 space-y-1">
          <div className="text-[11px] font-semibold text-[#8e8e93] px-3 py-1.5 uppercase tracking-wider">
            历史会话
          </div>
          {sessions.length === 0 ? (
            <div className="text-center py-10 text-[12px] text-[#8e8e93]">暂无会话记录</div>
          ) : (
            <div className="space-y-1">
              {sessions.map((s) => {
                const isSelected = s.sessionId === currentSessionId;
                return (
                  <div
                    key={s.sessionId}
                    onClick={() => {
                      onSelectSession(s);
                      onClose();
                    }}
                    className={`flex items-start gap-3 p-3 rounded-2xl cursor-pointer transition-all ios-spring-tap ${
                      isSelected
                        ? 'bg-[#3964fe] text-white shadow-sm'
                        : 'hover:bg-[rgba(255,255,255,0.7)] text-[#1c1c1e]'
                    }`}
                  >
                    <MessageSquare
                      size={16}
                      className={`mt-0.5 shrink-0 ${
                        isSelected ? 'text-white' : 'text-[#8e8e93]'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] truncate font-medium">{s.title}</div>
                      {s.workspace && (
                        <div
                          className={`flex items-center gap-1 text-[11px] truncate mt-0.5 font-mono ${
                            isSelected ? 'text-white/80' : 'text-[#8e8e93]'
                          }`}
                        >
                          <Folder size={11} />
                          <span className="truncate">{s.workspace}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 4. Bottom Actions (iOS rounded blur buttons) */}
        <div className="p-4 border-t border-[rgba(60,60,67,0.08)] space-y-2 bg-[rgba(255,255,255,0.6)]">
          <button
            type="button"
            onClick={() => {
              onNewSession();
              onClose();
            }}
            className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-2xl bg-[#000000] hover:bg-[#1c1c1e] text-white text-[13px] font-semibold shadow-xs transition-transform cursor-pointer ios-spring-tap"
          >
            <Plus size={16} />
            <span>新建遥控会话</span>
          </button>

          <button
            type="button"
            onClick={() => {
              onManageHosts();
              onClose();
            }}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-2xl border border-[rgba(60,60,67,0.12)] bg-[#ffffff] text-[#1c1c1e] hover:bg-[#fafafa] text-[12px] font-medium transition-colors cursor-pointer ios-spring-tap"
          >
            <Settings size={15} className="text-[#8e8e93]" />
            <span>电脑配对与网关设置</span>
          </button>
        </div>
      </div>
    </div>
  );
};
