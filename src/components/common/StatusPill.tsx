import React from 'react';
import { ConnectionDot } from './ConnectionDot';
import { LinkState } from '../../types';

interface Props {
  linkState: LinkState;
  onClick?: () => void;
}

export const StatusPill: React.FC<Props> = ({ linkState, onClick }) => {
  let label = '未连接';
  let dotStatus: 'online' | 'offline' | 'connecting' | 'warning' = 'offline';

  if (linkState.type === 'ready') {
    label = linkState.hostName ? `${linkState.hostName} · 在线` : '在线就绪';
    dotStatus = 'online';
  } else if (linkState.type === 'connecting') {
    label = `连接中 (${linkState.attempt || 1})`;
    dotStatus = 'connecting';
  } else if (linkState.type === 'degraded') {
    label = linkState.reason ? `连接降级: ${linkState.reason.slice(0, 14)}` : '连接降级';
    dotStatus = 'warning';
  }

  return (
    <button
      onClick={onClick}
      type="button"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[#ffffff] hover:bg-[#f2f2f7] text-[#1c1c1e] transition-colors cursor-pointer border border-[rgba(60,60,67,0.12)] shadow-2xs ios-spring-tap"
      title="点击切换或管理电脑"
    >
      <ConnectionDot status={dotStatus} size={6} />
      <span className="truncate max-w-[170px]">{label}</span>
    </button>
  );
};
