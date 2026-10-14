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
        return <Terminal size={14} className="text-[#c084fc]" />;
      case 'read_file':
      case 'edit_file':
      case 'write_file':
        return <FileText size={14} className="text-[#38bdf8]" />;
      default:
        return <Wrench size={14} className="text-[#a78bfa]" />;
    }
  };

  const getFriendlyName = () => {
    switch (toolName) {
      case 'run_command':
        return '执行命令';
      case 'read_file':
        return '读取文件';
      case 'edit_file':
        return '修改文件';
      case 'write_file':
        return '写入文件';
      case 'list_dir':
        return '列出目录';
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
    <div className="my-2 rounded-2xl specular-card overflow-hidden text-xs transition-all border border-white/10 shadow-lg">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-3.5 py-2.5 cursor-pointer bg-[#131724]/80 hover:bg-[#1a2030] transition-colors select-none"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-1.5 rounded-lg bg-[#a855f7]/15 border border-[#a855f7]/25 flex items-center justify-center">
            {getToolIcon()}
          </div>
          <span className="font-semibold text-white tracking-wide">{getFriendlyName()}</span>
          {getArgSnippet() && (
            <span className="text-[#94a3b8] font-mono truncate max-w-[220px] bg-white/[0.04] px-2 py-0.5 rounded border border-white/[0.06]">
              {getArgSnippet()}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-2">
          {toolResult ? (
            isError ? (
              <span className="flex items-center gap-1 text-[#fb7185] text-[11px] font-medium bg-[#f43f5e]/15 px-2 py-0.5 rounded-full border border-[#f43f5e]/30">
                <AlertCircle size={12} />
                失败
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[#34d399] text-[11px] font-medium bg-[#10b981]/15 px-2 py-0.5 rounded-full border border-[#10b981]/30">
                <CheckCircle2 size={12} />
                完成
              </span>
            )
          ) : (
            <span className="text-[#38bdf8] text-[11px] font-medium bg-[#38bdf8]/15 px-2 py-0.5 rounded-full border border-[#38bdf8]/30 animate-pulse">
              执行中…
            </span>
          )}
          <div className="text-[#64748b] hover:text-white transition-colors">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-3.5 pb-3.5 pt-2 border-t border-white/[0.06] bg-[#0c0f17] space-y-2.5 text-[12px] font-mono">
          {toolArgs && (
            <div>
              <div className="text-[11px] font-sans font-medium text-[#94a3b8] mb-1">入参 (Arguments):</div>
              <pre className="p-2.5 rounded-xl bg-[#07090e] border border-white/10 text-[#38bdf8] overflow-x-auto text-[11.5px] leading-relaxed max-h-48 whitespace-pre-wrap break-all shadow-inner">
                {toolArgs}
              </pre>
            </div>
          )}

          {toolResult && (
            <div>
              <div className="text-[11px] font-sans font-medium text-[#94a3b8] mb-1">执行结果 (Output):</div>
              <pre
                className={`p-2.5 rounded-xl border text-[11.5px] leading-relaxed overflow-x-auto max-h-48 whitespace-pre-wrap break-all shadow-inner ${
                  isError
                    ? 'bg-[#1f0d14] border-[#f43f5e]/40 text-[#fda4af]'
                    : 'bg-[#07090e] border-white/10 text-[#e2e8f0]'
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
