import React from 'react';

interface Props {
  size?: number;
  className?: string;
  variant?: 'blue' | 'light';
}

/**
 * MiniMax 经典水母吉祥物组件（1:1 还原截图中的拟人化蓝色水母）。
 */
export const MiniMaxMascot: React.FC<Props> = ({ size = 64, className = '', variant = 'blue' }) => {
  return (
    <div
      style={{ width: size, height: size }}
      className={`relative inline-flex items-center justify-center select-none ${className}`}
    >
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full drop-shadow-[0_8px_16px_rgba(56,189,248,0.25)]"
      >
        <defs>
          <linearGradient id="minimax-gradient" x1="20" y1="10" x2="80" y2="90" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="60%" stopColor="#2563eb" />
            <stop offset="100%" stopColor="#60a5fa" />
          </linearGradient>
          <radialGradient id="highlight" cx="35%" cy="30%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* 顶部两只可爱的小耳朵/触手角 */}
        <ellipse cx="25" cy="24" rx="8" ry="6" fill="url(#minimax-gradient)" transform="rotate(-15 25 24)" />
        <ellipse cx="75" cy="24" rx="8" ry="6" fill="url(#minimax-gradient)" transform="rotate(15 75 24)" />

        {/* 水母主体圆润身体 */}
        <path
          d="M 20 50 C 20 28 32 18 50 18 C 68 18 80 28 80 50 C 80 62 76 72 70 75 C 65 77 62 72 58 75 C 54 78 52 82 50 82 C 48 82 46 78 42 75 C 38 72 35 77 30 75 C 24 72 20 62 20 50 Z"
          fill="url(#minimax-gradient)"
        />

        {/* 表面柔和高光 */}
        <path
          d="M 22 48 C 22 30 33 21 50 21 C 67 21 78 30 78 48 C 70 32 45 28 22 48 Z"
          fill="url(#highlight)"
        />

        {/* 底部裙边触手小凸起 */}
        <circle cx="28" cy="74" r="5" fill="#38bdf8" />
        <circle cx="42" cy="77" r="5.5" fill="#2563eb" />
        <circle cx="58" cy="77" r="5.5" fill="#2563eb" />
        <circle cx="72" cy="74" r="5" fill="#38bdf8" />
      </svg>
    </div>
  );
};

export default MiniMaxMascot;
