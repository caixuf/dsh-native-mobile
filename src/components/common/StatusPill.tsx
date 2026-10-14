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
    label = linkState.hostName ? `${linkState.hostName}` : '主机在线';
    dotStatus = 'online';
  } else if (linkState.type === 'connecting') {
    label = `连接中 (${linkState.attempt || 1})`;
    dotStatus = 'connecting';
  } else if (linkState.type === 'degraded') {
    label = linkState.reason ? `降级: ${linkState.reason.slice(0, 14)}` : '连接降级';
    dotStatus = 'warning';
  }

  return (
    <button
      onClick={onClick}
      type="button"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium bg-[#141824] hover:bg-[#1a2030] text-[#cbd5e1] hover:text-[#ffffff] transition-all cursor-pointer border border-white/10 shadow-inner studio-tap"
      title="点击切换或管理远程主机"
    >
      <ConnectionDot status={dotStatus} size={6} />
      <span className="truncate max-w-[170px]">{label}</span>
    </button>
  );
};
