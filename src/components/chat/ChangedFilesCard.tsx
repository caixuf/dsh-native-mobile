import React, { useState, useMemo } from 'react';
import { FileCode, ChevronDown, ChevronRight, FileText, Check, Copy, X, Download } from 'lucide-react';
import { ChatLine } from '../../types';
import { downloadFile } from '../../utils/downloader';
import { triggerHaptic } from '../../utils/haptics';

import { ChangedFile, extractChangedFiles } from '../../lib/changed-files';
export type { ChangedFile };
export { extractChangedFiles };

export interface ChangedFilesCardProps {
  lines: ChatLine[];
}

export const ChangedFilesCard: React.FC<ChangedFilesCardProps> = ({ lines }) => {
  const [expanded, setExpanded] = useState(false);
  const [inspectingFile, setInspectingFile] = useState<ChangedFile | null>(null);
  const [copied, setCopied] = useState(false);

  const changedFiles = useMemo(() => extractChangedFiles(lines), [lines]);

  if (changedFiles.length === 0) return null;

  const handleCopyDiff = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <div className="my-2.5 rounded-2xl bg-[#f4f4f6] border border-gray-200/80 overflow-hidden shadow-2xs transition-all">
        {/* 卡片头部 */}
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="w-full min-h-[44px] px-3.5 py-2.5 flex items-center justify-between bg-white hover:bg-gray-50 transition-colors cursor-pointer text-left"
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-lg bg-[#f4f4f6] flex items-center justify-center shrink-0 text-blue-600">
              <FileCode size={13} />
            </div>
            <span className="text-[12.5px] font-semibold text-[#18181b] truncate">
              改动文件
            </span>
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono font-medium bg-[#f4f4f6] text-blue-700 border border-blue-200">
              {changedFiles.length} 个
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-[#52525b]">
            <span>{expanded ? '收起' : '展开'}</span>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
        </button>

        {/* 展开的文件列表 */}
        {expanded && (
          <div className="p-2.5 space-y-1.5 border-t border-gray-200/60 bg-[#f4f4f6]">
            {changedFiles.map((file, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-2 rounded-xl bg-white border border-gray-200 transition-all text-[12px]"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1 pr-2">
                  <FileText size={14} className="text-[#52525b] shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[#18181b] truncate leading-tight font-medium">
                      {file.name}
                    </div>
                    <div className="font-mono text-[10px] text-[#52525b] truncate">
                      {file.path}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[9.5px] font-medium uppercase font-mono ${
                      file.action === 'create'
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : 'bg-amber-50 text-amber-700 border border-amber-200'
                    }`}
                  >
                    {file.action === 'create' ? '新增' : '修改'}
                  </span>

                  {file.diff && (
                    <button
                      type="button"
                      onClick={() => setInspectingFile(file)}
                      className="px-2 py-1 min-h-[44px] rounded-lg bg-[#f4f4f6] hover:bg-gray-200 text-[11px] font-medium text-blue-600 border border-gray-200 transition-colors cursor-pointer flex items-center gap-1"
                    >
                      差异
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Diff 检视弹窗 */}
      {inspectingFile && inspectingFile.diff && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pt-[calc(1rem+var(--sat))] pb-[calc(1rem+var(--sab))] bg-black/40 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="w-full max-w-xl max-h-[80vh] flex flex-col rounded-3xl bg-white border border-gray-200 shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="px-4 py-3 flex items-center justify-between border-b border-gray-100 bg-[#f4f4f6]">
              <div className="min-w-0 pr-3">
                <div className="text-[13px] font-bold text-[#18181b] truncate font-mono">
                  {inspectingFile.name}
                </div>
                <div className="text-[10px] text-[#52525b] truncate font-mono mt-0.5">
                  {inspectingFile.path}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={async () => {
                    triggerHaptic('medium');
                    if (!inspectingFile.diff) return;
                    await downloadFile(inspectingFile.diff, `${inspectingFile.name}.patch`, 'text/plain');
                  }}
                  className="w-9 h-9 rounded-full bg-white hover:bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-700 hover:text-black cursor-pointer min-h-[44px]"
                  title="下载补丁文件"
                >
                  <Download size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => handleCopyDiff(inspectingFile.diff || '')}
                  className="w-9 h-9 rounded-full bg-white hover:bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-700 hover:text-black cursor-pointer min-h-[44px]"
                  title="复制改动内容"
                >
                  {copied ? <Check size={15} className="text-emerald-700" /> : <Copy size={15} />}
                </button>
                <button
                  type="button"
                  onClick={() => setInspectingFile(null)}
                  className="w-9 h-9 rounded-full bg-white hover:bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-700 hover:text-black cursor-pointer min-h-[44px]"
                  title="关闭"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Diff 内容区 */}
            <div className="flex-1 overflow-y-auto p-3 font-mono text-[11.5px] leading-relaxed bg-[#f8f9fa]">
              <pre className="whitespace-pre-wrap break-all">
                {inspectingFile.diff.split('\n').map((line, i) => {
                  const isAdd = line.startsWith('+');
                  const isDel = line.startsWith('-');
                  return (
                    <div
                      key={i}
                      className={`px-2 py-0.5 rounded ${
                        isAdd
                          ? 'bg-emerald-50 text-emerald-800'
                          : isDel
                          ? 'bg-rose-50 text-rose-800'
                          : 'text-gray-600'
                      }`}
                    >
                      {line}
                    </div>
                  );
                })}
              </pre>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
