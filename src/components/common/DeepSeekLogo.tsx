import React from 'react';

interface Props {
  size?: number;
  className?: string;
  variant?: 'brand' | 'white' | 'dark';
}

/**
 * DeepSeek Official Whale Vector Logo
 * Precise bezier vector representation of the DeepSeek whale mark.
 */
export const DeepSeekLogo: React.FC<Props> = ({
  size = 24,
  className = '',
  variant = 'brand',
}) => {
  const fillColor =
    variant === 'brand'
      ? '#3964fe'
      : variant === 'white'
      ? '#ffffff'
      : '#151517';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="DeepSeek Logo"
    >
      {/* DeepSeek leaping whale path */}
      <path
        d="M87.2 28.5C82.1 22.8 74.4 18.2 65.8 17.5C53.6 16.5 40.8 22.3 32.7 30.6C26.1 37.3 22.5 46.1 21.8 55.4C21.4 60.5 22.5 65.5 25.1 69.8C27.9 74.5 32.4 78.1 37.6 79.8C42.8 81.5 48.7 81.3 53.8 79.2C59.2 77 63.6 72.8 66.8 67.8C68.9 64.5 70.3 60.7 71.1 56.8C71.8 53.4 71.9 49.8 71.3 46.4C70.6 42.4 68.8 38.6 66.2 35.5C64.1 33.1 61.3 31.3 58.2 30.3C54.4 29.1 50.2 29.3 46.6 30.8C42.8 32.4 39.7 35.3 37.7 39C36.1 42 35.4 45.4 35.7 48.8C36 52.3 37.3 55.5 39.6 58C42 60.5 45.3 62 48.7 62.3C52.1 62.6 55.5 61.5 58.2 59.4C60.8 57.3 62.4 54.3 62.9 51C63.2 49 63 46.9 62.2 45C61.4 43.1 59.9 41.5 58.1 40.6C56.3 39.7 54.2 39.5 52.2 40C50.2 40.5 48.5 41.7 47.4 43.4C46.6 44.6 46.2 46.1 46.3 47.6C46.4 49.1 47.1 50.4 48.2 51.3C49.3 52.2 50.7 52.6 52.1 52.4C53.5 52.2 54.7 51.4 55.4 50.2C55.7 49.7 55.8 49.1 55.7 48.5C55.6 47.9 55.3 47.4 54.8 47C54.3 46.6 53.7 46.4 53.1 46.5C52.5 46.6 52 47 51.7 47.5"
        stroke={fillColor}
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Whale fluked tail accent */}
      <path
        d="M86.8 28.2C89.5 25.2 92.8 21.6 92.5 17.5C92.2 13.5 88.5 11 84.8 11.2C81.2 11.4 78.5 14.5 77.2 17.8C76.2 20.3 76.5 22.8 77.8 25"
        stroke={fillColor}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Eye dot */}
      <circle cx="34" cy="53" r="3.2" fill={fillColor} />
    </svg>
  );
};
