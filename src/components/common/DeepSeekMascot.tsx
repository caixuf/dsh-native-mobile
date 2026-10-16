import React from 'react';

interface Props {
  size?: number;
  className?: string;
  variant?: 'blue' | 'light';
}

/**
 * DeepSeek 官方经典蓝鲸吉祥物组件。
 * 呈现灵动优美的科技蓝鲸轮廓、智能气孔微光与双色微渐变，对齐 DeepSeek 品牌视觉。
 */
export const DeepSeekMascot: React.FC<Props> = ({ size = 64, className = '', variant = 'blue' }) => {
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
        className="w-full h-full drop-shadow-[0_8px_16px_rgba(77,107,254,0.28)]"
      >
        <defs>
          <linearGradient id="deepseek-body-grad" x1="15" y1="15" x2="85" y2="85" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="35%" stopColor="#4d6bfe" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </linearGradient>

          <linearGradient id="deepseek-belly-grad" x1="25" y1="50" x2="65" y2="80" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#e0f2fe" stopOpacity="0.65" />
          </linearGradient>
        </defs>

        {/* 顶部呼吸孔喷出灵动 AI 智能水滴 / 能量光点 */}
        <circle cx="36" cy="18" r="4.5" fill="#38bdf8" />
        <circle cx="46" cy="13" r="3" fill="#60a5fa" />
        <path
          d="M 33 24 Q 35 20 36 18 Q 38 21 38 24 Z"
          fill="#38bdf8"
        />

        {/* 蓝鲸尾鳍 (向后上方舒展) */}
        <path
          d="M 68 52 C 76 46 86 38 90 32 C 88 44 82 52 87 58 C 81 55 75 56 68 56 Z"
          fill="url(#deepseek-body-grad)"
        />

        {/* 蓝鲸圆润身躯 (大头、饱满线条、流畅向后收尾) */}
        <path
          d="M 12 52 C 12 34 26 24 45 24 C 64 24 74 38 78 52 C 80 58 76 66 70 70 C 60 76 42 76 28 73 C 18 70 12 62 12 52 Z"
          fill="url(#deepseek-body-grad)"
        />

        {/* 蓝鲸浅色腹部弧度 */}
        <path
          d="M 22 58 C 28 69 44 73 60 70 C 58 66 52 62 42 62 C 32 62 25 59 22 58 Z"
          fill="url(#deepseek-belly-grad)"
        />

        {/* 侧面可爱的小胸鳍 */}
        <path
          d="M 40 56 C 46 56 53 62 50 68 C 45 68 40 64 38 58 Z"
          fill="#2563eb"
        />

        {/* 蓝鲸温和微笑的眼睛与高光点 */}
        <circle cx="27" cy="46" r="3.8" fill="#0f172a" />
        <circle cx="28.5" cy="44.5" r="1.5" fill="#ffffff" />

        {/* 微微上翘的微笑弧线 */}
        <path
          d="M 17 55 Q 21 59 26 57"
          stroke="#1e3a8a"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
};

export default DeepSeekMascot;
