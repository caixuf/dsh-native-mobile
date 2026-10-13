import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Terminal, FileText, CheckCircle2, AlertCircle, Wrench } from 'lucide-react';

interface Props {
  toolName?: string | null;
  toolArgs?: string | null;
  toolResult?: string | null;
  isError?: boolean;
}

export const DisclosureToolCard: React.FC<Props> = ({
  toolName = '工具',
  toolArgs,
  toolResult,
  isError = false,
}) => {
  const [expanded, setExpanded] = useState(false);

  const getToolIcon = () => {
    switch (toolName) {
      case 'run_command':
      case 'bash':
      case 'terminal':
        return <Terminal size={14} className="text-[#8b5cf6]" />;
      case 'read_file':
      case 'edit_file':
      case 'write_file':
        return <FileText size={14} className="text-[#8b5cf6]" />;
      default:
        return <Wrench size={14} className="text-[#8b5cf6]" />;
    }
  };

  const getFriendlyName = () => {
    switch (toolName) {
      case 'run_command':
        return '执行终端命令';
      case 'read_file':
        return '读取文件内容';
      case 'edit_file':
        return '修改文件代码';
      case 'write_file':
        return '写入新文件';
      case 'list_dir':
        return '列出目录结构';
      default:
        return toolName || '工具调用';
    }
  };

  // Extract concise snippet for preview
  const getArgSnippet = () => {
    if (!toolArgs) return '';
    try {
      const parsed = JSON.parse(toolArgs);
      if (parsed.command) return parsed.command;
      if (parsed.path) return parsed.path;
      if (parsed.query) return parsed.query;
      return JSON.stringify(parsed);
    } catch {
      return toolArgs.slice(0, 60);
    }
  };

  return (
    <div className="my-1.5 rounded-xl border border-[#e5e5e5] bg-[#ffffff] overflow-hidden text-xs transition-all shadow-2xs">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-[#fafafa] select-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1 rounded-md bg-[#f5f3ff] border border-[#ede9fe]">
            {getToolIcon()}
          </div>
          <span className="font-semibold text-[#151517]">{getFriendlyName()}</span>
          {getArgSnippet() && (
            <span className="text-[#717182] font-mono truncate max-w-[220px]">
              {getArgSnippet()}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {toolResult ? (
            isError ? (
              <span className="flex items-center gap-1 text-[#e31937] text-[11px] font-medium bg-[#feedee] px-1.5 py-0.5 rounded">
                <AlertCircle size={12} />
                失败
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[#22c55e] text-[11px] font-medium bg-[#eefdf3] px-1.5 py-0.5 rounded">
                <CheckCircle2 size={12} />
                完成
              </span>
            )
          ) : (
            <span className="text-[#0060df] text-[11px] font-medium bg-[#e5f5ff] px-1.5 py-0.5 rounded animate-pulse">
              执行中…
            </span>
          )}
          {expanded ? (
            <ChevronDown size={14} className="text-[#717182]" />
          ) : (
            <ChevronRight size={14} className="text-[#717182]" />
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-[#f1f3f5] bg-[#fafafa] space-y-2 text-[12px] font-mono">
          {toolArgs && (
            <div>
              <div className="text-[11px] font-sans font-medium text-[#717182] mb-1">入参 (Arguments):</div>
              <pre className="p-2 rounded-lg bg-[#ffffff] border border-[#e5e5e5] text-[#151517] overflow-x-auto text-[11.5px] leading-relaxed max-h-48 whitespace-pre-wrap break-all">
                {toolArgs}
              </pre>
            </div>
          )}

          {toolResult && (
            <div>
              <div className="text-[11px] font-sans font-medium text-[#717182] mb-1">执行结果 (Output):</div>
              <pre
                className={`p-2 rounded-lg border text-[11.5px] leading-relaxed overflow-x-auto max-h-48 whitespace-pre-wrap break-all ${
                  isError
                    ? 'bg-[#feedee] border-[#fecdd3] text-[#e31937]'
                    : 'bg-[#ffffff] border-[#e5e5e5] text-[#151517]'
                }`}
              >
                {toolResult}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
