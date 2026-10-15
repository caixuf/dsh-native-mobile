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
    // 🔴 不要在这里 slice：旧实现砍到 14 字（"降级: 主机未响应 session."），
    // 结果**用户永远看不到真正的原因**（排查时我自己也被它挡住过一次）。
    // 宽度交给 CSS 截断，完整原因同时进 title 与顶部横幅。
    label = linkState.reason ? `降级: ${linkState.reason}` : '连接降级';
    dotStatus = 'warning';
  }

  const title =
    linkState.type === 'degraded' && linkState.reason
      ? linkState.reason
      : '点击切换或管理远程主机';

  return (
    <button
      onClick={onClick}
      type="button"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[#141824] hover:bg-[#1a2030] text-[#cbd5e1] hover:text-[#ffffff] transition-all cursor-pointer border border-white/10 shadow-inner studio-tap max-w-[120px] sm:max-w-[180px] shrink-0"
      title={title}
    >
      <ConnectionDot status={dotStatus} size={6} />
      <span className="truncate">{label}</span>
    </button>
  );
};
