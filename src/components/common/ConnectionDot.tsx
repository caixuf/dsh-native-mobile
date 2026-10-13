import React from 'react';

interface Props {
  status: 'online' | 'offline' | 'connecting' | 'warning';
  size?: number;
  pulse?: boolean;
}

export const ConnectionDot: React.FC<Props> = ({ status, size = 8, pulse = true }) => {
  const colorMap = {
    online: 'bg-[#22c55e]',
    offline: 'bg-[#717182]',
    connecting: 'bg-[#0060df]',
    warning: 'bg-[#e09900]',
  };

  const ringMap = {
    online: 'ring-[#22c55e]/30',
    offline: 'ring-[#717182]/20',
    connecting: 'ring-[#0060df]/30',
    warning: 'ring-[#e09900]/30',
  };

  return (
    <span className="relative flex items-center justify-center">
      {pulse && (status === 'online' || status === 'connecting') && (
        <span
          className={`absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping ${colorMap[status]}`}
          style={{ width: size + 4, height: size + 4 }}
        />
      )}
      <span
        className={`relative inline-block rounded-full ring-2 ${ringMap[status]} ${colorMap[status]}`}
        style={{ width: size, height: size }}
      />
    </span>
  );
};
