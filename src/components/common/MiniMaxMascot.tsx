import React from 'react';
import { DeepSeekMascot } from './DeepSeekMascot';

export { DeepSeekMascot };

/**
 * 兼容层导出：原 MiniMax 吉祥物已全面升级为 DeepSeek 官方蓝鲸吉祥物。
 */
export const MiniMaxMascot: React.FC<{
  size?: number;
  className?: string;
  variant?: 'blue' | 'light';
}> = (props) => {
  return <DeepSeekMascot {...props} />;
};

export default DeepSeekMascot;
