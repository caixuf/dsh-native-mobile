/**
 * 会话记录导出为 Markdown 纯文本工具。
 * 纯函数 + 下载/分享桥接，支持 Node 端单测。
 */

import type { ChatLine } from '../types';

export interface ExportSessionMeta {
  sessionId: string;
  title: string;
  workspace?: string | null;
  hostName?: string;
}

/**
 * 将当前会话的所有消息流格式化为清晰规范的 Markdown 文本。
 */
export function formatSessionToMarkdown(meta: ExportSessionMeta, lines: ChatLine[]): string {
  const parts: string[] = [];

  // 头部元信息
  parts.push(`# ${meta.title || 'DSH 会话记录'}\n`);
  parts.push(`> **会话 ID**：\`${meta.sessionId}\`  `);
  if (meta.workspace) {
    parts.push(`> **工作区**：\`${meta.workspace}\`  `);
  }
  if (meta.hostName) {
    parts.push(`> **远程主机**：\`${meta.hostName}\`  `);
  }
  parts.push(`> **导出时间**：${new Date().toLocaleString('zh-CN')}  \n`);
  parts.push('---\n');

  if (!lines || lines.length === 0) {
    parts.push('_（该会话暂无消息记录）_\n');
    return parts.join('\n');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.role === 'user') {
      parts.push(`### 👤 用户 (User)\n`);
      if (line.text) {
        parts.push(line.text + '\n');
      }
      if (line.imageRefs && line.imageRefs.length > 0) {
        parts.push(`\n_[附带 ${line.imageRefs.length} 张图片附件]_\n`);
      }
      parts.push('\n---\n');
    } else if (line.role === 'assistant') {
      parts.push(`### 🤖 助手 (Assistant)\n`);
      if (line.text) {
        parts.push(line.text + '\n');
      }
      parts.push('\n---\n');
    } else if (line.kind === 'tool/call') {
      const toolName = line.toolName || '未知工具';
      const args = line.toolArgs ? `\`\`\`json\n${line.toolArgs}\n\`\`\`` : '';
      parts.push(`<details>\n<summary>🛠️ <b>工具调用</b>: <code>${toolName}</code></summary>\n\n${args}\n</details>\n`);
    } else if (line.kind === 'tool/result') {
      const ms = typeof line.toolMs === 'number' ? ` (${line.toolMs}ms)` : '';
      const result = line.toolResult ? `\`\`\`\n${line.toolResult.slice(0, 1000)}${line.toolResult.length > 1000 ? '\n... (已截断)' : ''}\n\`\`\`` : '_（无返回）_';
      parts.push(`<details>\n<summary>⚙️ <b>执行结果</b>${ms}</summary>\n\n${result}\n</details>\n`);
    } else if (line.injectedLabel) {
      parts.push(`> 📌 _[系统注入: ${line.injectedLabel}]_\n`);
    }
  }

  parts.push('\n\n_由 DSH Remote 移动遥控伴侣导出_');
  return parts.join('\n');
}

/**
 * 生成合法的文件名（替换非法字符）。
 */
export function sanitizeFilename(name: string, fallback = 'session-export'): string {
  const sanitized = name.replace(/[/\\?%*:|"<>]/g, '_').trim();
  return (sanitized.slice(0, 40) || fallback) + '.md';
}

/**
 * 触发文件下载或原生分享（环境安全防护，支持 Node 降级）。
 */
export async function exportMarkdownFile(
  filename: string,
  content: string,
): Promise<{ shared: boolean; downloaded: boolean }> {
  if (typeof window === 'undefined') {
    return { shared: false, downloaded: false };
  }

  // 1. 优先尝试 Web Share API（移动设备唤起系统分享面板）
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (nav && typeof nav.share === 'function') {
    try {
      const file = new File([content], filename, { type: 'text/markdown;charset=utf-8' });
      if (typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
        await nav.share({
          files: [file],
          title: filename,
        });
        return { shared: true, downloaded: false };
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
        return { shared: false, downloaded: false };
      }
      // 降级走下载
    }
  }

  // 2. 浏览器标准 Blob 下载
  if (typeof document !== 'undefined') {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { shared: false, downloaded: true };
  }

  return { shared: false, downloaded: false };
}
