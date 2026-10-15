import React from 'react';
import { X, Plus, Settings, MessageSquare, Folder, ChevronRight, Monitor, Sparkles } from 'lucide-react';
import { SessionRow } from '../../types';
import { ConnectionDot } from '../common/ConnectionDot';
import { DeepSeekLogo } from '../common/DeepSeekLogo';
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
      {/* Blurred backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm transition-opacity animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* Studio Drawer sheet */}
      <div className="relative z-50 w-[320px] max-w-[85vw] h-full bg-[#0b0e17]/95 backdrop-blur-2xl border-r border-white/10 shadow-2xl flex flex-col text-[#f8fafc] transition-transform animate-in slide-in-from-left duration-250 ease-out">
        {/* 1. Header with DeepSeek Logo & Title */}
        <div className="flex items-center justify-between px-5 pt-[calc(1.25rem+var(--sat))] pb-4 border-b border-white/[0.08]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-[#1e293b] to-[#0f172a] border border-white/10 shadow-inner flex items-center justify-center p-1.5">
              <DeepSeekLogo size={26} variant="brand" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h2 className="text-[15px] font-bold tracking-tight text-white">DeepSeek Harness</h2>
              </div>
              <p className="text-[11px] font-medium text-[#94a3b8]">移动遥控伴侣 · Studio 极客版</p>
            </div>
          </div>
          <button
            onClick={onClose}
            type="button"
            className="w-8 h-8 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-[#94a3b8] hover:text-white flex items-center justify-center transition-colors cursor-pointer studio-tap"
          >
            <X size={16} />
          </button>
        </div>

        {/* 2. Device Status Card */}
        <div className="p-4">
          <div
            onClick={onManageHosts}
            className="flex items-center justify-between p-3 rounded-2xl specular-card-interactive cursor-pointer group"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-[#1e2538] border border-white/10 flex items-center justify-center text-[#38bdf8] shrink-0">
                <Monitor size={18} />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-white truncate">
                  {activeHostName || '我的电脑'}
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-[#94a3b8] mt-0.5">
                  <ConnectionDot status={isHostOnline ? 'online' : 'offline'} size={6} />
                  <span>{isHostOnline ? '守护进程在线' : '离线 · 点击连接'}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 text-[#64748b] group-hover:text-[#60a5fa]">
              <span className="text-[12px] font-medium text-[#38bdf8]">管理</span>
              <ChevronRight size={14} />
            </div>
          </div>
        </div>

        {/* 3. Session Stream */}
        <div className="flex-1 overflow-y-auto px-4 pb-2 space-y-1">
          <div className="text-[11px] font-semibold text-[#64748b] px-3 py-1.5 uppercase tracking-wider">
            历史会话
          </div>
          {sessions.length === 0 ? (
            <div className="text-center py-10 text-[12px] text-[#64748b]">暂无会话记录</div>
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
                    className={`flex items-start gap-3 p-3 rounded-2xl cursor-pointer transition-all studio-tap ${
                      isSelected
                        ? 'bg-gradient-to-r from-[#2563eb] to-[#3b82f6] text-white shadow-[0_0_15px_rgba(59,130,246,0.35)]'
                        : 'hover:bg-white/[0.06] text-[#cbd5e1] hover:text-white'
                    }`}
                  >
                    <MessageSquare
                      size={16}
                      className={`mt-0.5 shrink-0 ${
                        isSelected ? 'text-white' : 'text-[#64748b]'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] truncate font-medium">{s.title}</div>
                      {s.workspace && (
                        <div
                          className={`flex items-center gap-1 text-[11px] truncate mt-0.5 font-mono ${
                            isSelected ? 'text-white/80' : 'text-[#64748b]'
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

        {/* 4. Bottom Actions */}
        <div className="p-4 pb-[calc(1.25rem+var(--sab))] border-t border-white/[0.08] space-y-2 bg-[#090b12]">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onNewSession();
              onClose();
            }}
            className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white text-[13px] font-semibold shadow-[0_0_20px_rgba(59,130,246,0.35)] transition-transform cursor-pointer studio-tap"
          >
            <Sparkles size={16} />
            <span>新建遥控会话</span>
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('selection');
              onManageHosts();
              onClose();
            }}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border border-white/10 bg-white/[0.04] text-[#cbd5e1] hover:text-white hover:bg-white/[0.08] text-[12px] font-medium transition-colors cursor-pointer studio-tap"
          >
            <Settings size={15} className="text-[#94a3b8]" />
            <span>电脑配对与网关设置</span>
          </button>
        </div>
      </div>
    </div>
  );
};
