import React, { useState } from 'react';
import { X, Download, Share2, Copy, Check, ZoomIn, ZoomOut, RotateCcw, FileText, Code2 } from 'lucide-react';
import { downloadFile, shareFileIfSupported } from '../../utils/downloader';
import { triggerHaptic } from '../../utils/haptics';

// ── 1. 全屏图片沉浸式画廊与下载模态框 ──────────────────────────────────────────

interface ImageViewerModalProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export const ImageViewerModal: React.FC<ImageViewerModalProps> = ({ src, alt, onClose }) => {
  const [scale, setScale] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const handleZoomIn = () => {
    triggerHaptic('light');
    setScale((prev) => Math.min(prev + 0.5, 4));
  };

  const handleZoomOut = () => {
    triggerHaptic('light');
    setScale((prev) => Math.max(prev - 0.5, 0.5));
  };

  const handleResetZoom = () => {
    triggerHaptic('light');
    setScale(1);
  };

  const handleDownload = async () => {
    triggerHaptic('medium');
    setDownloading(true);
    const fileName = (alt?.trim() ? alt.trim() : 'image') + (alt?.includes('.') ? '' : '.png');
    const ok = await downloadFile(src, fileName, 'image/png');
    setDownloading(false);
    if (ok) {
      triggerHaptic('success');
      showToast('图片已保存到本地');
    } else {
      showToast('保存失败，请稍后重试');
    }
  };

  const handleShare = async () => {
    triggerHaptic('light');
    const fileName = (alt?.trim() ? alt.trim() : 'image') + (alt?.includes('.') ? '' : '.png');
    const shared = await shareFileIfSupported(src, fileName, 'image/png');
    if (!shared) {
      void handleDownload();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-md select-none animate-in fade-in duration-200">
      {/* 顶栏控制条 */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/60 border-b border-white/10 shrink-0 text-white z-10">
        <div className="min-w-0 flex-1 pr-3">
          <span className="block text-sm font-medium text-gray-200 truncate">
            {alt || '图片预览'}
          </span>
          <span className="text-[11px] text-gray-400 font-mono">
            缩放: {Math.round(scale * 100)}%
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleZoomOut}
            aria-label="缩小图片"
            className="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center text-gray-300 hover:text-white transition-colors cursor-pointer"
            title="缩小"
          >
            <ZoomOut size={18} />
          </button>
          <button
            type="button"
            onClick={handleZoomIn}
            aria-label="放大图片"
            className="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center text-gray-300 hover:text-white transition-colors cursor-pointer"
            title="放大"
          >
            <ZoomIn size={18} />
          </button>
          {scale !== 1 && (
            <button
              type="button"
              onClick={handleResetZoom}
              aria-label="重置缩放"
              className="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center text-gray-300 hover:text-white transition-colors cursor-pointer"
              title="重置"
            >
              <RotateCcw size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={handleShare}
            aria-label="分享图片"
            className="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center text-gray-300 hover:text-white transition-colors cursor-pointer"
            title="分享"
          >
            <Share2 size={18} />
          </button>
          <button
            type="button"
            onClick={handleDownload}
            aria-label="下载保存图片"
            disabled={downloading}
            className="w-10 h-10 rounded-full bg-blue-600 hover:bg-blue-700 flex items-center justify-center text-white transition-colors shadow-md cursor-pointer disabled:opacity-50"
            title="下载到手机"
          >
            <Download size={18} />
          </button>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onClose();
            }}
            aria-label="关闭预览"
            className="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center text-gray-300 hover:text-white transition-colors cursor-pointer ml-1"
            title="关闭"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* 提示气泡 */}
      {toast && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 px-4 py-2 rounded-xl bg-gray-900/95 border border-white/20 text-white text-xs shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2">
          {toast}
        </div>
      )}

      {/* 图片主视口：支持双指与缩放 */}
      <div
        className="flex-1 flex items-center justify-center p-4 overflow-auto overscroll-none"
        onClick={() => {
          if (scale > 1) handleResetZoom();
        }}
      >
        <img
          src={src}
          alt={alt || '大图预览'}
          style={{ transform: `scale(${scale})`, transition: 'transform 0.15s ease-out' }}
          className="max-h-[85vh] max-w-[95vw] object-contain rounded-lg shadow-2xl select-none"
          draggable={false}
        />
      </div>
    </div>
  );
};

// ── 2. 代码 / 文档文件全文预览与下载模态框 ────────────────────────────────────

interface FileViewerModalProps {
  fileName: string;
  content: string;
  fileSize?: number;
  mimeType?: string;
  onClose: () => void;
}

export const FileViewerModal: React.FC<FileViewerModalProps> = ({
  fileName,
  content,
  fileSize,
  mimeType = 'text/plain',
  onClose,
}) => {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      triggerHaptic('success');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      showToast('已复制文件全文到剪贴板');
    } catch {
      showToast('复制失败');
    }
  };

  const handleDownload = async () => {
    triggerHaptic('medium');
    setDownloading(true);
    const ok = await downloadFile(content, fileName, mimeType);
    setDownloading(false);
    if (ok) {
      triggerHaptic('success');
      showToast(`已下载 ${fileName}`);
    } else {
      showToast('下载失败');
    }
  };

  const handleShare = async () => {
    triggerHaptic('light');
    const shared = await shareFileIfSupported(content, fileName, mimeType);
    if (!shared) {
      void handleDownload();
    }
  };

  const lines = content.split('\n');
  const sizeText = fileSize
    ? (fileSize / 1024).toFixed(1) + ' KB'
    : (new Blob([content]).size / 1024).toFixed(1) + ' KB';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="flex-1 flex flex-col max-w-3xl w-full mx-auto bg-[#18181f] text-white shadow-2xl sm:rounded-2xl sm:my-6 overflow-hidden border border-white/10">
        {/* 顶部标题与操作栏 */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#1e1f26] border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0 flex-1 pr-2">
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center shrink-0">
              {fileName.endsWith('.py') || fileName.endsWith('.ts') || fileName.endsWith('.js') ? (
                <Code2 size={18} />
              ) : (
                <FileText size={18} />
              )}
            </div>
            <div className="min-w-0">
              <span className="block text-sm font-semibold text-gray-100 truncate">{fileName}</span>
              <span className="text-[11px] text-gray-400 font-mono">
                {lines.length} 行 · {sizeText}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={handleCopy}
              aria-label="复制代码全文"
              className="px-2.5 py-1.5 rounded-lg hover:bg-white/10 text-gray-300 hover:text-white text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
            <button
              type="button"
              onClick={handleShare}
              aria-label="分享文件"
              className="p-2 rounded-lg hover:bg-white/10 text-gray-300 hover:text-white transition-colors cursor-pointer"
              title="分享"
            >
              <Share2 size={16} />
            </button>
            <button
              type="button"
              onClick={handleDownload}
              aria-label="下载文件"
              disabled={downloading}
              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium flex items-center gap-1.5 transition-colors shadow-sm cursor-pointer disabled:opacity-50"
              title="下载保存到手机"
            >
              <Download size={14} />
              <span>下载</span>
            </button>
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onClose();
              }}
              aria-label="关闭文件预览"
              className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors cursor-pointer ml-1"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* 提示消息 */}
        {toast && (
          <div className="bg-blue-600 text-white text-center py-1.5 px-3 text-xs font-medium animate-in fade-in">
            {toast}
          </div>
        )}

        {/* 代码/正文浏览区 */}
        <div className="flex-1 overflow-auto p-3 text-[13px] font-mono leading-relaxed bg-[#141418] select-text">
          <pre className="m-0">
            <code>
              {lines.map((line, idx) => (
                <div key={idx} className="flex hover:bg-white/5 py-0.5">
                  <span className="w-12 shrink-0 select-none text-right pr-4 text-gray-600 font-mono text-xs">
                    {idx + 1}
                  </span>
                  <span className="flex-1 whitespace-pre-wrap break-all text-gray-200">
                    {line || ' '}
                  </span>
                </div>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
};
