import React, { useState } from 'react';
import { triggerHaptic } from '../../utils/haptics';

interface Props {
  size?: number;
  className?: string;
  variant?: 'blue' | 'light' | 'theme';
  state?: 'idle' | 'thinking' | 'happy' | 'winking';
  interactive?: boolean;
}

/**
 * 灵动吉祥物组件（对齐 MiniMax 官方灵动发光水母/小章鱼造型，支持多表情与轻触微交互）。
 */
export const DeepSeekMascot: React.FC<Props> = ({
  size = 72,
  className = '',
  state = 'idle',
  interactive = true,
}) => {
  const [internalState, setInternalState] = useState<'idle' | 'thinking' | 'happy' | 'winking'>(state);

  const handleClick = () => {
    if (!interactive) return;
    triggerHaptic('light');
    const states: ('idle' | 'thinking' | 'happy' | 'winking')[] = ['idle', 'happy', 'winking', 'thinking'];
    const next = states[(states.indexOf(internalState) + 1) % states.length];
    setInternalState(next);
  };

  const currentState = state !== 'idle' ? state : internalState;

  return (
    <div
      style={{ width: size, height: size }}
      onClick={handleClick}
      className={`relative inline-flex items-center justify-center select-none cursor-pointer transition-transform duration-300 hover:scale-105 active:scale-95 ${className}`}
      title="轻触吉祥物变换表情"
    >
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full drop-shadow-[0_8px_20px_rgba(12,127,242,0.28)] transition-all duration-300"
      >
        <defs>
          <linearGradient id="minimax-mascot-grad" x1="50" y1="10" x2="50" y2="90" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#67e8f9" />
            <stop offset="35%" stopColor="#38bdf8" />
            <stop offset="70%" stopColor="#0c7ff2" />
            <stop offset="100%" stopColor="#0066ff" />
          </linearGradient>

          <linearGradient id="minimax-highlight" x1="30" y1="20" x2="60" y2="50" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.65" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* 顶部可爱左右小耳朵/触角 */}
        <ellipse cx="23" cy="28" rx="5" ry="3.5" transform="rotate(-25 23 28)" fill="#38bdf8" />
        <ellipse cx="77" cy="28" rx="5" ry="3.5" transform="rotate(25 77 28)" fill="#38bdf8" />

        {/* 主体圆润水母/小包子身躯与底部的萌动小脚触手 */}
        <path
          d="
            M 24 45
            C 24 22, 76 22, 76 45
            C 77 58, 77 64, 75 70
            C 73 72, 70 77, 67 75
            C 64 73, 63 68, 59 70
            C 56 72, 54 77, 50 76
            C 46 77, 44 72, 41 70
            C 37 68, 36 73, 33 75
            C 30 77, 27 72, 25 70
            C 23 64, 23 58, 24 45
            Z
          "
          fill="url(#minimax-mascot-grad)"
        />

        {/* 顶部柔和弧形高光 */}
        <ellipse cx="44" cy="36" rx="18" ry="11" fill="url(#minimax-highlight)" />

        {/* 萌动表情系统 */}
        {currentState === 'idle' && (
          <g>
            {/* 灵动双眼 */}
            <circle cx="41" cy="48" r="3.2" fill="#0f172a" />
            <circle cx="42" cy="47" r="1.1" fill="#ffffff" />
            <circle cx="59" cy="48" r="3.2" fill="#0f172a" />
            <circle cx="60" cy="47" r="1.1" fill="#ffffff" />
            {/* 温暖微笑 */}
            <path d="M 47 54 Q 50 57 53 54" stroke="#0f172a" strokeWidth="1.8" strokeLinecap="round" />
          </g>
        )}

        {currentState === 'happy' && (
          <g>
            {/* 开心弯弯月牙眼 */}
            <path d="M 37 49 Q 41 44 45 49" stroke="#0f172a" strokeWidth="2.2" strokeLinecap="round" />
            <path d="M 55 49 Q 59 44 63 49" stroke="#0f172a" strokeWidth="2.2" strokeLinecap="round" />
            {/* 开心大微笑 */}
            <path d="M 46 53 Q 50 59 54 53" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" fill="none" />
            {/* 可爱粉色腮红 */}
            <circle cx="34" cy="52" r="3.2" fill="#f43f5e" opacity="0.45" />
            <circle cx="66" cy="52" r="3.2" fill="#f43f5e" opacity="0.45" />
          </g>
        )}

        {currentState === 'winking' && (
          <g>
            {/* 眨眼 + 睁眼 */}
            <path d="M 37 48 Q 41 44 45 48" stroke="#0f172a" strokeWidth="2.2" strokeLinecap="round" />
            <circle cx="59" cy="48" r="3.2" fill="#0f172a" />
            <circle cx="60" cy="47" r="1.1" fill="#ffffff" />
            <path d="M 47 54 Q 50 58 53 54" stroke="#0f172a" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="35" cy="52" r="2.8" fill="#f43f5e" opacity="0.4" />
          </g>
        )}

        {currentState === 'thinking' && (
          <g>
            {/* 往上看眼神 */}
            <circle cx="41" cy="46" r="3.2" fill="#0f172a" />
            <circle cx="41" cy="44.8" r="1.1" fill="#ffffff" />
            <circle cx="59" cy="46" r="3.2" fill="#0f172a" />
            <circle cx="59" cy="44.8" r="1.1" fill="#ffffff" />
            {/* 呆萌小圆嘴 */}
            <circle cx="50" cy="55" r="2.2" fill="#0f172a" />
          </g>
        )}
      </svg>
    </div>
  );
};

export default DeepSeekMascot;
