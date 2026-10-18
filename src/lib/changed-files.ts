import type { ChatLine } from '../types';

export interface ChangedFile {
  path: string;
  name: string;
  action: 'create' | 'modify' | 'delete';
  diff?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

/**
 * 从会话工具调用中归约出本轮/历史改动的文件
 */
export function extractChangedFiles(lines: ChatLine[]): ChangedFile[] {
  const fileMap = new Map<string, ChangedFile>();

  for (const line of lines) {
    if (line.kind !== 'tool/call' && line.kind !== 'tool/result') continue;
    const toolName = (line.toolName || '').toLowerCase();

    // 匹配修改/创建文件的工具
    const isWrite = /write_to_file|create_file|writefile|new_file/.test(toolName);
    const isEdit = /replace_file_content|multi_replace_file_content|edit|patch|apply_diff/.test(toolName);
    if (!isWrite && !isEdit) continue;

    let targetPath = '';
    let diffContent = '';

    if (line.toolArgs) {
      try {
        const args = JSON.parse(line.toolArgs);
        targetPath = args.TargetFile || args.targetFile || args.path || args.filePath || args.target_file || '';

        if (args.ReplacementContent || args.replacementContent) {
          diffContent = `+ ${args.ReplacementContent || args.replacementContent}`;
        } else if (args.ReplacementChunks && Array.isArray(args.ReplacementChunks)) {
          diffContent = args.ReplacementChunks.map((c: { TargetContent?: string; ReplacementContent?: string }) =>
            `- ${c.TargetContent || ''}\n+ ${c.ReplacementContent || ''}`
          ).join('\n');
        } else if (args.CodeContent || args.codeContent) {
          diffContent = `+ ${args.CodeContent || args.codeContent}`;
        }
      } catch {
        // 尝试从字符串中提取路径
        const pathMatch = line.toolArgs.match(/["'](?:TargetFile|path|filePath)["']\s*:\s*["']([^"']+)["']/i);
        if (pathMatch) targetPath = pathMatch[1];
      }
    }

    if (!targetPath && line.text) {
      const pathMatch = line.text.match(/(?:file:\/\/\/|[a-zA-Z]:[\\/]|^\/)[^\s:;"']+/);
      if (pathMatch) targetPath = pathMatch[0];
    }

    if (!targetPath) continue;

    const normalizedPath = targetPath.replace(/\\/g, '/');
    const name = normalizedPath.split('/').pop() || targetPath;

    const existing = fileMap.get(normalizedPath);
    fileMap.set(normalizedPath, {
      path: targetPath,
      name,
      action: isWrite ? 'create' : 'modify',
      diff: diffContent || existing?.diff,
    });
  }

  return Array.from(fileMap.values());
}
